// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rightSize, UsageBook } from '../../src/core/usage.mjs';

const run = (/** @type {number} */ cpuMs, /** @type {number} */ cpus, over = {}) => ({ durationMs: 10_000, cpuMs, cpus, code: 0, ...over });

describe('UsageBook(CPU の使い方の実測)', () => {
  it('割り振りの半分も使わない成功が 3 回あれば、平均の使用コア数の中央値を返す', () => {
    const b = new UsageBook();
    for (const cpuMs of [8_000, 7_000, 9_000]) b.record('/r', 'p', run(cpuMs, 2));
    assert.equal(b.cores('/r', 'p'), 0.8);
    assert.equal(b.cores('/r', 'other'), null);
  });

  it('回数が足りない・短い走行・すぐ落ちた失敗・CPU 時間の無い走行は数えない', () => {
    const b = new UsageBook();
    b.record('/r', 'p', run(1_000, 2));
    b.record('/r', 'p', run(1_000, 2));
    b.record('/r', 'p', run(400, 2, { code: 1, durationMs: 4_000 }));
    b.record('/r', 'p', run(100, 2, { durationMs: 1_000 }));
    b.record('/r', 'p', run(0, 2, { cpuMs: null }));
    assert.equal(b.cores('/r', 'p'), null);
  });

  it('5 秒以上走ってから失敗した走行は数える(テストが赤い間も学ぶ)', () => {
    const b = new UsageBook();
    b.record('/r', 'p', run(8_000, 2, { code: 1 }));
    b.record('/r', 'p', run(8_000, 2, { code: 1 }));
    b.record('/r', 'p', run(8_000, 2));
    assert.equal(b.cores('/r', 'p'), 0.8);
  });

  it('割り振りを使い切る走行が多ければ縮めない(割り振りが少なかったせいで少なく測れただけかもしれない)', () => {
    const b = new UsageBook();
    for (const cpuMs of [19_000, 18_000, 19_500]) b.record('/r', 'p', run(cpuMs, 2));
    assert.equal(b.cores('/r', 'p'), null);
  });

  it('直近 10 回だけを見る', () => {
    const b = new UsageBook();
    for (let i = 0; i < 10; i += 1) b.record('/r', 'p', run(35_000, 4));
    assert.equal(b.cores('/r', 'p'), null, '使い切る走行');
    for (let i = 0; i < 10; i += 1) b.record('/r', 'p', run(5_000, 4));
    assert.equal(b.cores('/r', 'p'), 0.5);
  });
});

describe('rightSize(要求を実測に合わせて縮める)', () => {
  const job = (/** @type {Partial<{ class: string, cpus: { min: number, max: number } }>} */ over = {}) => ({ class: 'batch', cpus: { min: 2, max: 4 }, ...over });

  it('使用コア数の切り上げ(1 以上)まで、最小と最大を下げ、宣言と実測を残す', () => {
    assert.deepEqual(rightSize(job(), 0.8), { class: 'batch', cpus: { min: 1, max: 1 }, sizedFrom: { min: 2, max: 4 }, measuredCores: 0.8 });
    assert.deepEqual(rightSize(job(), 2.3).cpus, { min: 2, max: 3 });
    assert.deepEqual(rightSize(job(), 0.01).cpus, { min: 1, max: 1 });
  });

  it('宣言より上げない。見込みが無い・計測・鍵だけ(0..0)は変えない', () => {
    assert.deepEqual(rightSize(job(), 7.5), job());
    assert.deepEqual(rightSize(job(), null), job());
    assert.deepEqual(rightSize(job({ class: 'measure' }), 0.5), job({ class: 'measure' }));
    assert.deepEqual(rightSize(job({ cpus: { min: 0, max: 0 } }), 0.5), job({ cpus: { min: 0, max: 0 } }));
  });
});
