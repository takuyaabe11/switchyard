// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../../src/core/schedule.mjs';
import { grants, lease, state, waiting } from '../../testkit/fixtures.mjs';

describe('schedule: CPU と鍵', () => {
  it('空きがあれば min で入場させ、余りを max まで配る', () => {
    const r = schedule(state({ capacity: 8, waiting: [waiting({ id: 'a', cpus: { min: 2, max: 6 } })] }), 0);
    assert.deepEqual(grants(r.actions), [['a', 6]]);
    assert.equal(r.state.waiting.length, 0);
    assert.equal(r.state.leases[0].phase, 'granted');
  });

  it('余りは点数の高い順に配る', () => {
    const r = schedule(
      state({
        capacity: 8,
        waiting: [waiting({ id: 'b', cpus: { min: 2, max: 6 } }), waiting({ id: 'a', class: 'quick', cpus: { min: 2, max: 6 } })],
      }),
      0,
    );
    assert.deepEqual(grants(r.actions), [['a', 6], ['b', 2]]);
  });

  it('CPU が足りなければ待たせ、理由を付ける', () => {
    const r = schedule(
      state({ capacity: 4, leases: [lease({ id: 'x' }, { cpus: 3 })], waiting: [waiting({ id: 'a', cpus: { min: 2, max: 2 } })] }),
      0,
    );
    assert.deepEqual(r.actions, [{ type: 'queued', jobId: 'a', position: 1, reason: 'CPU 不足(空き 1 / 必要 2)', etaAt: null }]);
  });

  it('鍵が埋まっていれば待たせる', () => {
    const r = schedule(state({ leases: [lease({ id: 'x', locks: ['port:4173'] })], waiting: [waiting({ id: 'a', locks: ['port:4173'] })] }), 0);
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.notes.a.reason, '鍵 port:4173 を x が保持');
  });

  it('鍵の容量が 2 なら 2 本目まで入れる', () => {
    const r = schedule(state({ lockCaps: { gpu: 2 }, leases: [lease({ id: 'x', locks: ['gpu'] })], waiting: [waiting({ id: 'a', locks: ['gpu'] })] }), 0);
    assert.deepEqual(grants(r.actions), [['a', 1]]);
  });

  it('入場を待つ間に、他の鍵を抱え込まない(一括取得)', () => {
    const r = schedule(state({ leases: [lease({ id: 'x', locks: ['q'] })], waiting: [waiting({ id: 'a', locks: ['p', 'q'] })] }), 0);
    assert.deepEqual(r.state.leases.map((l) => l.job.id), ['x']);
    assert.equal(r.state.notes.a.reason, '鍵 q を x が保持');
  });

  it('復旧待ちのジョブは入場させない', () => {
    const r = schedule(state({ waiting: [{ ...waiting({ id: 'a' }), recovering: true }] }), 0);
    assert.deepEqual(r.actions, []);
    assert.equal(r.state.waiting.length, 1);
  });

  it('理由が前回と同じなら queued を出し直さない', () => {
    const first = schedule(state({ capacity: 1, leases: [lease({ id: 'x' })], waiting: [waiting({ id: 'a' })] }), 0);
    assert.equal(first.actions.length, 1);
    assert.deepEqual(schedule(first.state, 0).actions, []);
  });

  it('入力の状態を書き換えない', () => {
    const input = state({ waiting: [waiting({ id: 'a', cpus: { min: 1, max: 4 } })] });
    const before = structuredClone(input);
    schedule(input, 0);
    assert.deepEqual(input, before);
  });
});
