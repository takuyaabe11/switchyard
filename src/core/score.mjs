// @ts-check
/** @typedef {import('./types.mjs').Waiting} Waiting */

/** 種別の基礎点(初期値。設計 §6.2) */
export const CLASS_BASE = Object.freeze({ quick: 30, batch: 0, measure: 0 });
/** 待った 1 分あたりの加点 */
export const AGING_PER_MIN = 1;
/** 見込み 1 分あたりの減点 */
export const LENGTH_PENALTY_PER_MIN = 0.5;
/** 減点の対象にする見込みの上限(分) */
export const LENGTH_PENALTY_CAP_MIN = 30;

const MIN = 60_000;

/** @param {Waiting} w @param {number} now @returns {number} */
export function score(w, now) {
  const waitedMin = Math.max(0, now - w.arrivedAt) / MIN;
  const expectedMin = w.job.expectedMs === null ? 0 : w.job.expectedMs / MIN;
  return (
    CLASS_BASE[w.job.class] +
    waitedMin * AGING_PER_MIN -
    Math.min(expectedMin, LENGTH_PENALTY_CAP_MIN) * LENGTH_PENALTY_PER_MIN
  );
}

/**
 * 点数の高い順。同点は到着の早い順、さらに id 順(結果を決定的にするため)。
 * @param {Waiting[]} list @param {number} now @returns {Waiting[]}
 */
export function sortWaiting(list, now) {
  return [...list].sort((a, b) => {
    const d = score(b, now) - score(a, now);
    if (d !== 0) return d;
    if (a.arrivedAt !== b.arrivedAt) return a.arrivedAt - b.arrivedAt;
    return a.job.id < b.job.id ? -1 : a.job.id > b.job.id ? 1 : 0;
  });
}
