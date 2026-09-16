// @ts-check
// 計測が先頭に立ったとき、走行中のジョブを宣言どおり止める / 降格する(設計 §6.7)。
// 止めたリースは容量にも I3 にも数えないので、計測は残りが空けば入場できる。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../../src/core/schedule.mjs';
import { checkInvariants } from '../../testkit/invariants.mjs';
import { grants, lease, state, waiting } from '../../testkit/fixtures.mjs';

/** @typedef {import('../../src/core/types.mjs').Action} Action */

/** hold / unhold の処置だけを取り出す @param {Action[]} actions */
const holds = (actions) => actions.filter((a) => a.type === 'hold' || a.type === 'unhold').map((a) => (a.type === 'hold' ? [a.jobId, a.mode] : [a.jobId, 'unhold']));

describe('preempt(計測が先頭のときだけ発動。設計 §6.7)', () => {
  it('既定(never)のジョブは止めない。計測はこれまでどおり終わるのを待つ', () => {
    const s = state({
      capacity: 4,
      leases: [lease({ id: 'run', preempt: 'never', cpus: { min: 4, max: 4 } }, { cpus: 4 })],
      waiting: [waiting({ id: 'm', class: 'measure', cpus: { min: 1, max: 4 } })],
    });
    const r = schedule(s, 0);
    assert.deepEqual(holds(r.actions), []);
    assert.deepEqual(grants(r.actions), []);
    assert.match(r.state.notes.m.reason, /走行中/);
  });

  it('pause を宣言したジョブは止め、計測はその回に入場する', () => {
    const s = state({
      capacity: 4,
      leases: [lease({ id: 'run', preempt: 'pause', cpus: { min: 4, max: 4 } }, { cpus: 4 })],
      waiting: [waiting({ id: 'm', class: 'measure', cpus: { min: 1, max: 4 } })],
    });
    const r = schedule(s, 0);
    assert.deepEqual(holds(r.actions), [['run', 'pause']]);
    assert.deepEqual(grants(r.actions), [['m', 4]], '止めたぶんの CPU は計測へ回る');
    assert.equal(r.state.leases.find((l) => l.job.id === 'run')?.held, 'pause');
    checkInvariants(r.state);
  });

  it('throttle も同じく止めた扱いにする(走り続けるが、計測の入場を妨げない)', () => {
    const s = state({
      capacity: 4,
      leases: [lease({ id: 'run', preempt: 'throttle', cpus: { min: 2, max: 2 } }, { cpus: 2 })],
      waiting: [waiting({ id: 'm', class: 'measure', cpus: { min: 1, max: 4 } })],
    });
    const r = schedule(s, 0);
    assert.deepEqual(holds(r.actions), [['run', 'throttle']]);
    assert.deepEqual(grants(r.actions), [['m', 4]]);
    checkInvariants(r.state);
  });

  it('計測と同じ鍵を持つジョブは止めない(止めると鍵が返らず、計測が永久に入れない)', () => {
    const s = state({
      capacity: 4,
      leases: [lease({ id: 'run', preempt: 'pause', locks: ['port:4173'], cpus: { min: 2, max: 2 } }, { cpus: 2 })],
      waiting: [waiting({ id: 'm', class: 'measure', locks: ['port:4173'], cpus: { min: 1, max: 4 } })],
    });
    const r = schedule(s, 0);
    assert.deepEqual(holds(r.actions), []);
    assert.deepEqual(grants(r.actions), []);
  });

  it('止めるのは CPU を持つリースだけ(鍵だけのジョブは計測と並んでよい)', () => {
    const s = state({
      capacity: 4,
      leases: [lease({ id: 'lockonly', preempt: 'pause', cpus: { min: 0, max: 0 }, locks: ['k'] }, { cpus: 0 })],
      waiting: [waiting({ id: 'm', class: 'measure', cpus: { min: 1, max: 4 } })],
    });
    const r = schedule(s, 0);
    assert.deepEqual(holds(r.actions), []);
    assert.deepEqual(grants(r.actions), [['m', 4]]);
  });

  it('計測が待ち列から消えたら、止めたものを戻す', () => {
    const s = state({
      capacity: 4,
      leases: [lease({ id: 'run', preempt: 'pause' }, { cpus: 1, held: 'pause' })],
      waiting: [],
    });
    const r = schedule(s, 0);
    assert.deepEqual(holds(r.actions), [['run', 'unhold']]);
    assert.equal(r.state.leases.find((l) => l.job.id === 'run')?.held, undefined);
  });

  it('同じ回に 2 度は出さない(状態が変わったときだけ処置を出す)', () => {
    const s = state({
      capacity: 4,
      leases: [lease({ id: 'run', preempt: 'pause', cpus: { min: 4, max: 4 } }, { cpus: 4, held: 'pause' })],
      waiting: [waiting({ id: 'm', class: 'measure', cpus: { min: 1, max: 4 } })],
    });
    const r = schedule(s, 0);
    assert.deepEqual(holds(r.actions), [], '既に止まっているので何も出さない');
    assert.deepEqual(grants(r.actions), [['m', 4]]);
  });

  it('計測でない先頭では発動しない(容量が足りないだけでは止めない)', () => {
    const s = state({
      capacity: 2,
      leases: [lease({ id: 'run', preempt: 'pause', cpus: { min: 2, max: 2 } }, { cpus: 2 })],
      waiting: [waiting({ id: 'b', class: 'batch', cpus: { min: 2, max: 2 } })],
    });
    const r = schedule(s, 0);
    assert.deepEqual(holds(r.actions), []);
    assert.deepEqual(grants(r.actions), []);
  });

  it('走行中の計測があるときは、新しく止めない', () => {
    const s = state({
      capacity: 4,
      leases: [lease({ id: 'm1', class: 'measure' }, { cpus: 4 }), lease({ id: 'run', preempt: 'pause' }, { cpus: 0 })],
      waiting: [waiting({ id: 'm2', class: 'measure' })],
    });
    const r = schedule(s, 0);
    assert.deepEqual(holds(r.actions), []);
  });
});
