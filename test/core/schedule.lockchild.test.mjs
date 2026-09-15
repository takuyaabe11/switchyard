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
    const r = schedule(
      state({
        capacity: 2,
        leases: [parentLease(), lease({ id: 'x', cpus: { min: 2, max: 2 } }, { cpus: 2 }), lease(child('c'), { cpus: 1, lockChild: true })],
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
});
