// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../../src/core/decide.mjs';
import { rebaseForRecovery } from '../../src/core/recovery.mjs';
import { grants, lease, state, waiting } from '../../testkit/fixtures.mjs';

describe('rebaseForRecovery', () => {
  it('時刻を今に付け替え、包みの再接続を待つ印を付け、notes を捨てる', () => {
    const s = state({
      waiting: [waiting({ id: 'a' }, 123)],
      leases: [lease({ id: 'b' }, { grantedAt: 456 }), lease({ id: 'c' }, { grantedAt: 789, phase: 'orphan' })],
      notes: { a: { jobId: 'a', position: 1, reason: 'x', etaAt: null } },
    });
    const r = rebaseForRecovery(s, 1000);
    assert.deepEqual(r.waiting.map((w) => [w.arrivedAt, w.recovering]), [[1000, true]]);
    assert.deepEqual(r.leases.map((l) => [l.job.id, l.grantedAt, l.recovering]), [['b', 1000, true], ['c', 1000, false]]);
    assert.deepEqual(r.notes, {});
  });

  it('復旧待ちのリースは資源を持ったまま(再接続を待つ間に二重に貸さない)', () => {
    const s = rebaseForRecovery(state({ leases: [lease({ id: 'b', locks: ['p'] })], waiting: [waiting({ id: 'a', locks: ['p'] })] }), 0);
    const r = decide(s, { type: 'resume', now: 0, jobId: 'a', pid: null, pgid: null });
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.notes.a.reason, '鍵 p を b が保持');
  });
});
