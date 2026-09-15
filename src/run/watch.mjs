// @ts-check
// 子孫のプロセスを見て、プロセスグループから抜けたものと、終わった後も生きているものを数える(設計 §13 V6・§10)。
// どのコマンドにも同じように働く。ツールごとの表は持たない。
import { execFileSync } from 'node:child_process';

/** @typedef {{ pid: number, ppid: number, pgid: number, comm: string, started: string }} ProcRow */
/** @typedef {{ comm: string, count: number }} EscapedCount */
/** @typedef {{ pid: number, comm: string, inGroup: boolean }} Survivor */
/** @typedef {{ seen: number, escaped: EscapedCount[], survivors: Survivor[] }} EscapeReport */

/**
 * ps の 1 行(`pid=,ppid=,pgid=,lstart=,comm=`。LC_ALL=C で「曜日 月 日 時刻 年」の固定 5 語)を解析する。
 * comm はパスに空白を含みうる(実測: この機械の `ps -A` 521 行のうち 65 行が該当。「稀」ではない)ので、
 * lstart の 5 語より後ろを全部つないで 1 つの comm として扱う。数が読めない・語が足りない行は null。
 * @param {string} line @returns {ProcRow | null}
 */
export function parsePsLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 9) return null;
  const pid = Number(parts[0]);
  const ppid = Number(parts[1]);
  const pgid = Number(parts[2]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) return null;
  const started = parts.slice(3, 8).join(' ');
  const comm = parts.slice(8).join(' ');
  return { pid, ppid, pgid, comm, started };
}

/** @param {ProcRow | null} r @returns {r is ProcRow} */
const isRow = (r) => r !== null;

/**
 * @returns {ProcRow[]}
 */
export function processTable() {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,comm='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
    .trim()
    .split('\n')
    .map(parsePsLine)
    .filter(isRow);
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
 * 親子関係(ppid)で子孫をたどる。親が先に終わって親子関係が切れた子(ppid 1)も、
 * 前に見た開始時刻(lstart)と一致するときだけ追い続ける(名前の一致では使い回された pid を取り違える。I2)。
 * 限界: sample() の間隔より速く二重 fork して親を離れたプロセスは見逃しうる。
 * @param {{ rootPid: number, pgid: number, list?: () => ProcRow[] }} opts
 */
export function createEscapeTracker({ rootPid, pgid, list = processTable }) {
  /** @type {Map<number, { pgid: number, comm: string, started: string }>} */
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
      // 親子関係が切れた子は、開始時刻が前に見たものと一致するときだけ同じプロセスとみなす(名前の一致はやめる。使い回された pid を取り違えない)
      const orphanedSame = known !== undefined && r.ppid === 1 && known.started === r.started;
      if (tree.has(r.pid) || orphanedSame) seen.set(r.pid, { pgid: r.pgid, comm, started: r.started });
    }
  };

  /** @returns {EscapeReport} */
  const report = () => {
    /** @type {Map<string, number>} */
    const counts = new Map();
    for (const [, v] of seen) if (v.pgid !== pgid) counts.set(v.comm, (counts.get(v.comm) ?? 0) + 1);
    const escaped = [...counts].map(([comm, count]) => ({ comm, count })).sort((a, b) => (a.comm < b.comm ? -1 : a.comm > b.comm ? 1 : 0));
    // 生き残りは、報告の時点でプロセス一覧を読み直し、同じ pid で開始時刻も一致するものだけにする(使い回された pid へ SIGKILL しない。I2)
    /** @type {ProcRow[]} */
    let fresh = [];
    try {
      fresh = list();
    } catch {
      fresh = []; // 読み直せなければ、確かめられない生き残りは報告しない(安全側に倒す)
    }
    const freshById = new Map(fresh.map((r) => [r.pid, r]));
    /** @type {Survivor[]} */
    const survivors = [];
    for (const [pid, v] of seen) {
      if (pid === rootPid) continue;
      const now = freshById.get(pid);
      if (now !== undefined && now.started === v.started) survivors.push({ pid, comm: v.comm, inGroup: v.pgid === pgid });
    }
    survivors.sort((a, b) => a.pid - b.pid);
    return { seen: seen.size, escaped, survivors };
  };

  return { sample, report };
}
