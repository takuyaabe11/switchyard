// @ts-check

/** 見込みに使う直近の回数 */
export const ESTIMATE_WINDOW = 10;
/** 見込みを出すのに必要な最少の回数 */
export const ESTIMATE_MIN_SAMPLES = 3;

/**
 * 成功した走行の所要(古い順)から見込みを出す。直近 ESTIMATE_WINDOW 回の中央値。
 * @param {number[]} durations @returns {number | null}
 */
export function estimate(durations) {
  const recent = durations.slice(-ESTIMATE_WINDOW);
  if (recent.length < ESTIMATE_MIN_SAMPLES) return null;
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** repo × profile ごとの所要の帳簿 */
export class EstimateBook {
  /** @type {Map<string, number[]>} */
  #byKey = new Map();

  /** @param {string} repo @param {string} profile */
  static key(repo, profile) {
    return JSON.stringify([repo, profile]);
  }

  /** @param {string} repo @param {string} profile @param {number} durationMs @param {number | null} code */
  record(repo, profile, durationMs, code) {
    if (code !== 0) return;
    const k = EstimateBook.key(repo, profile);
    const list = this.#byKey.get(k) ?? [];
    list.push(durationMs);
    if (list.length > ESTIMATE_WINDOW) list.splice(0, list.length - ESTIMATE_WINDOW);
    this.#byKey.set(k, list);
  }

  /** @param {string} repo @param {string} profile @returns {number | null} */
  expected(repo, profile) {
    return estimate(this.#byKey.get(EstimateBook.key(repo, profile)) ?? []);
  }
}
