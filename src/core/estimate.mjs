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
  /** @type {Map<string, number[]>} 自分で終わった走行(成否を問わない)の所要。Bash の時間切れを延ばす目安(最長) */
  #finished = new Map();

  /** @param {string} repo @param {string} profile */
  static key(repo, profile) {
    return JSON.stringify([repo, profile]);
  }

  /** @param {string} repo @param {string} profile @param {number} durationMs @param {number | null} code */
  record(repo, profile, durationMs, code) {
    const k = EstimateBook.key(repo, profile);
    // 信号で終わった走行(128 + 番号。時間切れや Ctrl-C で殺された)は、終わるのにかかる時間を教えない。
    // 数えると、終わらない走行(watch モード・サーバー)の時間切れが伸び続け、やがて背景で走り続けてしまう
    if (code !== null && code < 128) {
      const done = this.#finished.get(k) ?? [];
      done.push(durationMs);
      if (done.length > ESTIMATE_WINDOW) done.splice(0, done.length - ESTIMATE_WINDOW);
      this.#finished.set(k, done);
    }
    if (code !== 0) return;
    const list = this.#byKey.get(k) ?? [];
    list.push(durationMs);
    if (list.length > ESTIMATE_WINDOW) list.splice(0, list.length - ESTIMATE_WINDOW);
    this.#byKey.set(k, list);
  }

  /** @param {string} repo @param {string} profile @returns {number | null} */
  expected(repo, profile) {
    return estimate(this.#byKey.get(EstimateBook.key(repo, profile)) ?? []);
  }

  /**
   * 自分で終わった直近の走行のうち最長の所要(repo × profile の鍵ごと)。1 回でも終われば出す。
   * @returns {Record<string, number>}
   */
  longestAll() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [k, list] of this.#finished) if (list.length > 0) out[k] = Math.max(...list);
    return out;
  }
}
