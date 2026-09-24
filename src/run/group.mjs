// @ts-check
// 子を別のプロセスグループで起動し、そのグループにだけ信号を送る(設計 §4.3 / §7.1)。
import { execFile, execFileSync, spawn } from 'node:child_process';

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
 * 子を sh の下で起動し、子とその子孫が使った CPU 時間を測る。sh の組み込み `times` の 2 行目(回収した子の user と sys)を
 * 番号 3 の記述子へ書かせる。`times` は POSIX で、macOS と Linux のどちらの sh にもある。
 * - 子は背景で起動して pid を番号 3 へ先に書く(グループを確かめられないとき、信号を子へ直に送るため)
 * - 非対話の sh は背景の子の標準入力を /dev/null にするので、番号 4 へ複製してから戻す
 * - sh が受けた TERM / INT / HUP は子へ送り直す。子の終了コードは sh がそのまま返す(信号で終わった子は 128 + 番号)
 * - 子自身には番号 3 と 4 を渡さない
 */
const MEASURE_SCRIPT = [
  'exec 4<&0',
  '"$@" 3>&- 0<&4 4<&- &',
  'p=$!',
  'exec 4<&-',
  'echo "$p" >&3',
  "trap 'kill -TERM $p 2>/dev/null' TERM",
  "trap 'kill -INT $p 2>/dev/null' INT",
  "trap 'kill -HUP $p 2>/dev/null' HUP",
  'while :; do wait "$p"; s=$?; kill -0 "$p" 2>/dev/null || break; done',
  'times >&3',
  'exit $s',
].join('\n');

/**
 * 番号 3 に届いた文(1 行目が子の pid、続く 2 行が `times`。`0m1.630000s 0m0.050000s` の形で、bash は小数 3 桁)から、
 * 最後の行(回収した子の user + sys)を ms で取る。読めなければ null。
 * @param {string} text @returns {number | null}
 */
export function parseTimes(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 3) return null;
  const parts = [...lines[lines.length - 1].matchAll(/(\d+)m([\d.]+)s/g)];
  if (parts.length !== 2) return null;
  return Math.round(parts.reduce((ms, m) => ms + (Number(m[1]) * 60 + Number(m[2])) * 1000, 0));
}

/**
 * spawnInOwnGroup と同じく別のプロセスグループで起動し、子の実際の pid と、終わったときの子と子孫の CPU 時間(ms)を返す約束を付ける。
 * sh が信号で終わった・times を読めなかったときは null。
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [opts]
 * @returns {{ child: import('node:child_process').ChildProcess, commandPid: () => number | null, cpuMs: Promise<number | null> }}
 */
export function spawnMeasured(argv, opts = {}) {
  if (argv.length === 0) throw new Error('起動するコマンドが無い');
  const child = spawn('/bin/sh', ['-c', MEASURE_SCRIPT, 'sh', ...argv], { detached: true, env: opts.env, cwd: opts.cwd, stdio: ['inherit', 'inherit', 'inherit', 'pipe'] });
  const pipe = /** @type {import('node:stream').Readable | null} */ (child.stdio[3]);
  let text = '';
  const cpuMs = new Promise((resolve) => {
    if (pipe === null) {
      resolve(null);
      return;
    }
    pipe.setEncoding('utf8');
    pipe.on('data', (d) => {
      text += d;
    });
    pipe.on('error', () => resolve(null));
    pipe.on('close', () => resolve(parseTimes(text)));
  });
  const commandPid = () => {
    const n = Number(text.split('\n')[0]);
    return Number.isInteger(n) && n > 1 ? n : null;
  };
  return { child, commandPid, cpuMs: /** @type {Promise<number | null>} */ (cpuMs) };
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

/**
 * プロセスグループごとの RSS の合計(MB)。ゾンビは数えない。ps が使えなければ空。
 * デーモンが走行中のジョブのピークを測るのに使う(待たずに返す execFile で、割り振りを止めない)。
 * @returns {Promise<Map<number, number>>}
 */
export function rssByGroup() {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pgid=,rss=,stat='], { encoding: 'utf8' }, (err, out) => {
      /** @type {Map<number, number>} */
      const map = new Map();
      if (err) {
        resolve(map);
        return;
      }
      for (const line of out.split('\n')) {
        const [g, rss, st] = line.trim().split(/\s+/);
        const pgid = Number(g);
        const kb = Number(rss);
        if (!Number.isInteger(pgid) || pgid <= 0 || !Number.isFinite(kb) || st === undefined || st.startsWith('Z')) continue;
        map.set(pgid, (map.get(pgid) ?? 0) + kb / 1024);
      }
      resolve(map);
    });
  });
}
