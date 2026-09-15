// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isLockOnly, schedule } from '../../src/core/schedule.mjs';
import { grants, job, lease, MIN, state, waiting } from '../../testkit/fixtures.mjs';

/** 鍵だけのジョブ(CPU 0..0 で鍵を持つ。設計 §5.2) @param {string} id @param {string[]} [locks] @param {Partial<import('../../src/core/types.mjs').JobSpec>} [over] */
const lockOnly = (id, locks = ['g'], over = {}) => ({ id, class: /** @type {const} */ ('quick'), cpus: { min: 0, max: 0 }, locks, ...over });

describe('schedule: 鍵だけのジョブ', () => {
  it('cpus が 0..0 のジョブを鍵だけのジョブとみなす', () => {
    assert.equal(isLockOnly(job(lockOnly('g'))), true);
    assert.equal(isLockOnly(job({ cpus: { min: 1, max: 1 } })), false);
  });

  it('計測の走行中でも、鍵が空いていれば CPU 0 で入場する', () => {
    const r = schedule(state({ leases: [lease({ id: 'm', class: 'measure', cpus: { min: 1, max: 8 } }, { cpus: 8 })], waiting: [waiting(lockOnly('g'))] }), 0);
    assert.deepEqual(grants(r.actions), [['g', 0]]);
  });

  it('鍵だけのリースが走っていても、計測は単独で入場する', () => {
    const r = schedule(
      state({ capacity: 8, leases: [lease(lockOnly('g'), { cpus: 0 })], waiting: [waiting({ id: 'm', class: 'measure', cpus: { min: 1, max: 8 } })] }),
      0,
    );
    assert.deepEqual(grants(r.actions), [['m', 8]]);
  });

  it('計測の入場待ちの間も、鍵だけのジョブは入場する', () => {
    const r = schedule(
      state({ leases: [lease({ id: 'x' })], waiting: [waiting({ id: 'm', class: 'measure' }, 0), waiting(lockOnly('g'), 1 * MIN)] }),
      1 * MIN,
    );
    assert.deepEqual(grants(r.actions), [['g', 0]]);
    assert.equal(r.state.notes.m.reason, '走行中 1 本の終了を待つ(計測は単独で走る)');
  });

  it('前に居て入場できないジョブが要る鍵は、鍵だけのジョブも追い越さない', () => {
    const r = schedule(
      state({ capacity: 2, leases: [lease({ id: 'x' }, { cpus: 2 })], waiting: [waiting({ id: 'b', locks: ['g'] }, 0), waiting(lockOnly('c', ['g'], { class: 'batch' }), 1 * MIN)] }),
      1 * MIN,
    );
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.notes.c.reason, '鍵 g を先に待つジョブがいる');
  });

  it('鍵が埋まっていれば待ち、理由に保持者を出す', () => {
    const r = schedule(state({ leases: [lease({ id: 'h', locks: ['g'] })], waiting: [waiting(lockOnly('g2', ['g']))] }), 0);
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.notes.g2.reason, '鍵 g を h が保持');
  });

  it('鍵だけのジョブの入場では、計測の直後の優先の印を外さない', () => {
    const r = schedule(
      state({ favorNonMeasure: true, leases: [lease({ id: 'x' }, { cpus: 8 })], waiting: [waiting(lockOnly('g'), 0), waiting({ id: 'b' }, 1 * MIN)] }),
      1 * MIN,
    );
    assert.deepEqual(grants(r.actions), [['g', 0]]);
    assert.equal(r.state.favorNonMeasure, true);
  });
});
