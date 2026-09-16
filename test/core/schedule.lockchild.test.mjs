// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLockChild, schedule } from '../../src/core/schedule.mjs';
import { checkInvariants } from '../../testkit/invariants.mjs';
import { grants, job, lease, MIN, state, waiting } from '../../testkit/fixtures.mjs';

/** 鍵だけの親のリース(前景の git commit。設計 §5.2) @param {string} [id] @param {string} [session] */
const parentLease = (id = 'g', session = 's1') => lease({ id, session, class: 'quick', cpus: { min: 0, max: 0 }, locks: [`git-index:${id}`] }, { cpus: 0 });

/** 親の子の要求(pre-commit の重い走行。設計 §4.3 の 7) @param {string} id @param {Partial<import('../../src/core/types.mjs').JobSpec>} [over] */
const child = (id, over = {}) => ({ id, parent: 'g', cpus: { min: 1, max: 1 }, ...over });

describe('schedule: 鍵を持つ親の子(設計 §6.2・§6.3 の 4)', () => {
  it('isLockChild は、親のリースが今あり・鍵だけ・同じセッション・計測でないときだけ真', () => {
    const s = state({ leases: [parentLease('g'), lease({ id: 'x' }), parentLease('h', 's2')] });
    assert.equal(isLockChild(s, job(child('c'))), true);
    assert.equal(isLockChild(s, job(child('c', { parent: 'nope' }))), false);
    assert.equal(isLockChild(s, job(child('c', { parent: 'x' }))), false);
    assert.equal(isLockChild(s, job(child('c', { parent: 'h' }))), false);
    assert.equal(isLockChild(s, job(child('c', { class: 'measure' }))), false);
    assert.equal(isLockChild(s, job({ id: 'c' })), false);
  });

  it('親の子は、先に待つ batch を追い越して入場する', () => {
    // b(cpus.min 1)は、c が先に入場すれば空きを使い切られて待たされ、c が後回しなら先に入場できる。
    // 入場の順が結果の並びに出る形(レビュー Minor 1: 2026-09-16 修正の報告 1)。
    const r = schedule(
      state({ capacity: 2, leases: [parentLease(), lease({ id: 'x' }, { cpus: 1 })], waiting: [waiting({ id: 'b', cpus: { min: 1, max: 1 } }, 0), waiting(child('c'), 5 * MIN)] }),
      5 * MIN,
    );
    assert.deepEqual(grants(r.actions), [['c', 1]]);
  });

  it('容量いっぱいでも、cpus.min で入場する(容量を超えて借りる)。借りたリースは I1 の合計から除く', () => {
    const r = schedule(state({ capacity: 2, leases: [parentLease(), lease({ id: 'x', cpus: { min: 2, max: 2 } }, { cpus: 2 })], waiting: [waiting(child('c'))] }), 0);
    assert.deepEqual(grants(r.actions), [['c', 1]]);
    assert.equal(r.state.leases.find((l) => l.job.id === 'c')?.lockChild, true);
    assert.doesNotThrow(() => checkInvariants(r.state));
  });

  it('計測の走行中は入場しない(計測を汚さない)', () => {
    const r = schedule(state({ leases: [parentLease(), lease({ id: 'm', class: 'measure', cpus: { min: 1, max: 8 } }, { cpus: 8 })], waiting: [waiting(child('c'))] }), 0);
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.notes.c.reason, '計測 m の走行中は入場しない');
  });

  it('計測の入場待ち(先頭が measure)より前に入る', () => {
    const r = schedule(
      state({ leases: [parentLease(), lease({ id: 'x' }, { cpus: 1 })], waiting: [waiting({ id: 'm', class: 'measure' }, 0), waiting(child('c'), 1 * MIN)] }),
      1 * MIN,
    );
    assert.deepEqual(grants(r.actions), [['c', 1]]);
    assert.equal(r.state.notes.m.reason, '走行中 2 本の終了を待つ(計測は単独で走る)');
  });

  it('親が居ない・親が鍵だけでない・別のセッションの親なら、普通の要求として並ぶ', () => {
    const full = (/** @type {import('../../src/core/types.mjs').Lease[]} */ extra) => state({ capacity: 2, leases: [lease({ id: 'x', cpus: { min: 2, max: 2 } }, { cpus: 2 }), ...extra] });
    assert.deepEqual(grants(schedule({ ...full([]), waiting: [waiting(child('c'))] }, 0).actions), []);
    assert.deepEqual(grants(schedule({ ...full([lease({ id: 'g', cpus: { min: 1, max: 1 } }, { cpus: 1 })]), waiting: [waiting(child('c'))] }, 0).actions), []);
    assert.deepEqual(grants(schedule({ ...full([parentLease('g', 's2')]), waiting: [waiting(child('c'))] }, 0).actions), []);
  });

  it('親の子のリースには余りを配らない', () => {
    const r = schedule(state({ capacity: 4, leases: [parentLease()], waiting: [waiting(child('c', { cpus: { min: 1, max: 4 } }))] }), 0);
    assert.deepEqual(grants(r.actions), [['c', 1]]);
  });

  it('借りが返るまで、CPU を持つ普通のジョブは入場しない', () => {
    // レビュー I-2: x を cpus 1 にする(容量 2・x が 1・借り c が 1 → 空き 0)。借りを空きの計算に数えなければ
    // 空きが 1 に見えて b が入場してしまうので、この形で「借りも数える」ことを実際に検出する。
    const r = schedule(
      state({
        capacity: 2,
        leases: [parentLease(), lease({ id: 'x' }, { cpus: 1 }), lease(child('c'), { cpus: 1, lockChild: true })],
        waiting: [waiting({ id: 'b' })],
      }),
      0,
    );
    assert.deepEqual(grants(r.actions), []);
  });

  it('親の子の要求でも measure は先に入れない(計測の単独実行を崩さない)', () => {
    const r = schedule(state({ leases: [parentLease(), lease({ id: 'x' }, { cpus: 1 })], waiting: [waiting(child('c', { class: 'measure' }))] }), 0);
    assert.deepEqual(grants(r.actions), []);
  });

  it('親の子の入場では、計測の直後の優先の印を外さない', () => {
    const r = schedule(
      state({ capacity: 8, favorNonMeasure: true, leases: [parentLease(), lease({ id: 'x', cpus: { min: 8, max: 8 } }, { cpus: 8 })], waiting: [waiting(child('c'), 0), waiting({ id: 'b' }, 1 * MIN)] }),
      1 * MIN,
    );
    assert.deepEqual(grants(r.actions), [['c', 1]]);
    assert.equal(r.state.favorNonMeasure, true);
  });

  it('同じ親の 2 本目の子は借りず、普通の待ちとして並ぶ', () => {
    // レビュー I-1(オーナー決定): 親 1 つにつき借りは 1 本まで。c1 が容量いっぱい(2)を借りている状態では、
    // 同じ親の c2 は isLockChild が偽に落ち、空きから cpus.min を取れないので入場しない。
    const s = state({ capacity: 2, leases: [parentLease(), lease(child('c1'), { cpus: 2, lockChild: true })] });
    assert.equal(isLockChild(s, job(child('c2'))), false);
    const r = schedule({ ...s, waiting: [waiting(child('c2'))] }, 0);
    assert.deepEqual(grants(r.actions), []);
  });

  it('1 本目が終われば、次の子がまた借りられる', () => {
    // c1 のリースが外れた(終わった)状態では、同じ親の c2 が再び isLockChild = true で借りて入場する。
    const s = state({ capacity: 2, leases: [parentLease(), lease({ id: 'x' }, { cpus: 1 })] });
    assert.equal(isLockChild(s, job(child('c2'))), true);
    const r = schedule({ ...s, waiting: [waiting(child('c2'))] }, 0);
    assert.deepEqual(grants(r.actions), [['c2', 1]]);
  });

  it('同じ親の未着手の子が 2 本同時に待つとき、先頭へ回るのは 1 本目だけ', () => {
    // 最終レビュー再レビュー: c1・c2 はどちらもまだリースを持たず同じ回で待っている。並べ替えで
    // 親ごとに 1 本(到着が先の c1)へ絞らないと、c2 も先頭へ回ってしまい、c1 が借りた後の残り
    // 容量を、点数の高い普通のジョブ b より先に c2 が奪ってしまう(grants が [c1, c2] になり b が
    // 入場できない)。正しくは c1 が借りた後、残りの空きは b が取り、c2 はその後(入場できない)。
    const r = schedule(
      state({
        capacity: 2,
        leases: [parentLease()],
        waiting: [waiting(child('c1'), 0), waiting(child('c2'), 0), waiting({ id: 'b', class: 'quick' }, 0)],
      }),
      0,
    );
    assert.deepEqual(grants(r.actions), [['c1', 1], ['b', 1]]);
  });
});
