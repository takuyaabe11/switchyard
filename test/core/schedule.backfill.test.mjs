// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../../src/core/schedule.mjs';
import { grants, lease, MIN, state, waiting } from '../../testkit/fixtures.mjs';

describe('schedule: 後ろ詰め', () => {
  it('先頭が入れる見込み時刻までに終わるジョブは、先に入れる', () => {
    const r = schedule(
      state({
        capacity: 4,
        leases: [lease({ id: 'x', expectedMs: 10 * MIN }, { cpus: 3 })],
        waiting: [waiting({ id: 'a', cpus: { min: 2, max: 2 } }), waiting({ id: 'b', expectedMs: 5 * MIN })],
      }),
      0,
    );
    assert.deepEqual(grants(r.actions), [['b', 1]]);
    assert.deepEqual(r.state.notes.a, { jobId: 'a', position: 1, reason: 'CPU 不足(空き 1 / 必要 2)', etaAt: 10 * MIN });
  });

  it('先頭の見込み時刻を越えるジョブは入れない', () => {
    const r = schedule(
      state({
        capacity: 4,
        leases: [lease({ id: 'x', expectedMs: 10 * MIN }, { cpus: 3 })],
        waiting: [waiting({ id: 'a', cpus: { min: 2, max: 2 } }), waiting({ id: 'b', expectedMs: 15 * MIN })],
      }),
      0,
    );
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.notes.b.reason, '先頭 a の後ろ(後ろ詰めの見込みなし)');
  });

  it('見込みの無いジョブは後ろ詰めしない', () => {
    const r = schedule(
      state({
        capacity: 4,
        leases: [lease({ id: 'x', expectedMs: 10 * MIN }, { cpus: 3 })],
        waiting: [waiting({ id: 'a', cpus: { min: 2, max: 2 } }), waiting({ id: 'b', expectedMs: null })],
      }),
      0,
    );
    assert.deepEqual(grants(r.actions), []);
  });

  it('先頭が必要な資源を持つジョブに見込みが無ければ、後ろ詰めしない', () => {
    const r = schedule(
      state({
        capacity: 4,
        leases: [lease({ id: 'x', expectedMs: null }, { cpus: 3 })],
        waiting: [waiting({ id: 'a', cpus: { min: 2, max: 2 } }), waiting({ id: 'b', expectedMs: 1 * MIN })],
      }),
      0,
    );
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.notes.a.etaAt, null);
  });

  it('鍵の空く見込み時刻も数える', () => {
    const r = schedule(
      state({
        leases: [lease({ id: 'x', locks: ['p'], expectedMs: 10 * MIN })],
        waiting: [waiting({ id: 'a', locks: ['p'] }), waiting({ id: 'b', expectedMs: 5 * MIN }), waiting({ id: 'c', expectedMs: 20 * MIN })],
      }),
      0,
    );
    assert.deepEqual(grants(r.actions), [['b', 1]]);
    assert.equal(r.state.notes.a.etaAt, 10 * MIN);
    assert.equal(r.state.notes.c.reason, '先頭 a の後ろ(後ろ詰めの見込みなし)');
  });
});
