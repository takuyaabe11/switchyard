// @ts-check
// CPU の使い方の実測による要求の縮小(right-sizing)。純関数と帳簿だけで、入出力は持たない。
// 宣言(profile の cpus)は重い走行に合わせて広めに取られがちで、待ちと入出力が中心の走行も CPU を 2 コア以上要求して並ぶ
// (実測: switchyard 自身の全件は平均 0.8 コアしか使わないのに、最小 2 コアを要求して 3 本同時に走れなかった)。
// 走り終えた走行の CPU 時間から平均の使用コア数を出し、割り振られた量の半分も使わない走行が続く profile だけ要求を下げる。
// 下げるだけで、宣言より上げない。割り振りを使い切る走行は、割り振りが少なかったせいで少なく測れただけかもしれないので下げない
// (VITEST_MAX_THREADS={cpus} のように割り振りでスレッド数が決まる走行が、測るたびに縮み続けるのを防ぐ)。

/** 見込みに使う直近の回数 */
export const USAGE_WINDOW = 10;
/** 縮めるのに必要な最少の回数 */
export const USAGE_MIN_SAMPLES = 3;
/** 測り方が粗い短い走行は数えない(ms) */
export const USAGE_MIN_DURATION_MS = 2_000;
/** 割り振られた量に対する使用の割合がこれ未満の走行だけを「使い切らない」とみなす */
export const UNDERUSE_RATIO = 0.5;

/** @typedef {{ cores: number, ratio: number }} UsageSample */

/** @param {number[]} xs @returns {number} */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** repo × profile ごとの、成功した走行の CPU の使い方 */
export class UsageBook {
  /** @type {Map<string, UsageSample[]>} */
  #byKey = new Map();

  /**
   * @param {string} repo @param {string} profile
   * @param {{ durationMs: number, cpuMs: number | null, cpus: number, code: number | null }} run
   */
  record(repo, profile, { durationMs, cpuMs, cpus, code }) {
    if (code !== 0 || cpuMs === null || cpus <= 0 || durationMs < USAGE_MIN_DURATION_MS) return;
    const cores = cpuMs / durationMs;
    const k = usageKey(repo, profile);
    const list = this.#byKey.get(k) ?? [];
    list.push({ cores, ratio: cores / cpus });
    if (list.length > USAGE_WINDOW) list.splice(0, list.length - USAGE_WINDOW);
    this.#byKey.set(k, list);
  }

  /**
   * 要求を縮めてよい profile の、平均の使用コア数の中央値。回数が足りない・割り振りを使い切る走行が多ければ null(縮めない)。
   * @param {string} repo @param {string} profile @returns {number | null}
   */
  cores(repo, profile) {
    return this.#coresOf(this.#byKey.get(usageKey(repo, profile)) ?? []);
  }

  /** 縮めてよい全ての repo × profile と、その使用コア数(盤面に載せ、PreToolUse が待ちの見込みに使う) @returns {Record<string, number>} */
  sizedAll() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const [k, list] of this.#byKey) {
      const c = this.#coresOf(list);
      if (c !== null) out[k] = c;
    }
    return out;
  }

  /** @param {UsageSample[]} list @returns {number | null} */
  #coresOf(list) {
    if (list.length < USAGE_MIN_SAMPLES) return null;
    if (median(list.map((x) => x.ratio)) >= UNDERUSE_RATIO) return null;
    return median(list.map((x) => x.cores));
  }
}

/** repo × profile の鍵(盤面の sized の鍵と同じ) @param {string} repo @param {string} profile */
export const usageKey = (repo, profile) => JSON.stringify([repo, profile]);

/**
 * 実測の使用コア数に合わせて、batch の要求を小さくする(大きくはしない)。計測・鍵だけのジョブ・入れ子で 0 のジョブは変えない。
 * n = 使用コア数の切り上げ(1 以上)として、最小は min(宣言の最小, n)、最大は min(宣言の最大, max(新しい最小, n))。
 * 縮めたときは、宣言と実測を job に残す(top と why と記録で見えるように)。
 * @template {{ class: string, cpus: { min: number, max: number } }} J
 * @param {J} job @param {number | null} cores @returns {J & { sizedFrom?: { min: number, max: number }, measuredCores?: number }}
 */
export function rightSize(job, cores) {
  if (cores === null || job.class !== 'batch' || job.cpus.max === 0) return job;
  const n = Math.max(1, Math.ceil(cores));
  const min = Math.min(job.cpus.min, n);
  const max = Math.min(job.cpus.max, Math.max(min, n));
  if (min === job.cpus.min && max === job.cpus.max) return job;
  return { ...job, cpus: { min, max }, sizedFrom: job.cpus, measuredCores: Math.round(cores * 100) / 100 };
}
