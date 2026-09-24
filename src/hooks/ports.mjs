// @ts-check
// ポートが使用中で落ちた走行(EADDRINUSE など)から、ポートの番号を取り出し、そのポートを握っているプロセスを突き止める。
// 1 本のセッションでも起きる(前に走らせた dev サーバーやテストの残りが、同じポートを握ったまま残る)。
// 落ちた後にだけ呼ぶ(PostToolUseFailure)。普段の Bash の呼び出しには何も足さない。
// 調べ方は、使える道具の順に: lsof(macOS・多くの Linux)→ ss(iproute2)→ /proc/net/tcp(Linux。道具が無くても読める)。
// Windows は netstat -ano と tasklist。
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

/** ポートが使用中で落ちたと分かる文言(switchyard replay も同じものを使う) */
export const PORT_IN_USE = /EADDRINUSE|address already in use|port \d+ is (?:already )?in use|port is already (?:in use|allocated)/i;

/** @param {string} s @returns {number | null} */
const port = (s) => {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};

/**
 * 失敗の文面(と、文面に番号が無いときはコマンドの引数)から、使用中だったポートを取り出す。見つからなければ空。
 * 文面の形(実物):
 *   Node:   listen EADDRINUSE: address already in use 0.0.0.0:47321 / :::3000
 *   Go:     listen tcp :8080: bind: address already in use
 *   docker: Bind for 0.0.0.0:5432 failed: port is already allocated
 *   Vite 等: Port 5173 is already in use
 *   Python: OSError: [Errno 98] Address already in use(番号なし。コマンドの 8000・--port 8000・-p 8000 から取る)
 * @param {string} text @param {string} [command] @returns {number[]}
 */
export function portsFromText(text, command = '') {
  /** @type {Set<number>} */
  const out = new Set();
  const add = (/** @type {string | undefined} */ s) => {
    const p = s === undefined ? null : port(s);
    if (p !== null) out.add(p);
  };
  for (const line of text.split('\n')) {
    // ポートの失敗を言う行だけを見る(Java は Port 8080 was already in use のように別の言い方をする)
    if (!PORT_IN_USE.test(line) && !/EADDRINUSE|bind|already in use|already allocated/i.test(line)) continue;
    // 0.0.0.0:3000・:::3000・[::]:3000・127.0.0.1:3000・localhost:3000・tcp :8080
    for (const m of line.matchAll(/(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]*\]|::|localhost|tcp6?\s*)?:(\d{2,5})\b/gi)) add(m[1]);
    for (const m of line.matchAll(/\bport\s+(\d{2,5})\b/gi)) add(m[1]);
  }
  if (out.size === 0 && PORT_IN_USE.test(text)) {
    // 文面に番号が無い(Python など): コマンドの --port 8000・-p 8000・--port=8000・PORT=8000・http.server 8000
    for (const m of command.matchAll(/(?:--port[= ]|-p\s+|\bPORT=)(\d{2,5})\b/g)) add(m[1]);
    if (out.size === 0) for (const m of command.matchAll(/\bhttp\.server\s+(\d{2,5})\b/g)) add(m[1]);
  }
  return [...out];
}

/** @typedef {{ pid: number, name: string }} Holder */

/**
 * lsof の -F 出力(p<pid>・c<command> の行)から、握っている pid と名前を取り出す。
 * @param {string} out @returns {Holder[]}
 */
export function parseLsof(out) {
  /** @type {Holder[]} */
  const list = [];
  /** @type {Holder | null} */
  let cur = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      cur = Number.isInteger(pid) && pid > 0 ? { pid, name: '' } : null;
      if (cur !== null) list.push(cur);
    } else if (line.startsWith('c') && cur !== null) {
      cur.name = line.slice(1);
    }
  }
  return list;
}

/**
 * ss -ltnpH の出力(users:(("node",pid=123,fd=20)))から、そのポートで待ち受けているプロセスを取り出す。
 * @param {string} out @param {number} p @returns {Holder[]}
 */
export function parseSs(out, p) {
  /** @type {Holder[]} */
  const list = [];
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    const local = cols[3] ?? '';
    if (!local.endsWith(`:${p}`)) continue;
    for (const m of line.matchAll(/\("([^"]*)",pid=(\d+)/g)) {
      const pid = Number(m[2]);
      if (!list.some((h) => h.pid === pid)) list.push({ pid, name: m[1] });
    }
  }
  return list;
}

/**
 * /proc/net/tcp(6) の中身から、そのポートで待ち受けている(st が 0A)ソケットの inode を取り出す。
 * @param {string} table @param {number} p @returns {string[]}
 */
export function listeningInodes(table, p) {
  const hex = p.toString(16).toUpperCase().padStart(4, '0');
  /** @type {string[]} */
  const out = [];
  for (const line of table.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    if (cols[1].endsWith(`:${hex}`) && cols[3] === '0A') out.push(cols[9]);
  }
  return out;
}

/**
 * netstat -ano(Windows)の出力から、そのポートで LISTENING の pid を取り出す。
 * @param {string} out @param {number} p @returns {number[]}
 */
export function parseNetstat(out, p) {
  /** @type {number[]} */
  const pids = [];
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;
    if (!cols[1].endsWith(`:${p}`)) continue;
    const pid = Number(cols[4]);
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/** @param {string} file @param {string[]} args @returns {string | null} */
function tryRun(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000, windowsHide: true });
  } catch (e) {
    // lsof は見つからないと 1 で終わるが、出力が有れば使う
    const out = /** @type {{ stdout?: unknown }} */ (e).stdout;
    return typeof out === 'string' && out !== '' ? out : null;
  }
}

/** Linux: /proc から、そのポートで待ち受けているプロセスを探す(lsof も ss も無い機械のため) @param {number} p @returns {Holder[]} */
function procHolders(p) {
  /** @type {Set<string>} */
  const inodes = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const i of listeningInodes(readFileSync(f, 'utf8'), p)) inodes.add(`socket:[${i}]`);
    } catch {
      // 無い(IPv6 無効など)
    }
  }
  if (inodes.size === 0) return [];
  /** @type {Holder[]} */
  const out = [];
  let pids = [];
  try {
    pids = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {
    return [];
  }
  for (const pid of pids) {
    let fds = [];
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue; // 他のユーザーのプロセス・消えた
    }
    if (fds.some((fd) => { try { return inodes.has(readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { return false; } })) {
      let name = '';
      try {
        name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      } catch {
        // 消えた
      }
      out.push({ pid: Number(pid), name });
    }
  }
  return out;
}

/**
 * そのポートを握っているプロセス。見つからなければ空(道具が無い・他のユーザーのプロセスで見えない・docker が内側で握っている)。
 * 道具が無い・見つけられないときは、次の道具へ進む(lsof が入っていても、他のユーザーのプロセスは見えないことがある)。
 * @param {number} p @param {NodeJS.Platform} [platform]
 * @param {{ run?: (file: string, args: string[]) => string | null, proc?: (p: number) => Holder[] }} [deps] テストで道具を差し替える
 * @returns {Holder[]}
 */
export function holdersOf(p, platform = process.platform, { run = tryRun, proc = procHolders } = {}) {
  if (platform === 'win32') {
    // -p tcp は IPv4 だけを出す(Windows の node は :: で待ち受ける)。TCP と TCPv6 の両方の行が TCP で始まる
    const out = run('netstat', ['-ano']);
    if (out === null) return [];
    return parseNetstat(out, p).map((pid) => ({ pid, name: windowsImage(pid, run) }));
  }
  const lsof = run('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-Fpc']);
  if (lsof !== null) {
    const got = parseLsof(lsof);
    if (got.length > 0) return got;
  }
  if (platform === 'linux') {
    const ss = run('ss', ['-ltnpH']);
    if (ss !== null) {
      const got = parseSs(ss, p);
      if (got.length > 0) return got;
    }
    return proc(p);
  }
  return [];
}

/** @param {number} pid @param {(file: string, args: string[]) => string | null} run @returns {string} */
function windowsImage(pid, run) {
  const out = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  const m = out === null ? null : /^"([^"]+)"/.exec(out.trim());
  return m === null ? '' : m[1];
}

/** @typedef {{ command: string | null, cwd: string | null, elapsedSec: number | null }} HolderDetail */

/**
 * ps の etime([[dd-]hh:]mm:ss)を秒にする。読めなければ null。
 * @param {string} s @returns {number | null}
 */
export function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (m === null) return null;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4]);
}

/**
 * 握っているプロセスの詳しいこと(コマンドライン・作業場所・走っている時間)。分からないものは null。
 * @param {number} pid @param {NodeJS.Platform} [platform] @returns {HolderDetail}
 */
export function detailOf(pid, platform = process.platform) {
  if (platform === 'win32') return { command: null, cwd: null, elapsedSec: null };
  /** @type {HolderDetail} */
  const d = { command: null, cwd: null, elapsedSec: null };
  const ps = tryRun('ps', ['-o', 'etime=', '-o', 'command=', '-p', String(pid)]);
  if (ps !== null) {
    const m = /^\s*(\S+)\s+(.*)$/.exec(ps.split('\n')[0] ?? '');
    if (m !== null) {
      d.elapsedSec = parseEtime(m[1]);
      d.command = m[2].trim() || null;
    }
  }
  if (platform === 'linux') {
    try {
      d.cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      // 他のユーザーのプロセス
    }
    if (d.command === null) {
      try {
        d.command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((x) => x !== '').join(' ') || null;
      } catch {
        // 消えた
      }
    }
  } else {
    const out = tryRun('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const n = out === null ? undefined : out.split('\n').find((l) => l.startsWith('n'));
    if (n !== undefined) d.cwd = n.slice(1);
  }
  return d;
}
