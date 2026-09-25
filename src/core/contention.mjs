// @ts-check
// 重なりによる遅れを profile ごとに学ぶ。純関数と帳簿だけで、入出力は持たない。
// 待たせる理由は「重ねると遅くなる」だが、遅くならない走行(入出力や待ちが中心・機械に余裕がある)まで待たせると、
// 待ちの分だけ損をする。走行ごとに「その間に他の処理が機械で使っていたコア数」を測り、
// 他が静かだった走行と、機械が埋まる中で他と取り合った走行の所要の中央値を比べて、遅れの倍率を出す。
// 倍率が小さい(TOLERANT_SLOWDOWN 以下)profile は、CPU の空きが足りなくても待たせない(schedule.mjs)。

/** 学ぶのに使う直近の回数 */
export const CONTENTION_WINDOW = 20;
/** 倍率を出すのに、静かだった走行と重なった走行がそれぞれ要る最少の回数 */
export const CONTENTION_MIN_SAMPLES = 3;
/** 測り方が粗い短い走行は数えない(ms) */
export const CONTENTION_MIN_DURATION_MS = 5_000;
/** 走行の所要のうち、機械の忙しさを測れた割合がこれ未満なら数えない */
export const CONTENTION_MIN_COVERAGE = 0.5;
/** 他の処理がこれ未満(機械のコア数に対する割合。最低 0.5 コア)なら「静か」 */
export const ALONE_SHARE = 0.1;
/** 他の処理がこれ以上(機械のコア数に対する割合。最低 1 コア)で、機械が埋まっていれば「重なった」 */
export const CONTENDED_SHARE = 0.25;
/**
 * 自分と他の処理を合わせてこれ以上(機械のコア数に対する割合)なら「機械が埋まっている」。
 * CPU を取り合うと、他の処理が取れるのは自分の残りの分だけになる(実測: 4 コアを使い切る仕事の横で 4 コアを回すと、
 * 他の処理は約 2 コアしか取れなかった)ので、他の処理の量だけでは重なったかを決められない。
 */
export const SATURATED_SHARE = 0.9;
/** 遅れの倍率がこれ以下なら、重なっても遅くならないとみなす(待たせない) */
export const TOLERANT_SLOWDOWN = 1.15;
/** 重なっても遅くならないと学んだジョブを、CPU の空きが足りなくても入れる上限(容量に対する倍率) */
export const TOLERANT_OVERCOMMIT = 2;

/** @typedef {'alone' | 'contended' | 'partial'} Overlap */

/**
 * 走行の間に他の処理が使っていた平均のコア数。測れなければ null。
 * 機械全体の忙しさ(コア数)の時間平均から、この走行自身の平均の使用コア数(CPU 時間 / 所要)を引く。
 * @param {{ busyCoreMs: number, coveredMs: number, durationMs: number, cpuMs: number | null }} run
 *   busyCoreMs: 機械の忙しさ(コア数)× 測れた時間 の和。coveredMs: 測れた時間の和
 * @returns {number | null}
 */
export function otherLoadOf({ busyCoreMs, coveredMs, durationMs, cpuMs }) {
  if (cpuMs === null || !(durationMs >= CONTENTION_MIN_DURATION_MS) || !(coveredMs >= durationMs * CONTENTION_MIN_COVERAGE)) return null;
  const other = busyCoreMs / coveredMs - cpuMs / durationMs;
  return Math.round(Math.max(0, other) * 100) / 100;
}

/**
 * 走行を、静か・重なった・その間に分ける。
 * 静か: 他の処理が機械のコア数の 1 割未満(最低 0.5 コア)。
 * 重なった: 他の処理が 4 分の 1 以上(最低 1 コア)で、自分と合わせて機械のコア数の 9 割以上(機械が埋まっている)。
 * @param {number} otherLoad 他の処理のコア数 @param {number} ownCores この走行の平均の使用コア数 @param {number} cores 機械の論理コア数
 * @returns {Overlap}
 */
export function overlapOf(otherLoad, ownCores, cores) {
  if (otherLoad < Math.max(0.5, cores * ALONE_SHARE)) return 'alone';
  if (otherLoad >= Math.max(1, cores * CONTENDED_SHARE) && otherLoad + ownCores >= cores * SATURATED_SHARE) return 'contended';
  return 'partial';
}

/** @param {number[]} xs @returns {number} */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 遅れの倍率(重なった走行の所要の中央値 / 静かだった走行の所要の中央値)。どちらかの回数が足りなければ null。
 * @param {Array<{ durationMs: number, overlap: Overlap }>} runs @returns {{ slowdown: number, alone: number, contended: number } | null}
 */
export function slowdownOf(runs) {
  const alone = runs.filter((r) => r.overlap === 'alone').map((r) => r.durationMs);
  const contended = runs.filter((r) => r.overlap === 'contended').map((r) => r.durationMs);
  if (alone.length < CONTENTION_MIN_SAMPLES || contended.length < CONTENTION_MIN_SAMPLES) return null;
  return { slowdown: Math.round((median(contended) / median(alone)) * 100) / 100, alone: alone.length, contended: contended.length };
}

/** 重なっても遅くならないと学んだか @param {{ slowdown?: number | null }} job @returns {boolean} */
export const isTolerant = (job) => typeof job.slowdown === 'number' && job.slowdown <= TOLERANT_SLOWDOWN;

/** repo × profile ごとの、成功した走行の所要と重なり */
export class ContentionBook {
  /** @type {Map<string, Array<{ durationMs: number, overlap: Overlap }>>} */
  #byKey = new Map();

  /**
   * @param {string} repo @param {string} profile
   * @param {{ durationMs: number, code: number | null, overlap: Overlap | null }} run
   */
  record(repo, profile, { durationMs, code, overlap }) {
    if (code !== 0 || overlap === null || durationMs < CONTENTION_MIN_DURATION_MS) return;
    const k = JSON.stringify([repo, profile]);
    const list = this.#byKey.get(k) ?? [];
    list.push({ durationMs, overlap });
    if (list.length > CONTENTION_WINDOW) list.splice(0, list.length - CONTENTION_WINDOW);
    this.#byKey.set(k, list);
  }

  /** 遅れの倍率。学べていなければ null @param {string} repo @param {string} profile @returns {number | null} */
  slowdown(repo, profile) {
    return slowdownOf(this.#byKey.get(JSON.stringify([repo, profile])) ?? [])?.slowdown ?? null;
  }

  /** 学べた全ての repo × profile の倍率と回数(盤面・report に載せる) */
  learnedAll() {
    /** @type {Record<string, { slowdown: number, alone: number, contended: number }>} */
    const out = {};
    for (const [k, list] of this.#byKey) {
      const s = slowdownOf(list);
      if (s !== null) out[k] = s;
    }
    return out;
  }
}
