// @ts-check
// conductor run の本体(設計 §4.3)。割り振りを待ち、子を別グループで起動し、心拍と終了をデーモンへ返す。
import { execFileSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { channel, connectDaemon, DaemonUnavailableError } from '../client/connect.mjs';
import { sessionId } from '../client/session.mjs';
import { applyTemplate, classify, loadProfiles } from '../config/profiles.mjs';
import { readPgid, signalGroup, spawnInOwnGroup, verifiedGroup, waitGroupGone } from './group.mjs';

/** @typedef {import('../core/types.mjs').JobClass} JobClass */
/** @typedef {import('../core/types.mjs').CpuRange} CpuRange */
/** @typedef {import('../core/types.mjs').Preempt} Preempt */
/** @typedef {import('../protocol/messages.mjs').JobRequest} JobRequest */
/** @typedef {import('../config/profiles.mjs').Profile} Profile */
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
 *   connect?: typeof connectDaemon,
 *   signals?: SignalSource
 * }} RunOptions
 */

const CALLER_SIGNALS = /** @type {const} */ (['SIGTERM', 'SIGINT', 'SIGHUP']);

/** @param {string} cwd @returns {string} */
export function repoRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return cwd;
  }
}

/** @param {NodeJS.Signals | null} sig @returns {number} */
function signalCode(sig) {
  return 128 + (sig === null ? 0 : osConstants.signals[sig] ?? 0);
}

/**
 * ジョブの宣言を組み立てる。--profile の指定 → コマンドの分類 → 既定、の順に性格を決め、引数で上書きする。鍵は足し合わせる。
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
  return {
    job: {
      session: sessionId(env),
      repo,
      profile: named === null ? `cmd:${argv.slice(0, 2).join(' ')}` : named.name,
      cmd,
      class: flags.class ?? base?.class ?? 'batch',
      cpus: flags.cpus ?? base?.cpus ?? { min: 1, max: 1 },
      locks: [...new Set([...(base?.locks ?? []), ...(flags.locks ?? [])])],
      preempt: flags.preempt ?? base?.preempt ?? 'throttle',
      why: flags.why ?? null,
    },
    profile: base,
    configError: error,
  };
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
    connect = connectDaemon,
    signals = process,
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
      for (const [sig, h] of handlers) signals.off(sig, h);
      ch?.close();
      resolve(code);
    };

    /** @param {number} code */
    const report = (code) => {
      if (phase === 'done') return;
      phase = 'done';
      if (killTimer !== null) clearTimeout(killTimer);
      if (ch !== null && jobId !== null && !ch.isClosed()) {
        ch.onMessage((m) => {
          if (m.t === 'ok') finish(code);
        });
        ch.send({ t: 'exit', jobId, code, killedByCaller, durationMs: Date.now() - childStartedAt });
        setTimeout(() => finish(code), 1_000).unref();
      } else {
        finish(code);
      }
    };

    /** @param {number} cpus @param {boolean} managed */
    const startChild = (cpus, managed) => {
      phase = 'running';
      const t = profile === null ? { env: {}, args: [] } : applyTemplate(profile, cpus);
      childStartedAt = Date.now();
      /** @type {NodeJS.ProcessEnv} */
      const childEnv = { ...env, ...t.env, CONDUCTOR_CPUS: String(cpus) };
      if (jobId !== null) childEnv.CONDUCTOR_JOB_ID = jobId;
      const c = spawnInOwnGroup([...argv, ...t.args], { env: childEnv, cwd, stdio: 'inherit' });
      child = c;
      c.once('error', (e) => {
        out(`[conductor] 起動できない: ${e.message}`);
        report(127);
      });
      c.once('exit', (code, sig) => {
        const result = code ?? signalCode(sig);
        if (!killedByCaller || pgid === null) {
          report(result);
          return;
        }
        // 呼び出し元の信号を転送した後に生まれた子には SIGTERM が届いていない。
        // グループへ送り直し、猶予の間に空にならなければ SIGKILL してから終了を返す
        const target = pgid;
        signalGroup(target, 'SIGTERM', ownPgid);
        void waitGroupGone(target, killGraceMs).then((gone) => {
          if (!gone) signalGroup(target, 'SIGKILL', ownPgid);
          report(result);
        });
      });
      if (c.pid === undefined) return;
      pgid = verifiedGroup(c.pid, ownPgid);
      if (pgid === null) out('[conductor] 子のプロセスグループを確かめられないので、信号を送らないモードで走らせる');
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
        finish(signalCode(sig));
        return;
      }
      if (phase !== 'running' || child === null) return;
      if (pgid === null) {
        child.kill('SIGTERM');
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
          await new Promise((r) => setTimeout(r, wait));
          wait = Math.min(wait * 2, 30_000);
        }
      }
    };

    connect({ home, env })
      .then((conn) => {
        attach(conn);
        ch?.send({ t: 'request', job });
      })
      .catch((e) => {
        if (!(e instanceof DaemonUnavailableError)) throw e;
        out(`[conductor] デーモンに届かないので、管理なしで実行する(二重貸し防止などの保証なし・CPU は宣言の最小 ${job.cpus.min}): ${e.message}`);
        startChild(job.cpus.min, false);
      });
  });
}
