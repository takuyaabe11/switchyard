// @ts-check
// 子を別のプロセスグループで起動し、そのグループにだけ信号を送る(設計 §4.3 / §7.1)。
import { execFileSync, spawn } from 'node:child_process';

/** @param {number} pid @returns {number | null} */
export function readPgid(pid) {
  try {
    const n = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, stdio?: import('node:child_process').StdioOptions }} [opts]
 */
export function spawnInOwnGroup(argv, opts = {}) {
  if (argv.length === 0) throw new Error('起動するコマンドが無い');
  return spawn(argv[0], argv.slice(1), { detached: true, env: opts.env, cwd: opts.cwd, stdio: opts.stdio ?? 'inherit' });
}

/**
 * 子が自分のプロセスグループを持ち、それが呼び出し元のグループと違うことを確かめる。
 * 確かめられなければ null を返す(呼び出し側はグループへの信号を送らず、呼び出し元の終了だけを子の pid に伝える)。
 * @param {number} childPid @param {number | null} [ownPgid] @returns {number | null}
 */
export function verifiedGroup(childPid, ownPgid = readPgid(process.pid)) {
  const pgid = readPgid(childPid);
  if (pgid === null || ownPgid === null) return null;
  if (pgid !== childPid || pgid === ownPgid) return null;
  return pgid;
}

/**
 * 確かめたグループにだけ信号を送る。自分のグループ・1 以下・自分の pgid が読めないときは投げて拒む。
 * グループが既に無ければ false。
 * @param {number} pgid @param {NodeJS.Signals} signal @param {number | null} [ownPgid] @returns {boolean}
 */
export function signalGroup(pgid, signal, ownPgid = readPgid(process.pid)) {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`不正な pgid: ${pgid}`);
  if (ownPgid === null) throw new Error('自分の pgid を読めないので、信号を送らない');
  if (pgid === ownPgid) throw new Error(`自分のプロセスグループ ${pgid} には送らない`);
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ESRCH') return false;
    throw e;
  }
}

/**
 * プロセスグループの優先度を下げる(設計 §6.7 の throttle)。
 * `renice` はグループ全体に効く(`os.setPriority` は pid 1 つにしか効かず、先に生まれた子には届かない)。
 * 下げられなくても走行は続くので、失敗は false を返すだけにする。
 * @param {number} pgid @param {number} priority 0 が普通・大きいほど後回し @returns {boolean}
 */
export function renicePriority(pgid, priority) {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`不正な pgid: ${pgid}`);
  try {
    execFileSync('renice', ['-n', String(priority), '-g', String(pgid)], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * グループに、ゾンビでないプロセスが残っているか。
 * 信号 0 はゾンビにも届くので、init が子を回収しないコンテナでは、終わったグループがいつまでも生きて見える。
 * ps が使えなければ、確かめられないので生きているとみなす(資源を早く返しすぎない側に倒す)。
 * @param {number} pgid @returns {boolean}
 */
export function groupHasLiveMembers(pgid) {
  /** @type {string} */
  let out;
  try {
    out = execFileSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return true;
  }
  return out.split('\n').some((line) => {
    const [g, st] = line.trim().split(/\s+/);
    return Number(g) === pgid && st !== undefined && !st.startsWith('Z');
  });
}

/**
 * グループのプロセスが全部消えるまで待つ(ゾンビだけが残ったら消えたとみなす)。消えたら true、時間内に消えなければ false。
 * @param {number} pgid @param {number} timeoutMs @param {number} [stepMs] @returns {Promise<boolean>}
 */
export async function waitGroupGone(pgid, timeoutMs, stepMs = 20) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pgid, 0);
      if (!groupHasLiveMembers(pgid)) return true;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ESRCH') return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
