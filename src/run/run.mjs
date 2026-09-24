// @ts-check
// switchyard run の本体(設計 §4.3)。割り振りを待ち、子を別グループで起動し、心拍と終了をデーモンへ返す。
import { constants as osConstants } from 'node:os';
import { basename } from 'node:path';
import { UsageError } from '../cli/args.mjs';
import { channel, connectDaemon, DaemonUnavailableError } from '../client/connect.mjs';
import { sessionId } from '../client/session.mjs';
import { heldLocks, repoRoot } from '../config/context.mjs';
import { applyTemplate, classifiableCommand, classify, loadProfiles } from '../config/profiles.mjs';
import { pathsOf } from '../daemon/paths.mjs';
import { appendRecord } from '../daemon/store.mjs';
import { readPgid, renicePriority, signalGroup, spawnMeasured, verifiedGroup, waitGroupGone } from './group.mjs';
import { createEscapeTracker, nextWatchMs } from './watch.mjs';
import { t } from '../i18n.mjs';

/** @typedef {import('../core/types.mjs').JobClass} JobClass */
/** @typedef {import('../core/types.mjs').CpuRange} CpuRange */
/** @typedef {import('../core/types.mjs').Preempt} Preempt */
/** @typedef {import('../protocol/messages.mjs').JobRequest} JobRequest */
/** @typedef {import('../config/profiles.mjs').Profile} Profile */
/** @typedef {import('./watch.mjs').EscapeReport} EscapeReport */
/** @typedef {{ profile?: string, why?: string, class?: JobClass, cpus?: CpuRange, locks?: string[], preempt?: Preempt }} RunFlags */
/** @typedef {{ on: (sig: NodeJS.Signals, h: () => void) => unknown, off: (sig: NodeJS.Signals, h: () => void) => unknown }} SignalSource */

/**
 * @typedef {{
 *   argv: string[],
 *   flags: RunFlags,
 *   home: string,
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   out?: (line: string) => void,
 *   heartbeatMs?: number,
 *   killGraceMs?: number,
 *   reconnectMs?: number,
 *   unmanagedAfterMs?: number,
 *   watchMs?: number,
 *   maxWatchMs?: number,
 *   throttleNice?: number,
 *   connect?: typeof connectDaemon,
 *   signals?: SignalSource,
 *   verifyGroup?: typeof verifiedGroup
 * }} RunOptions
 */

const CALLER_SIGNALS = /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP']);

// 既存の呼び出し元とテストのために、ここからも読めるようにしておく
export { heldLocks, repoRoot };

/** @param {NodeJS.Signals | null} sig @returns {number} */
function signalCode(sig) {
  return 128 + (sig === null ? 0 : osConstants.signals[sig] ?? 0);
}

/**
 * ジョブの宣言を組み立てる。--profile の指定 → コマンドの分類 → 既定、の順に性格を決め、引数で上書きする。鍵は足し合わせる。
 * 入れ子(設計 §4.3 の 7): 祖先が持つ鍵は外す。CPU を持つジョブの中(SWITCHYARD_IN_JOB=1)では CPU を 0..0 にする
 * (親が CPU を持っているので二重に数えない。数えると、容量いっぱいのときに親子が互いを待つ)。
 * @param {{ argv: string[], flags: RunFlags, env: NodeJS.ProcessEnv, cwd: string }} input
 * @returns {{ job: JobRequest, profile: Profile | null, configError: string | null, configNotice: string | null }}
 */
export function buildRequest({ argv, flags, env, cwd }) {
  const repo = repoRoot(cwd);
  const { profiles, error, notice } = loadProfiles(repo);
  const cmd = argv.join(' ');
  const named = flags.profile !== undefined ? profiles.find((p) => p.name === flags.profile) ?? null : classify(classifiableCommand(argv), profiles);
  if (flags.profile !== undefined && named === null) throw new Error(t(`profile ${flags.profile} が見つからない`, `profile ${flags.profile} not found`));
  const base = named === null ? null : named.profile;
  const held = heldLocks(env);
  const declaredLocks = [...new Set([...(base?.locks ?? []), ...(flags.locks ?? [])])];
  // 鍵だけのジョブ(--cpus 0..0)に鍵が 1 本も無いのは使い方の誤り。--profile の鍵はここで初めて分かるので、CLI の検査の続きをここで行う。
  // これで、デーモンに要求せずに走らせるのは、入れ子で祖先の鍵を外して何も残らなかったときだけになる(設計 §4.3 の 7)
  if (flags.cpus?.max === 0 && declaredLocks.length === 0) {
    throw new UsageError(
      t(
        `--cpus 0..0(鍵だけのジョブ)には鍵が 1 本以上要る(--lock も、profile ${flags.profile ?? '(指定なし)'} の locks も無い)`,
        `--cpus 0..0 (a locks-only job) needs at least one lock (no --lock, and profile ${flags.profile ?? '(none)'} has no locks)`,
      ),
    );
  }
  // 鍵だけのジョブの子(祖先の鍵があり、CPU を持つジョブの中ではない)は、親のジョブの id を載せる。
  // 規則層が親のリースの実在を確かめてから先に入れ、容量を超えて借りさせる(設計 §4.3 の 7・§6.2・§6.3 の 4)
  const parent = held.size > 0 && env.SWITCHYARD_IN_JOB !== '1' && env.SWITCHYARD_JOB_ID ? env.SWITCHYARD_JOB_ID : null;
  return {
    job: {
      session: sessionId(env),
      repo,
      // shim は本物のパスで起動するので、先頭の語は basename にする(パスごとに見込みが分かれないように。設計 §5.4)
      profile: named === null ? `cmd:${[basename(argv[0]), ...argv.slice(1, 2)].join(' ')}` : named.name,
      cmd,
      class: flags.class ?? base?.class ?? 'batch',
      cpus: env.SWITCHYARD_IN_JOB === '1' ? { min: 0, max: 0 } : flags.cpus ?? base?.cpus ?? { min: 1, max: 1 },
      locks: declaredLocks.filter((k) => !held.has(k)),
      // 既定は never。宣言していないジョブは、計測のために止められない(設計 §6.7)。
      // 止める / 降格するのは、そのジョブが中断に耐えると書いた人だけ
      preempt: flags.preempt ?? base?.preempt ?? 'never',
      why: flags.why ?? null,
      ...(parent !== null ? { parent } : {}),
    },
    profile: base,
    configError: error,
    configNotice: notice ?? null,
  };
}

/**
 * グループから抜けた子と、終了後も生きている子を 1 行ずつ表示する文言。どちらも無ければ空。
 * @param {EscapeReport} r @returns {string[]}
 */
export function escapeLines(r) {
  /** @type {string[]} */
  const lines = [];
  if (r.escaped.length > 0) {
    const list = r.escaped.map((e) => `${e.comm} ×${e.count}`).join(', ');
    lines.push(t(`[switchyard] プロセスグループから抜けた子: ${list}(信号と使用率の照合が届かない)`, `[switchyard] children that left the process group: ${list} (signals and CPU accounting do not reach them)`));
  }
  if (r.survivors.length > 0) {
    lines.push(
      t(
        `[switchyard] 終了後も生きている子: ${r.survivors.map((x) => `${x.comm}(pid ${x.pid}・${x.inGroup ? 'グループ内' : 'グループ外'})`).join(', ')}`,
        `[switchyard] children still alive after exit: ${r.survivors.map((x) => `${x.comm} (pid ${x.pid}, ${x.inGroup ? 'in group' : 'outside group'})`).join(', ')}`,
      ),
    );
  }
  return lines;
}

/** @param {number} wall */
const clock = (wall) => new Date(wall).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

/**
 * @param {RunOptions} opts @returns {Promise<number>} 子の終了コード(信号で終わったら 128 + 番号)
 */
export function runJob(opts) {
  const {
    argv,
    flags,
    home,
    env = process.env,
    cwd = process.cwd(),
    out = (line) => process.stderr.write(`${line}\n`),
    heartbeatMs = 10_000,
    killGraceMs = 5_000,
    reconnectMs = 1_000,
    unmanagedAfterMs = 30_000,
    watchMs = 2_000,
    maxWatchMs = 30_000,
    throttleNice = 10,
    connect = connectDaemon,
    signals = process,
    verifyGroup = verifiedGroup,
  } = opts;
  const { job, profile, configError, configNotice } = buildRequest({ argv, flags, env, cwd });
  if (configError !== null) out(t(`[switchyard] ${configError}(既定表で続ける)`, `[switchyard] ${configError} (continuing with the built-in table)`));
  if (configNotice !== null) out(`[switchyard] ${configNotice}`);
  const ownPgid = readPgid(process.pid);

  return new Promise((resolve) => {
    /** @type {'waiting' | 'running' | 'done'} */
    let phase = 'waiting';
    /** @type {string | null} */
    let jobId = null;
    /** @type {ReturnType<typeof channel> | null} */
    let ch = null;
    /** @type {import('node:child_process').ChildProcess | null} */
    let child = null;
    /** @type {() => number | null} sh の下で走る、コマンドそのものの pid(グループを確かめられないとき、信号を直に送る先) */
    let commandPid = () => null;
    /** グループを確かめられないとき: sh(TERM を子へ送り直す)とコマンドそのものへ送る @param {NodeJS.Signals} sig */
    const signalDirect = (sig) => {
      const p = commandPid();
      if (p !== null) {
        try {
          process.kill(p, sig);
        } catch {
          // 既に居ない
        }
      }
      child?.kill(sig);
    };
    /** @type {number | null} */
    let pgid = null;
    let childStartedAt = 0;
    let killedByCaller = false;
    /** デーモンの管理の外で走った(届かなかった・見失われた)。終わったら控える(設計 §4.3 の 8) */
    let unmanaged = false;
    let lastNote = '';
    let finished = false;
    /** @type {NodeJS.Timeout | null} */
    let hbTimer = null;
    /** @type {NodeJS.Timeout | null} */
    let killTimer = null;
    /** @type {NodeJS.Timeout | null} 再接続の待ち(終わったら消して、プロセスの終了を遅らせない) */
    let backoffTimer = null;
    /** @type {ReturnType<typeof createEscapeTracker> | null} */
    let tracker = null;
    /** @type {NodeJS.Timeout | null} */
    let watchTimer = null;
    /** @type {'pause' | 'throttle' | null} 計測に道を譲って止めている / 降格している(設計 §6.7) */
    let held = null;
    // await を挟んだ後の読み取りを型の絞り込みに巻き込まないよう、関数越しに読む
    const over = () => finished || phase === 'done';

    /**
     * 止めた子を必ず動かし直してから次へ進む。
     * SIGSTOP で止まったプロセスは SIGTERM を受け取っても処理できないので、終わらせる前にここを通す。
     */
    const release = () => {
      if (held === null) return;
      const was = held;
      held = null;
      if (pgid === null) return;
      if (was === 'pause') signalGroup(pgid, 'SIGCONT', ownPgid);
      else renicePriority(pgid, 0);
    };

    const handlers = CALLER_SIGNALS.map((sig) => {
      const h = () => onSignal(sig);
      signals.on(sig, h);
      return /** @type {const} */ ([sig, h]);
    });

    /** @param {number} code */
    const finish = (code) => {
      if (finished) return;
      finished = true;
      release();
      if (hbTimer !== null) clearInterval(hbTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (backoffTimer !== null) clearTimeout(backoffTimer);
      if (watchTimer !== null) clearTimeout(watchTimer);
      for (const [sig, h] of handlers) signals.off(sig, h);
      ch?.close();
      resolve(code);
    };

    /** @param {number} code @param {EscapeReport | null} escape @param {number | null} [cpuMs] 子と子孫の CPU 時間 */
    const report = (code, escape, cpuMs = null) => {
      if (phase === 'done') return;
      phase = 'done';
      if (killTimer !== null) clearTimeout(killTimer);
      if (escape !== null) for (const line of escapeLines(escape)) out(line);
      if (unmanaged) {
        // デーモンの次の起動で取り込まれ、失敗なら持ち主の Stop に出る(設計 §4.2)
        try {
          appendRecord(pathsOf(home).unmanaged, { at: Date.now(), session: job.session, repo: job.repo, profile: job.profile, cmd: job.cmd, code, durationMs: Date.now() - childStartedAt });
        } catch (e) {
          out(t(`[switchyard] 管理なしの走行を控えられない: ${e instanceof Error ? e.message : String(e)}`, `[switchyard] cannot record the unmanaged run: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      const summary = escape === null ? null : { escaped: escape.escaped, survivors: escape.survivors };
      if (ch !== null && jobId !== null && !ch.isClosed()) {
        ch.onMessage((m) => {
          if (m.t === 'ok') finish(code);
        });
        ch.send({ t: 'exit', jobId, code, killedByCaller, durationMs: Date.now() - childStartedAt, escape: summary, cpuMs });
        setTimeout(() => finish(code), 1_000).unref();
      } else {
        finish(code);
      }
    };

    /** @param {number} cpus @param {boolean} managed */
    const startChild = (cpus, managed) => {
      if (finished) return;
      phase = 'running';
      const tpl = profile === null ? { env: {}, args: [] } : applyTemplate(profile, cpus);
      childStartedAt = Date.now();
      /** @type {NodeJS.ProcessEnv} */
      const childEnv = { ...env, ...tpl.env, SWITCHYARD_CPUS: String(cpus) };
      if (jobId !== null) childEnv.SWITCHYARD_JOB_ID = jobId;
      // デーモンに要求せずに走らせる子(入れ子で直接・管理なし)に、祖先のジョブの id を自分の id として渡さない
      else delete childEnv.SWITCHYARD_JOB_ID;
      // 入れ子の印(設計 §4.3 の 7): CPU を持つジョブの子だけに立てる(鍵だけのジョブの子は、中の重い走行を別に管理させる)
      if (cpus > 0) childEnv.SWITCHYARD_IN_JOB = '1';
      childEnv.SWITCHYARD_HELD_LOCKS = [...new Set([...heldLocks(env), ...job.locks])].join(',');
      const measured = spawnMeasured([...argv, ...tpl.args], { env: childEnv, cwd });
      const c = measured.child;
      child = c;
      commandPid = measured.commandPid;
      // 子と子孫の CPU 時間。終わってから times の出力が届くまで少しかかるので、長くは待たない
      const cpuOf = () => Promise.race([measured.cpuMs, new Promise((r) => setTimeout(() => r(null), 500))]);
      c.once('error', (e) => {
        out(t(`[switchyard] 起動できない: ${e.message}`, `[switchyard] cannot start: ${e.message}`));
        report(127, null);
      });
      c.once('exit', (code, sig) => {
        const result = code ?? signalCode(sig);
        if (watchTimer !== null) clearTimeout(watchTimer);
        tracker?.sample();
        const done = () => {
          void cpuOf().then((cpuMs) => report(result, tracker === null ? null : tracker.report(), /** @type {number | null} */ (cpuMs)));
        };
        if (!killedByCaller || pgid === null) {
          done();
          return;
        }
        // 呼び出し元の信号を転送した後に生まれた子には SIGTERM が届いていない。
        // グループへ送り直し、猶予の間に空にならなければ SIGKILL してから終了を返す
        const target = pgid;
        signalGroup(target, 'SIGTERM', ownPgid);
        void waitGroupGone(target, killGraceMs).then((gone) => {
          if (!gone) signalGroup(target, 'SIGKILL', ownPgid);
          done();
        });
      });
      if (c.pid === undefined) return;
      pgid = verifyGroup(c.pid, ownPgid);
      if (pgid === null) {
        out(
          t(
            '[switchyard] 子のプロセスグループを確かめられないので、グループへの信号は送らない(呼び出し元の終了だけを子に伝える)',
            "[switchyard] cannot confirm the child's process group, so no signal goes to the group (only the caller's exit is passed to the child)",
          ),
        );
      } else {
        // どのコマンドでも、子孫がグループから抜けるかを実行中に見る(設計 §13 V6)。
        // 顔ぶれが変わらない間は間隔を倍にして伸ばす(ps は 1 回が安くない。watch.mjs の nextWatchMs)
        const tr = createEscapeTracker({ rootPid: c.pid, pgid });
        tracker = tr;
        tr.sample();
        let everyMs = watchMs;
        const again = () => {
          watchTimer = setTimeout(() => {
            everyMs = nextWatchMs(everyMs, tr.sample(), watchMs, maxWatchMs);
            again();
          }, everyMs);
        };
        again();
      }
      if (managed && ch !== null && jobId !== null) {
        ch.send({ t: 'started', jobId, pid: c.pid, pgid });
        hbTimer = setInterval(() => {
          if (ch !== null && jobId !== null) ch.send({ t: 'hb', jobId });
        }, heartbeatMs);
      }
    };

    /** @param {NodeJS.Signals} sig */
    function onSignal(sig) {
      killedByCaller = true;
      // 止まっている子は信号を処理できない。転送の前に必ず動かし直す
      release();
      if (phase === 'waiting') {
        out(t(`[switchyard] ${sig} を受けたので待つのをやめる`, `[switchyard] got ${sig}, giving up the wait`));
        phase = 'done';
        finish(signalCode(sig));
        return;
      }
      if (phase !== 'running' || child === null) return;
      if (killTimer !== null) {
        // 既に猶予のタイマーが動いている: 送り直すのは SIGTERM だけで、タイマーは残す
        // (設計 §4.3 の 5 = 猶予は最初の転送から killGraceMs。信号を受けるたびに始まり直さない)
        if (pgid === null) signalDirect('SIGTERM');
        else signalGroup(pgid, 'SIGTERM', ownPgid);
        return;
      }
      if (pgid === null) {
        // グループを確かめられないので、呼び出し元の終了だけを子の pid へ伝える(グループへは送らない)。
        // 相手は自分で起動した子そのものなので、猶予の後に生きていれば SIGKILL へ格上げしてよい
        const c = child;
        signalDirect('SIGTERM');
        killTimer = setTimeout(() => {
          if (c.exitCode === null && c.signalCode === null) signalDirect('SIGKILL');
        }, killGraceMs);
        return;
      }
      signalGroup(pgid, 'SIGTERM', ownPgid);
      const target = pgid;
      killTimer = setTimeout(() => signalGroup(target, 'SIGKILL', ownPgid), killGraceMs);
    }

    /** @param {import('node:net').Socket} conn @returns {ReturnType<typeof channel>} */
    const attach = (conn) => {
      const c = channel(conn);
      ch = c;
      c.onMessage((m) => {
        if (m.t === 'accepted') {
          jobId = String(m.jobId);
        } else if (m.t === 'queued' && phase === 'waiting') {
          const eta = typeof m.etaWall === 'number' ? t(`(見込み ${clock(m.etaWall)})`, ` (expected ${clock(m.etaWall)})`) : '';
          const line = t(`[switchyard] 待機 ${String(m.position)} 番目: ${String(m.reason)}${eta}`, `[switchyard] waiting, #${String(m.position)}: ${String(m.reason)}${eta}`);
          if (line !== lastNote) out(line);
          lastNote = line;
        } else if (m.t === 'grant' && phase === 'waiting') {
          out(t(`[switchyard] 開始 ${jobId}(CPU ${String(m.cpus)})`, `[switchyard] started ${jobId} (CPU ${String(m.cpus)})`));
          startChild(Number(m.cpus), true);
        } else if (m.t === 'hold' && phase === 'running' && pgid !== null) {
          const mode = m.mode === 'pause' ? 'pause' : 'throttle';
          if (held === null) {
            held = mode;
            if (mode === 'pause') {
              signalGroup(pgid, 'SIGSTOP', ownPgid);
              out(t('[switchyard] 計測に道を譲るため止まる(SIGSTOP)。計測が終われば動き出す', '[switchyard] pausing (SIGSTOP) to make way for a measurement; resumes when it ends'));
            } else {
              renicePriority(pgid, throttleNice);
              out(t(`[switchyard] 計測に道を譲るため優先度を下げる(nice ${throttleNice})`, `[switchyard] lowering priority (nice ${throttleNice}) to make way for a measurement`));
            }
          }
        } else if (m.t === 'unhold') {
          if (held !== null) {
            release();
            out(t('[switchyard] 走行に戻る', '[switchyard] back to running'));
          }
        } else if (m.t === 'unknown') {
          if (phase === 'waiting') {
            jobId = null;
            c.send({ t: 'request', job });
          } else if (phase === 'running') {
            out(t('[switchyard] デーモンがこのジョブを知らないので、管理なしで走り続ける', '[switchyard] the daemon does not know this job; it keeps running unmanaged'));
            unmanaged = true;
            if (hbTimer !== null) clearInterval(hbTimer);
            ch = null;
            c.close();
          }
        } else if (m.t === 'error' && phase === 'waiting') {
          // 待っている間のエラーは要求が受け付けられなかったということ。待ち続けると永遠に終わらないので、
          // 作業を止めずに管理なしで実行し、控える(設計 §10・§4.3 の 8)
          out(t(`[switchyard] デーモンが要求を受け付けない(${String(m.message)})ので、管理なしで実行する`, `[switchyard] the daemon refused the request (${String(m.message)}); running unmanaged`));
          unmanaged = true;
          ch = null;
          c.close();
          startChild(job.cpus.min, false);
        } else if (m.t === 'error') {
          out(t(`[switchyard] デーモンのエラー: ${String(m.message)}`, `[switchyard] daemon error: ${String(m.message)}`));
        }
      });
      c.onClose(() => {
        if (!over() && ch === c) void reconnect();
      });
      return c;
    };

    const reconnect = async () => {
      out(t('[switchyard] デーモンとの接続が切れた。つなぎ直す', '[switchyard] lost the daemon connection; reconnecting'));
      if (hbTimer !== null) clearInterval(hbTimer);
      ch = null;
      const lostAt = Date.now();
      let wait = reconnectMs;
      while (!over()) {
        try {
          const conn = await connect({ home, env, timeoutMs: reconnectMs });
          if (over()) {
            conn.destroy();
            return;
          }
          const c = attach(conn);
          if (jobId === null) {
            c.send({ t: 'request', job });
          } else {
            c.send({ t: 'resume', jobId, phase, pid: child?.pid ?? null, pgid });
            if (phase === 'running') {
              hbTimer = setInterval(() => {
                if (ch !== null && jobId !== null) ch.send({ t: 'hb', jobId });
              }, heartbeatMs);
            }
          }
          out(t('[switchyard] つなぎ直した', '[switchyard] reconnected'));
          return;
        } catch {
          if (phase === 'waiting' && Date.now() - lostAt > unmanagedAfterMs) {
            out(t(`[switchyard] ${unmanagedAfterMs}ms つなげないので、管理なしで実行する(二重貸し防止などの保証なし)`, `[switchyard] no connection for ${unmanagedAfterMs}ms; running unmanaged (no guarantee against double allocation)`));
            unmanaged = true;
            startChild(job.cpus.min, false);
            return;
          }
          await new Promise((r) => {
            backoffTimer = setTimeout(r, wait);
          });
          backoffTimer = null;
          wait = Math.min(wait * 2, 30_000);
        }
      }
    };

    if (job.cpus.max === 0 && job.locks.length === 0) {
      // 入れ子で CPU も鍵も要らなくなった: デーモンに要求を出さず、そのまま走らせる(設計 §4.3 の 7)
      startChild(0, false);
      return;
    }

    connect({ home, env })
      .then((conn) => {
        if (over()) {
          conn.destroy();
          return;
        }
        attach(conn);
        ch?.send({ t: 'request', job });
      })
      .catch((e) => {
        if (over()) return;
        if (!(e instanceof DaemonUnavailableError)) throw e;
        out(
          t(
            `[switchyard] デーモンに届かないので、管理なしで実行する(二重貸し防止などの保証なし・CPU は宣言の最小 ${job.cpus.min}): ${e.message}`,
            `[switchyard] cannot reach the daemon; running unmanaged (no guarantee against double allocation, CPU at the declared minimum ${job.cpus.min}): ${e.message}`,
          ),
        );
        unmanaged = true;
        startChild(job.cpus.min, false);
      });
  });
}
