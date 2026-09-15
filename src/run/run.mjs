// @ts-check
// conductor run の本体(設計 §4.3)。割り振りを待ち、子を別グループで起動し、心拍と終了をデーモンへ返す。
import { constants as osConstants } from 'node:os';
import { basename } from 'node:path';
import { channel, connectDaemon, DaemonUnavailableError } from '../client/connect.mjs';
import { sessionId } from '../client/session.mjs';
import { heldLocks, repoRoot } from '../config/context.mjs';
import { applyTemplate, classify, loadProfiles } from '../config/profiles.mjs';
import { readPgid, signalGroup, spawnInOwnGroup, verifiedGroup, waitGroupGone } from './group.mjs';
import { createEscapeTracker } from './watch.mjs';

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
 * 入れ子(設計 §4.3 の 7): 祖先が持つ鍵は外す。CPU を持つジョブの中(CONDUCTOR_IN_JOB=1)では CPU を 0..0 にする
 * (親が CPU を持っているので二重に数えない。数えると、容量いっぱいのときに親子が互いを待つ)。
 * @param {{ argv: string[], flags: RunFlags, env: NodeJS.ProcessEnv, cwd: string }} input
 * @returns {{ job: JobRequest, profile: Profile | null, configError: string | null }}
 */
export function buildRequest({ argv, flags, env, cwd }) {
  const repo = repoRoot(cwd);
  const { profiles, error } = loadProfiles(repo);
  const cmd = argv.join(' ');
  const named = flags.profile !== undefined ? profiles.find((p) => p.name === flags.profile) ?? null : classify(cmd, profiles);
  if (flags.profile !== undefined && named === null) throw new Error(`profile ${flags.profile} が見つからない`);
  const base = named === null ? null : named.profile;
  const held = heldLocks(env);
  return {
    job: {
      session: sessionId(env),
      repo,
      // shim は本物のパスで起動するので、先頭の語は basename にする(パスごとに見込みが分かれないように。設計 §5.4)
      profile: named === null ? `cmd:${[basename(argv[0]), ...argv.slice(1, 2)].join(' ')}` : named.name,
      cmd,
      class: flags.class ?? base?.class ?? 'batch',
      cpus: env.CONDUCTOR_IN_JOB === '1' ? { min: 0, max: 0 } : flags.cpus ?? base?.cpus ?? { min: 1, max: 1 },
      locks: [...new Set([...(base?.locks ?? []), ...(flags.locks ?? [])])].filter((k) => !held.has(k)),
      preempt: flags.preempt ?? base?.preempt ?? 'throttle',
      why: flags.why ?? null,
    },
    profile: base,
    configError: error,
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
    lines.push(`[conductor] プロセスグループから抜けた子: ${r.escaped.map((e) => `${e.comm} ×${e.count}`).join(', ')}(信号と使用率の照合が届かない)`);
  }
  if (r.survivors.length > 0) {
    lines.push(`[conductor] 終了後も生きている子: ${r.survivors.map((x) => `${x.comm}(pid ${x.pid}・${x.inGroup ? 'グループ内' : 'グループ外'})`).join(', ')}`);
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
    connect = connectDaemon,
    signals = process,
    verifyGroup = verifiedGroup,
  } = opts;
  const { job, profile, configError } = buildRequest({ argv, flags, env, cwd });
  if (configError !== null) out(`[conductor] ${configError}(既定表で続ける)`);
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
    /** @type {number | null} */
    let pgid = null;
    let childStartedAt = 0;
    let killedByCaller = false;
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
    // await を挟んだ後の読み取りを型の絞り込みに巻き込まないよう、関数越しに読む
    const over = () => finished || phase === 'done';

    const handlers = CALLER_SIGNALS.map((sig) => {
      const h = () => onSignal(sig);
      signals.on(sig, h);
      return /** @type {const} */ ([sig, h]);
    });

    /** @param {number} code */
    const finish = (code) => {
      if (finished) return;
      finished = true;
      if (hbTimer !== null) clearInterval(hbTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      if (backoffTimer !== null) clearTimeout(backoffTimer);
      if (watchTimer !== null) clearInterval(watchTimer);
      for (const [sig, h] of handlers) signals.off(sig, h);
      ch?.close();
      resolve(code);
    };

    /** @param {number} code @param {EscapeReport | null} escape */
    const report = (code, escape) => {
      if (phase === 'done') return;
      phase = 'done';
      if (killTimer !== null) clearTimeout(killTimer);
      if (escape !== null) for (const line of escapeLines(escape)) out(line);
      const summary = escape === null ? null : { escaped: escape.escaped, survivors: escape.survivors };
      if (ch !== null && jobId !== null && !ch.isClosed()) {
        ch.onMessage((m) => {
          if (m.t === 'ok') finish(code);
        });
        ch.send({ t: 'exit', jobId, code, killedByCaller, durationMs: Date.now() - childStartedAt, escape: summary });
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
      const childEnv = { ...env, ...tpl.env, CONDUCTOR_CPUS: String(cpus) };
      if (jobId !== null) childEnv.CONDUCTOR_JOB_ID = jobId;
      // 入れ子の印(設計 §4.3 の 7): CPU を持つジョブの子だけに立てる(鍵だけのジョブの子は、中の重い走行を別に管理させる)
      if (cpus > 0) childEnv.CONDUCTOR_IN_JOB = '1';
      childEnv.CONDUCTOR_HELD_LOCKS = [...new Set([...heldLocks(env), ...job.locks])].join(',');
      const c = spawnInOwnGroup([...argv, ...tpl.args], { env: childEnv, cwd, stdio: 'inherit' });
      child = c;
      c.once('error', (e) => {
        out(`[conductor] 起動できない: ${e.message}`);
        report(127, null);
      });
      c.once('exit', (code, sig) => {
        const result = code ?? signalCode(sig);
        if (watchTimer !== null) clearInterval(watchTimer);
        tracker?.sample();
        const done = () => report(result, tracker === null ? null : tracker.report());
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
        out('[conductor] 子のプロセスグループを確かめられないので、グループへの信号は送らない(呼び出し元の終了だけを子に伝える)');
      } else {
        // どのコマンドでも、子孫がグループから抜けるかを実行中に見る(設計 §13 V6)
        const tr = createEscapeTracker({ rootPid: c.pid, pgid });
        tracker = tr;
        tr.sample();
        watchTimer = setInterval(() => tr.sample(), watchMs);
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
      if (phase === 'waiting') {
        out(`[conductor] ${sig} を受けたので待つのをやめる`);
        phase = 'done';
        finish(signalCode(sig));
        return;
      }
      if (phase !== 'running' || child === null) return;
      if (killTimer !== null) {
        // 既に猶予のタイマーが動いている: 送り直すのは SIGTERM だけで、タイマーは残す
        // (設計 §4.3 の 5 = 猶予は最初の転送から killGraceMs。信号を受けるたびに始まり直さない)
        if (pgid === null) child.kill('SIGTERM');
        else signalGroup(pgid, 'SIGTERM', ownPgid);
        return;
      }
      if (pgid === null) {
        // グループを確かめられないので、呼び出し元の終了だけを子の pid へ伝える(グループへは送らない)。
        // 相手は自分で起動した子そのものなので、猶予の後に生きていれば SIGKILL へ格上げしてよい
        const c = child;
        c.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
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
          const eta = typeof m.etaWall === 'number' ? `(見込み ${clock(m.etaWall)})` : '';
          const line = `[conductor] 待機 ${String(m.position)} 番目: ${String(m.reason)}${eta}`;
          if (line !== lastNote) out(line);
          lastNote = line;
        } else if (m.t === 'grant' && phase === 'waiting') {
          out(`[conductor] 開始 ${jobId}(CPU ${String(m.cpus)})`);
          startChild(Number(m.cpus), true);
        } else if (m.t === 'unknown') {
          if (phase === 'waiting') {
            jobId = null;
            c.send({ t: 'request', job });
          } else if (phase === 'running') {
            out('[conductor] デーモンがこのジョブを知らないので、管理なしで走り続ける');
            if (hbTimer !== null) clearInterval(hbTimer);
            ch = null;
            c.close();
          }
        } else if (m.t === 'error') {
          out(`[conductor] デーモンのエラー: ${String(m.message)}`);
        }
      });
      c.onClose(() => {
        if (!over() && ch === c) void reconnect();
      });
      return c;
    };

    const reconnect = async () => {
      out('[conductor] デーモンとの接続が切れた。つなぎ直す');
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
          out('[conductor] つなぎ直した');
          return;
        } catch {
          if (phase === 'waiting' && Date.now() - lostAt > unmanagedAfterMs) {
            out(`[conductor] ${unmanagedAfterMs}ms つなげないので、管理なしで実行する(二重貸し防止などの保証なし)`);
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
        out(`[conductor] デーモンに届かないので、管理なしで実行する(二重貸し防止などの保証なし・CPU は宣言の最小 ${job.cpus.min}): ${e.message}`);
        startChild(job.cpus.min, false);
      });
  });
}
