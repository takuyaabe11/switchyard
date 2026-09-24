// @ts-check
// メモリの使い方の実測(ピークの RSS)。純関数と帳簿だけで、入出力は持たない。
// 重い走行(JVM のビルド・ブラウザを使う E2E)が重なると、スワップや OOM で数倍遅くなるか、やり直しになる。
// 走り終えた走行のピークを repo × profile ごとに覚え、次にその走行を重ねる前に、空きメモリに収まるかを見る。

/** 見込みに使う直近の回数。ピークは安全のための量なので、中央値ではなく直近の最大を採る */
export const MEMORY_WINDOW = 3;

/** repo × profile ごとのピークの RSS(MB) */
export class MemoryBook {
  /** @type {Map<string, number[]>} */
  #byKey = new Map();

  /** @param {string} repo @param {string} profile @param {number | null | undefined} peakMb */
  record(repo, profile, peakMb) {
    if (typeof peakMb !== 'number' || !(peakMb > 0)) return;
    const k = JSON.stringify([repo, profile]);
    const list = this.#byKey.get(k) ?? [];
    list.push(peakMb);
    if (list.length > MEMORY_WINDOW) list.splice(0, list.length - MEMORY_WINDOW);
    this.#byKey.set(k, list);
  }

  /** 見込みのピーク(直近の最大)。記録が無ければ null @param {string} repo @param {string} profile @returns {number | null} */
  expected(repo, profile) {
    const list = this.#byKey.get(JSON.stringify([repo, profile]));
    return list === undefined || list.length === 0 ? null : Math.max(...list);
  }
}

/**
 * 空きメモリの見積もり(schedule に渡す)。機械の空きから、走行中のジョブが見込みのピークまでにまだ使っていない分を引く
 * (入場した直後の走行は、まだメモリを取っていないので、機械の空きだけを見ると重ねすぎる)。
 * @param {{ availableMb: number, leases: Array<{ memMb: number | null, rssMb: number | null }> }} input
 * @returns {number}
 */
export function effectiveAvailableMb({ availableMb, leases }) {
  let reserved = 0;
  for (const l of leases) if (l.memMb !== null) reserved += Math.max(0, l.memMb - (l.rssMb ?? 0));
  return availableMb - reserved;
}
