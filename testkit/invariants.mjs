// @ts-check
// 不変条件(設計 §6.6)。破れていたら、どの条件かを名乗って投げる。
/** @typedef {import('../src/core/types.mjs').State} State */

/** @param {State} s */
export function checkInvariants(s) {
  const used = s.leases.reduce((n, l) => n + l.cpus, 0);
  if (used > s.capacity) throw new Error(`I1: CPU の割り振り ${used} が容量 ${s.capacity} を超えた`);

  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const l of s.leases) for (const k of new Set(l.job.locks)) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const [k, n] of counts) {
    const cap = s.lockCaps[k] ?? 1;
    if (n > cap) throw new Error(`I2: 鍵 ${k} の保持者 ${n} が容量 ${cap} を超えた`);
  }

  const measure = s.leases.find((l) => l.job.class === 'measure');
  if (measure !== undefined && s.leases.some((l) => l !== measure && l.cpus > 0)) {
    // 鍵だけのリース(cpus 0)は計測と並んでよい(設計 §6.6 の I3)
    throw new Error(`I3: 計測と同時に CPU を持つ他のリースがある(${s.leases.map((l) => l.job.id).join(', ')})`);
  }

  for (const l of s.leases) {
    if (l.cpus < l.job.cpus.min || l.cpus > l.job.cpus.max) {
      throw new Error(`cpus の範囲外: ${l.job.id} に ${l.cpus}(宣言 ${l.job.cpus.min}..${l.job.cpus.max})`);
    }
  }

  const ids = [...s.waiting.map((w) => w.job.id), ...s.leases.map((l) => l.job.id)];
  if (new Set(ids).size !== ids.length) throw new Error('I6: 同じジョブが待ちとリースに同時に居る');
}
