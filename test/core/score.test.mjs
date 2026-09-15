// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { score, sortWaiting } from '../../src/core/score.mjs';
import { MIN, waiting } from '../../testkit/fixtures.mjs';

describe('score', () => {
  it('種別の基礎点: quick 30 / batch 0 / measure 0', () => {
    assert.equal(score(waiting({ class: 'quick' }), 0), 30);
    assert.equal(score(waiting({ class: 'batch' }), 0), 0);
    assert.equal(score(waiting({ class: 'measure' }), 0), 0);
  });

  it('待った 1 分ごとに +1', () => {
    assert.equal(score(waiting({}, 0), 7 * MIN), 7);
  });

  it('見込み 1 分ごとに −0.5、上限は 30 分ぶん', () => {
    assert.equal(score(waiting({ expectedMs: 10 * MIN }), 0), -5);
    assert.equal(score(waiting({ expectedMs: 90 * MIN }), 0), -15);
  });

  it('見込みが無ければ減点しない', () => {
    assert.equal(score(waiting({ expectedMs: null }), 0), 0);
  });

  it('now が到着より前でも、待った時間は負にならない', () => {
    assert.equal(score(waiting({}, 5 * MIN), 0), 0);
  });
});

describe('sortWaiting', () => {
  it('点数の高い順に並べる', () => {
    const slow = waiting({ id: 'slow', expectedMs: 20 * MIN }, 0);
    const quick = waiting({ id: 'quick', class: 'quick' }, 0);
    const plain = waiting({ id: 'plain' }, 0);
    assert.deepEqual(sortWaiting([slow, plain, quick], 0).map((w) => w.job.id), ['quick', 'plain', 'slow']);
  });

  it('同点なら到着の早い順', () => {
    // now = 2 分: early は 2 − 1 = 1 点、late は 1 − 0 = 1 点
    const early = waiting({ id: 'early', expectedMs: 2 * MIN }, 0);
    const late = waiting({ id: 'late', expectedMs: null }, 1 * MIN);
    assert.deepEqual(sortWaiting([late, early], 2 * MIN).map((w) => w.job.id), ['early', 'late']);
  });

  it('点数も到着も同じなら id 順', () => {
    const b = waiting({ id: 'b' }, 0);
    const a = waiting({ id: 'a' }, 0);
    assert.deepEqual(sortWaiting([b, a], 0).map((w) => w.job.id), ['a', 'b']);
  });

  it('元の配列を書き換えない', () => {
    const list = [waiting({ id: 'b' }), waiting({ id: 'a' })];
    sortWaiting(list, 0);
    assert.deepEqual(list.map((w) => w.job.id), ['b', 'a']);
  });
});
