// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../../src/core/schedule.mjs';
import { grants, lease, MIN, state, waiting } from '../../testkit/fixtures.mjs';

describe('schedule: 計測', () => {
  it('走行中のジョブがあれば計測は待ち、後ろのジョブも入場しない', () => {
    const r = schedule(
      state({
        leases: [lease({ id: 'x' })],
        waiting: [waiting({ id: 'm', class: 'measure', cpus: { min: 1, max: 8 } }, 0), waiting({ id: 'b' }, 1 * MIN)],
      }),
      1 * MIN,
    );
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.notes.m.reason, '走行中 1 本の終了を待つ(計測は単独で走る)');
    assert.equal(r.state.notes.b.reason, '計測 m の入場待ちのため入場しない');
  });

  it('何も走っていなければ計測は空き全部で入場し、その後ろは入場しない', () => {
    const r = schedule(
      state({ capacity: 8, waiting: [waiting({ id: 'm', class: 'measure', cpus: { min: 1, max: 1000 } }, 0), waiting({ id: 'b' }, 1 * MIN)] }),
      1 * MIN,
    );
    assert.deepEqual(grants(r.actions), [['m', 8]]);
    assert.equal(r.state.notes.b.reason, '計測 m の走行中は入場しない');
  });

  it('計測の走行中は何も入場させない', () => {
    const r = schedule(state({ leases: [lease({ id: 'm', class: 'measure' })], waiting: [waiting({ id: 'q', class: 'quick' })] }), 0);
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.notes.q.reason, '計測 m の走行中は入場しない');
  });

  it('先頭が入場できなければ、計測は後ろ詰めしない', () => {
    const r = schedule(
      state({
        capacity: 4,
        leases: [lease({ id: 'x', expectedMs: 10 * MIN }, { cpus: 3 })],
        waiting: [waiting({ id: 'q', class: 'quick', cpus: { min: 2, max: 2 } }), waiting({ id: 'm', class: 'measure', expectedMs: 1 * MIN })],
      }),
      0,
    );
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.notes.m.reason, '先頭 q の後ろ(計測は後ろ詰めしない)');
  });

  it('計測の直後は、一番長く待っている計測以外のジョブを先に入れる', () => {
    const r = schedule(
      state({
        favorNonMeasure: true,
        waiting: [waiting({ id: 'm2', class: 'measure' }, 0), waiting({ id: 'b1' }, 2 * MIN), waiting({ id: 'b0' }, 1 * MIN)],
      }),
      3 * MIN,
    );
    assert.deepEqual(grants(r.actions), [['b0', 1]]);
    assert.equal(r.state.favorNonMeasure, false);
    assert.equal(r.state.notes.m2.reason, '走行中 1 本の終了を待つ(計測は単独で走る)');
    assert.equal(r.state.notes.b1.reason, '計測 m2 の入場待ちのため入場しない');
  });

  it('計測以外が待っていなければ、印を外して計測を入れる', () => {
    const r = schedule(state({ favorNonMeasure: true, waiting: [waiting({ id: 'm2', class: 'measure', cpus: { min: 1, max: 8 } })] }), 0);
    assert.deepEqual(grants(r.actions), [['m2', 8]]);
    assert.equal(r.state.favorNonMeasure, false);
  });
});
