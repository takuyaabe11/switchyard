// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { estimate, EstimateBook } from '../../src/core/estimate.mjs';

describe('estimate', () => {
  it('3 回未満なら見込みなし', () => {
    assert.equal(estimate([]), null);
    assert.equal(estimate([100, 200]), null);
  });

  it('奇数個なら中央の値', () => {
    assert.equal(estimate([300, 100, 200]), 200);
  });

  it('偶数個なら中央 2 つの平均', () => {
    assert.equal(estimate([100, 400, 200, 300]), 250);
  });

  it('直近 10 回だけを使う', () => {
    // 古い 11 回が 1、新しい 10 回が 1000。古い値が混ざれば中央値は 1000 にならない
    const old = Array(11).fill(1);
    const recent = Array(10).fill(1000);
    assert.equal(estimate([...old, ...recent]), 1000);
    // 11 個のうち直近 10 個は [1000×4, 1×6] なので中央値は 1
    assert.equal(estimate([...Array(5).fill(1000), ...Array(6).fill(1)]), 1);
  });
});

describe('EstimateBook', () => {
  it('成功した走行だけを数える', () => {
    const book = new EstimateBook();
    book.record('/r', 'unit', 100, 0);
    book.record('/r', 'unit', 999, 1);
    book.record('/r', 'unit', 200, 0);
    book.record('/r', 'unit', 999, null);
    book.record('/r', 'unit', 300, 0);
    assert.equal(book.expected('/r', 'unit'), 200);
  });

  it('repo と profile の組ごとに分ける', () => {
    const book = new EstimateBook();
    for (const d of [10, 20, 30]) book.record('/a', 'unit', d, 0);
    for (const d of [100, 200, 300]) book.record('/b', 'unit', d, 0);
    assert.equal(book.expected('/a', 'unit'), 20);
    assert.equal(book.expected('/b', 'unit'), 200);
    assert.equal(book.expected('/a', 'e2e'), null);
  });
});
