// @ts-check
// 重なりによる遅れを profile ごとに学ぶ(src/core/contention.mjs)と、遅くならない profile を待たせない入場(schedule.mjs)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContentionBook,
  CONTENTION_WINDOW,
  isTolerant,
  otherLoadOf,
  overlapOf,
  slowdownOf,
} from '../../src/core/contention.mjs';
import { schedule } from '../../src/core/schedule.mjs';
import { loadContention } from '../../src/daemon/store.mjs';
import { grants, lease, state, waiting } from '../../testkit/fixtures.mjs';

describe('otherLoadOf(走行の間に他の処理が使っていたコア数)', () => {
  it('機械の忙しさの時間平均から、この走行自身の平均の使用コア数を引く(0 未満は 0)', () => {
    // 10 秒のうち 8 秒を測れ、機械は平均 3 コア忙しかった。自分は平均 1.2 コア
    assert.equal(otherLoadOf({ busyCoreMs: 24_000, coveredMs: 8_000, durationMs: 10_000, cpuMs: 12_000 }), 1.8);
    assert.equal(otherLoadOf({ busyCoreMs: 8_000, coveredMs: 8_000, durationMs: 10_000, cpuMs: 20_000 }), 0);
  });

  it('CPU 時間が分からない・5 秒未満の走行・測れた時間が所要の半分未満なら null', () => {
    const run = { busyCoreMs: 24_000, coveredMs: 8_000, durationMs: 10_000, cpuMs: 12_000 };
    assert.equal(otherLoadOf({ ...run, cpuMs: null }), null);
    assert.equal(otherLoadOf({ ...run, durationMs: 4_999, coveredMs: 4_000 }), null);
    assert.notEqual(otherLoadOf({ ...run, durationMs: 5_000, coveredMs: 4_000 }), null);
    assert.equal(otherLoadOf({ ...run, coveredMs: 4_999 }), null);
    assert.notEqual(otherLoadOf({ ...run, coveredMs: 5_000, busyCoreMs: 15_000 }), null);
    assert.equal(otherLoadOf({ ...run, coveredMs: 0, busyCoreMs: 0 }), null);
  });
});

describe('overlapOf(静か・重なった・その間)', () => {
  it('静か: 他の処理が機械のコア数の 1 割未満(最低 0.5 コア)', () => {
    assert.deepEqual([0, 0.49, 0.5].map((x) => overlapOf(x, 0, 2)), ['alone', 'alone', 'partial']);
    assert.deepEqual([1.59, 1.6].map((x) => overlapOf(x, 20, 16)), ['alone', 'partial']);
  });

  it('重なった: 他の処理が 4 分の 1 以上(最低 1 コア)で、自分と合わせて機械のコア数の 9 割以上', () => {
    // 実測: 4 コアを使い切る仕事の横で 4 コアを回すと、他の処理は約 2 コア・自分も約 2 コア
    assert.equal(overlapOf(1.99, 2.01, 4), 'contended');
    // 待つだけの仕事の横で 4 コアを回す
    assert.equal(overlapOf(3.95, 0, 4), 'contended');
    // 機械が埋まっていなければ、他の処理が多くても重なったとはみなさない
    assert.equal(overlapOf(2, 1.59, 4), 'partial');
    assert.equal(overlapOf(2, 1.6, 4), 'contended');
    // 他の処理が 4 分の 1 未満なら、機械が埋まっていても重なったとはみなさない
    assert.deepEqual([3.99, 4].map((x) => overlapOf(x, 16, 16)), ['partial', 'contended']);
    // 1 コアの機械: 4 分の 1 は 0.25 コアだが、重なったとみなすのは 1 コアから
    assert.deepEqual([0.49, 0.7, 1].map((x) => overlapOf(x, 1, 1)), ['alone', 'partial', 'contended']);
  });
});

describe('slowdownOf と ContentionBook(遅れの倍率)', () => {
  const runs = (/** @type {'alone' | 'contended' | 'partial'} */ overlap, /** @type {number[]} */ ds) => ds.map((durationMs) => ({ durationMs, overlap }));

  it('重なった走行の所要の中央値 / 静かだった走行の所要の中央値。その間の走行は数えない', () => {
    // 平均なら 70/30 = 2.33 だが、中央値なら 60/20 = 3
    assert.deepEqual(slowdownOf([...runs('alone', [10, 20, 60]), ...runs('contended', [50, 60, 100]), ...runs('partial', [1000])]), { slowdown: 3, alone: 3, contended: 3 });
    // 偶数の回数は、真ん中 2 つの平均
    assert.equal(slowdownOf([...runs('alone', [10, 20, 30, 40]), ...runs('contended', [30, 30, 30])])?.slowdown, 1.2);
  });

  it('静かだった走行と重なった走行が、それぞれ 3 本ずつ無ければ null', () => {
    assert.equal(slowdownOf([...runs('alone', [10, 10]), ...runs('contended', [20, 20, 20])]), null);
    assert.equal(slowdownOf([...runs('alone', [10, 10, 10]), ...runs('contended', [20, 20]), ...runs('partial', [20])]), null);
  });

  it('帳簿は成功した・5 秒以上の・重なりの分かる走行だけを、直近 20 本まで覚える', () => {
    const book = new ContentionBook();
    for (let i = 0; i < 3; i += 1) {
      book.record('/r', 'unit', { durationMs: 10_000, code: 0, overlap: 'alone' });
      book.record('/r', 'unit', { durationMs: 12_000, code: 0, overlap: 'contended' });
      book.record('/r', 'unit', { durationMs: 99_000, code: 1, overlap: 'contended' });
      book.record('/r', 'unit', { durationMs: 99_000, code: 0, overlap: null });
      book.record('/r', 'unit', { durationMs: 4_999, code: 0, overlap: 'alone' });
    }
    assert.equal(book.slowdown('/r', 'unit'), 1.2);
    assert.equal(book.slowdown('/r', 'e2e'), null);
    assert.deepEqual(book.learnedAll(), { [JSON.stringify(['/r', 'unit'])]: { slowdown: 1.2, alone: 3, contended: 3 } });
    // 古い走行は窓から落ちる(新しい 20 本はみな重なった走行なので、静かな走行が足りなくなる)
    for (let i = 0; i < CONTENTION_WINDOW; i += 1) book.record('/r', 'unit', { durationMs: 20_000, code: 0, overlap: 'contended' });
    assert.equal(book.slowdown('/r', 'unit'), null);
    assert.deepEqual(book.learnedAll(), {});
  });

  it('記録の history 行から帳簿を作る(worktree の一族で学ぶ・overlap の無い行や壊れた値は数えない)', () => {
    const row = (/** @type {Record<string, unknown>} */ over) => ({ kind: 'history', repo: '/w/a', family: '/w/main', profile: 'unit', durationMs: 10_000, code: 0, ...over });
    const records = [
      ...[0, 1, 2].map(() => row({ overlap: 'alone' })),
      ...[0, 1, 2].map(() => row({ overlap: 'contended', durationMs: 20_000 })),
      row({ overlap: 'weird', durationMs: 1 }),
      row({ overlap: undefined, durationMs: 1 }),
      { kind: 'event', overlap: 'alone' },
    ];
    const book = loadContention(records);
    assert.equal(book.slowdown('/w/main', 'unit'), 2);
    assert.equal(book.slowdown('/w/a', 'unit'), null);
    const noFamily = loadContention(records.map((r) => ({ ...r, family: undefined })));
    assert.equal(noFamily.slowdown('/w/a', 'unit'), 2);
  });

  it('isTolerant: 倍率が 1.15 以下なら重なっても遅くならない', () => {
    assert.deepEqual([1, 1.15, 1.16, undefined, null].map((slowdown) => isTolerant({ slowdown })), [true, true, false, false, false]);
  });
});

describe('schedule: 重なっても遅くならないと学んだジョブは待たせない', () => {
  const calm = { slowdown: 1.05 };
  /** 容量 4 を 1 本が使い切っている盤面 @param {Partial<import('../../src/core/types.mjs').JobSpec>} running @param {import('../../testkit/fixtures.mjs').Waiting[]} w */
  const full = (running, w, over = {}) => state({ capacity: 4, leases: [lease({ id: 'x', ...running }, { cpus: 4 })], waiting: w, ...over });

  it('走っている相手もみな遅くならないなら、CPU の空きが足りなくても min で入れ、印を付ける', () => {
    const r = schedule(full(calm, [waiting({ id: 'a', cpus: { min: 2, max: 4 }, ...calm })]), 0);
    assert.deepEqual(r.actions.filter((a) => a.type === 'grant'), [{ type: 'grant', jobId: 'a', cpus: 2, tolerant: true }]);
    assert.equal(r.state.leases.find((l) => l.job.id === 'a')?.tolerant, true);
  });

  it('相手が遅くなる走行・学べていない走行なら入れない(重ねると相手を遅らせる)', () => {
    for (const running of [{}, { slowdown: 1.5 }]) {
      const r = schedule(full(running, [waiting({ id: 'a', ...calm })]), 0);
      assert.deepEqual(grants(r.actions), [], JSON.stringify(running));
    }
  });

  it('自分が遅くなる・学べていないなら入れない', () => {
    for (const over of [{}, { slowdown: 1.16 }]) {
      const r = schedule(full(calm, [waiting({ id: 'a', ...over })]), 0);
      assert.deepEqual(grants(r.actions), [], JSON.stringify(over));
    }
  });

  it('容量の 2 倍まで。鍵とメモリの下限は守る。計測の走行中は入れない', () => {
    const twice = schedule(full(calm, [waiting({ id: 'a', cpus: { min: 4, max: 4 }, ...calm }, 0), waiting({ id: 'b', ...calm }, 1)]), 10);
    assert.deepEqual(grants(twice.actions), [['a', 4]], '4 + 4 = 8 までは入り、次の 1 は超えるので入らない');
    const locked = schedule(full({ ...calm, locks: ['port:3000'] }, [waiting({ id: 'a', locks: ['port:3000'], ...calm })]), 0);
    assert.deepEqual(grants(locked.actions), []);
    const mem = schedule(full(calm, [waiting({ id: 'a', memMb: 900, ...calm })]), 0, { memory: { availableMb: 1000, floorMb: 200 } });
    assert.deepEqual(grants(mem.actions), []);
    const measuring = schedule(full({ ...calm, class: 'measure' }, [waiting({ id: 'a', ...calm })]), 0);
    assert.deepEqual(grants(measuring.actions), []);
  });

  it('先頭が待っている間は、後ろの遅くならないジョブも入れない(先頭をさらに遅らせない)', () => {
    const r = schedule(full(calm, [waiting({ id: 'h', cpus: { min: 2, max: 2 } }, 0), waiting({ id: 'a', ...calm }, 1)]), 10);
    assert.deepEqual(grants(r.actions), []);
  });
});
