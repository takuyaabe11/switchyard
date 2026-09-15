// @ts-check
// 子孫のプロセスを見て、プロセスグループから抜けたものと、終わった後も生きているものを数える(設計 §13 V6・§10)。
// どのコマンドにも同じように働く。ツールごとの表は持たない。
import { execFileSync } from 'node:child_process';

/** @typedef {{ pid: number, ppid: number, pgid: number, comm: string }} ProcRow */
/** @typedef {{ comm: string, count: number }} EscapedCount */
/** @typedef {{ pid: number, comm: string, inGroup: boolean }} Survivor */
/** @typedef {{ seen: number, escaped: EscapedCount[], survivors: Survivor[] }} EscapeReport */

/** @returns {ProcRow[]} */
export function processTable() {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid, pgid, ...comm] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), comm: comm.join(' ') };
    });
}

/** @param {number} pid */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * コマンド名を比べられる形にする。パスを落とし、終わりかけ(ゾンビ)のプロセスを ps が
 * `(perl)` のように括弧で囲んで出すので、外側の括弧も外す。
 * @param {string} comm
 */
const baseName = (comm) => {
  const name = comm.split('/').pop() ?? comm;
  return name.length > 2 && name.startsWith('(') && name.endsWith(')') ? name.slice(1, -1) : name;
};

/**
 * 子孫の追跡器。sample() を定期的に呼び、終わったら report() で結果を得る。
 * 親子関係(ppid)で子孫をたどる。親が先に終わって親子関係が切れた子(ppid 1)も、名前が同じなら追い続ける。
 * 限界: sample() の間隔より速く二重 fork して親を離れたプロセスは見逃しうる。
 * @param {{ rootPid: number, pgid: number, list?: () => ProcRow[], isAlive?: (pid: number) => boolean }} opts
 */
export function createEscapeTracker({ rootPid, pgid, list = processTable, isAlive = pidAlive }) {
  /** @type {Map<number, { pgid: number, comm: string }>} */
  const seen = new Map();

  const sample = () => {
    /** @type {ProcRow[]} */
    let rows;
    try {
      rows = list();
    } catch {
      return; // ps が一時的に失敗しても、追跡は続ける
    }
    const tree = new Set([rootPid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) {
        if (!tree.has(r.pid) && tree.has(r.ppid)) {
          tree.add(r.pid);
          grew = true;
        }
      }
    }
    for (const r of rows) {
      const comm = baseName(r.comm);
      const known = seen.get(r.pid);
      // 親子関係が切れた子は、名前が同じときだけ同じプロセスとみなす(使い回された pid を取り違えない)
      const orphanedSame = known !== undefined && r.ppid === 1 && known.comm === comm;
      if (tree.has(r.pid) || orphanedSame) seen.set(r.pid, { pgid: r.pgid, comm });
    }
  };

  /** @returns {EscapeReport} */
  const report = () => {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const [, v] of seen) if (v.pgid !== pgid) counts.set(v.comm, (counts.get(v.comm) ?? 0) + 1);
    const escaped = [...counts].map(([comm, count]) => ({ comm, count })).sort((a, b) => (a.comm < b.comm ? -1 : a.comm > b.comm ? 1 : 0));
    const survivors = [...seen]
      .filter(([pid]) => pid !== rootPid && isAlive(pid))
      .map(([pid, v]) => ({ pid, comm: v.comm, inGroup: v.pgid === pgid }))
      .sort((a, b) => a.pid - b.pid);
    return { seen: seen.size, escaped, survivors };
  };

  return { sample, report };
}
