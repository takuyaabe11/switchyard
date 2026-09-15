// @ts-check
// 包み・CLI とデーモンの間でやり取りするメッセージの形。

/** @typedef {import('../core/types.mjs').JobSpec} JobSpec */
/** @typedef {import('../core/types.mjs').JobClass} JobClass */
/** @typedef {import('../core/types.mjs').CpuRange} CpuRange */
/** @typedef {import('../core/types.mjs').LeasePhase} LeasePhase */
/** @typedef {import('../core/types.mjs').Unacked} Unacked */
/** @typedef {Omit<JobSpec, 'id' | 'expectedMs'>} JobRequest */
/** @typedef {import('../run/watch.mjs').EscapedCount} EscapedCount */
/** @typedef {import('../run/watch.mjs').Survivor} Survivor */
/** @typedef {{ escaped: EscapedCount[], survivors: Survivor[] }} EscapeSummary */

/** @typedef {{ jobId: string, position: number, reason: string, etaWall: number | null }} WallNote */
/**
 * @typedef {{
 *   id: string, session: string, class: JobClass, cmd: string, why: string | null,
 *   cpus: number, locks: string[], phase: LeasePhase, recovering: boolean,
 *   sinceWall: number, expectedMs: number | null, escapes: string[]
 * }} LeaseView
 */
/**
 * @typedef {{
 *   id: string, session: string, class: JobClass, cmd: string, why: string | null,
 *   cpus: CpuRange, locks: string[], recovering: boolean, sinceWall: number, note: WallNote | null, escapes: string[]
 * }} WaitingView
 */
/**
 * @typedef {{
 *   capacity: number, used: number, leases: LeaseView[], waiting: WaitingView[],
 *   unacked: Record<string, Unacked[]>, badRecords: number, version: string
 * }} Snapshot
 */

const CLASSES = ['quick', 'batch', 'measure'];
const PREEMPTS = ['pause', 'throttle', 'never'];

/** @param {unknown} v @returns {number | null} */
export function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 包みから届いた job を確かめる。形が違えば、どの項目かを名指しして投げる。
 * @param {unknown} v @returns {JobRequest}
 */
export function parseJobRequest(v) {
  if (typeof v !== 'object' || v === null) throw new Error('job がオブジェクトではない');
  const o = /** @type {Record<string, unknown>} */ (v);
  const str = (/** @type {string} */ k) => {
    const x = o[k];
    if (typeof x !== 'string' || x === '') throw new Error(`job.${k} は空でない文字列`);
    return x;
  };
  const cls = o.class;
  if (typeof cls !== 'string' || !CLASSES.includes(cls)) throw new Error('job.class は quick / batch / measure');
  const pre = o.preempt;
  if (typeof pre !== 'string' || !PREEMPTS.includes(pre)) throw new Error('job.preempt は pause / throttle / never');
  const c = /** @type {Record<string, unknown> | null} */ (typeof o.cpus === 'object' ? o.cpus : null);
  const lockOnly = c !== null && c.min === 0 && c.max === 0;
  if (c === null || !Number.isInteger(c.min) || !Number.isInteger(c.max) || (!lockOnly && Number(c.min) < 1) || Number(c.max) < Number(c.min)) {
    throw new Error('job.cpus は { min: 1 以上の整数, max: min 以上の整数 } か、鍵だけのジョブの { min: 0, max: 0 }');
  }
  if (!Array.isArray(o.locks) || !o.locks.every((x) => typeof x === 'string')) throw new Error('job.locks は文字列の配列');
  if (lockOnly && o.locks.length === 0) throw new Error('job.cpus が 0..0 の鍵だけのジョブは、job.locks を 1 本以上持つ');
  if (o.why !== null && typeof o.why !== 'string') throw new Error('job.why は文字列か null');
  return {
    session: str('session'),
    repo: str('repo'),
    profile: str('profile'),
    cmd: str('cmd'),
    class: /** @type {JobClass} */ (cls),
    cpus: { min: Number(c.min), max: Number(c.max) },
    locks: /** @type {string[]} */ (o.locks),
    preempt: /** @type {import('../core/types.mjs').Preempt} */ (pre),
    why: /** @type {string | null} */ (o.why),
  };
}

/**
 * 包みが exit に付けて送る、グループから抜けた子と生き残りの要約を確かめる。
 * 形が合わない要素は捨てる(終了の報告そのものは受け取る)。全体の形が違えば null。
 * @param {unknown} v @returns {EscapeSummary | null}
 */
export function parseEscape(v) {
  if (typeof v !== 'object' || v === null) return null;
  const o = /** @type {Record<string, unknown>} */ (v);
  if (!Array.isArray(o.escaped) || !Array.isArray(o.survivors)) return null;
  /** @type {EscapedCount[]} */
  const escaped = [];
  for (const x of o.escaped) {
    const e = /** @type {Record<string, unknown>} */ (typeof x === 'object' && x !== null ? x : {});
    if (typeof e.comm === 'string' && Number.isInteger(e.count)) escaped.push({ comm: e.comm, count: Number(e.count) });
  }
  /** @type {Survivor[]} */
  const survivors = [];
  for (const x of o.survivors) {
    const e = /** @type {Record<string, unknown>} */ (typeof x === 'object' && x !== null ? x : {});
    if (Number.isInteger(e.pid) && typeof e.comm === 'string' && typeof e.inGroup === 'boolean') survivors.push({ pid: Number(e.pid), comm: e.comm, inGroup: e.inGroup });
  }
  return { escaped, survivors };
}
