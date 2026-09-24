// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampJob, decide, initialState } from '../../src/core/decide.mjs';
import { grants, job, lease, MIN, state, waiting } from '../../testkit/fixtures.mjs';

describe('decide: request', () => {
  it('待ち列に入れ、その場で入場を判断する', () => {
    const r = decide(initialState({ capacity: 8 }), { type: 'request', now: 0, job: job({ id: 'a', cpus: { min: 2, max: 4 } }) });
    assert.deepEqual(grants(r.actions), [['a', 4]]);
  });

  it('cpus を 1..容量 に収める', () => {
    assert.deepEqual(clampJob(job({ cpus: { min: 16, max: 32 } }), 8).cpus, { min: 8, max: 8 });
    assert.deepEqual(clampJob(job({ cpus: { min: 0, max: 0 } }), 8).cpus, { min: 1, max: 1 });
    const r = decide(initialState({ capacity: 8 }), { type: 'request', now: 0, job: job({ id: 'a', cpus: { min: 16, max: 32 } }) });
    assert.deepEqual(grants(r.actions), [['a', 8]]);
  });

  it('鍵だけのジョブ(0..0 と鍵)は CPU 0 のまま入場する', () => {
    assert.deepEqual(clampJob(job({ cpus: { min: 0, max: 0 }, locks: ['g', 'g'] }), 8), job({ cpus: { min: 0, max: 0 }, locks: ['g'] }));
    const r = decide(initialState({ capacity: 8 }), { type: 'request', now: 0, job: job({ id: 'g', class: 'quick', cpus: { min: 0, max: 0 }, locks: ['g'] }) });
    assert.deepEqual(grants(r.actions), [['g', 0]]);
  });

  it('鍵の重複を除く', () => {
    assert.deepEqual(clampJob(job({ locks: ['p', 'q', 'p'] }), 8).locks, ['p', 'q']);
    const r = decide(initialState({ capacity: 8 }), { type: 'request', now: 0, job: job({ id: 'a', locks: ['p', 'p'] }) });
    assert.deepEqual(grants(r.actions), [['a', 1]]);
  });

  it('同じ id の要求は二重に入れない', () => {
    const r = decide(state({ leases: [lease({ id: 'a' })] }), { type: 'request', now: 0, job: job({ id: 'a' }) });
    assert.equal(r.state.leases.length, 1);
    assert.equal(r.state.waiting.length, 0);
  });
});

describe('decide: 走行と終了', () => {
  it('started で pid と pgid を記録し running にする', () => {
    const r = decide(state({ leases: [lease({ id: 'a' }, { phase: 'granted' })] }), { type: 'started', now: 0, jobId: 'a', pid: 100, pgid: 100 });
    const l = r.state.leases[0];
    assert.deepEqual([l.phase, l.pid, l.pgid], ['running', 100, 100]);
  });

  it('exit 0 でリースを返し、所要を history に出し、空いた資源で次を入れる', () => {
    const s = state({ capacity: 1, leases: [lease({ id: 'a', repo: '/r', profile: 'unit' })], waiting: [waiting({ id: 'b' })] });
    const r = decide(s, { type: 'exit', now: 5, jobId: 'a', code: 0, killedByCaller: false, durationMs: 1234 });
    assert.deepEqual(r.actions, [
      { type: 'history', repo: '/r', profile: 'unit', class: 'batch', cpus: 1, durationMs: 1234, code: 0, cpuMs: null },
      { type: 'grant', jobId: 'b', cpus: 1 },
    ]);
    assert.deepEqual(r.state.unacked, {});
  });

  it('失敗した終了は、持ち主のセッションの未確認に積む', () => {
    const s = state({ leases: [lease({ id: 'a', session: 's1', cmd: 'npm test' })] });
    const r = decide(s, { type: 'exit', now: 0, jobId: 'a', code: 1, killedByCaller: false, durationMs: 1 });
    assert.deepEqual(r.state.unacked, { s1: [{ jobId: 'a', kind: 'failed', code: 1, cmd: 'npm test', repo: '/repo', profile: 'p' }] });
  });

  it('呼び出し元に殺された終了は killed として積む', () => {
    const s = state({ leases: [lease({ id: 'a', session: 's1', cmd: 'npm test' })] });
    const r = decide(s, { type: 'exit', now: 0, jobId: 'a', code: 143, killedByCaller: true, durationMs: 1 });
    assert.deepEqual(r.state.unacked, { s1: [{ jobId: 'a', kind: 'killed', code: 143, cmd: 'npm test', repo: '/repo', profile: 'p' }] });
  });

  it('同じセッションで同じ走行が後で成功したら、前の失敗・呼び出し元の終了を確認済みにする(orphan と他の走行は残す)', () => {
    const f = (/** @type {string} */ id, /** @type {any} */ kind, /** @type {Partial<import('../../src/core/types.mjs').Unacked>} */ over = {}) => ({ jobId: id, kind, code: 1, cmd: 'npm test', repo: '/repo', profile: 'p', ...over });
    const s = state({
      leases: [lease({ id: 'ok', session: 's1', cmd: 'npm test' })],
      unacked: {
        s1: [f('a', 'failed'), f('b', 'killed'), f('c', 'orphan'), f('d', 'failed', { profile: 'e2e' }), f('e', 'failed', { repo: '/other' }), { jobId: 'old', kind: 'failed', code: 1, cmd: 'npm test' }],
        s2: [f('x', 'failed')],
      },
    });
    const r = decide(s, { type: 'exit', now: 0, jobId: 'ok', code: 0, killedByCaller: false, durationMs: 1 });
    assert.deepEqual(r.state.unacked.s1.map((u) => u.jobId), ['c', 'd', 'e', 'old'], 'orphan・別の profile・別の repo・手がかりの無い古い記録は残す');
    assert.deepEqual(r.state.unacked.s2.map((u) => u.jobId), ['x'], '他のセッションは触らない');
  });

  it('分類されなかった走行(cmd:…)は、同じコマンド文字列の成功でだけ確認済みにする', () => {
    const u = (/** @type {string} */ id, /** @type {string} */ cmd) => ({ jobId: id, kind: /** @type {const} */ ('failed'), code: 1, cmd, repo: '/repo', profile: 'cmd:sh -c' });
    const s = state({ leases: [lease({ id: 'ok', profile: 'cmd:sh -c', cmd: 'sh -c B' })], unacked: { s1: [u('a', 'sh -c A'), u('b', 'sh -c B')] } });
    const r = decide(s, { type: 'exit', now: 0, jobId: 'ok', code: 0, killedByCaller: false, durationMs: 1 });
    assert.deepEqual(r.state.unacked.s1.map((x) => x.jobId), ['a']);
  });

  it('管理なしで走った成功も、同じ走行の前の失敗を確認済みにする。最後の 1 件ならセッションの欄ごと消す', () => {
    const s = state({ unacked: { s1: [{ jobId: 'a', kind: 'failed', code: 1, cmd: 'npm test', repo: '/repo', profile: 'p' }] } });
    const r = decide(s, { type: 'unmanagedExit', now: 0, session: 's1', jobId: 'u1', code: 0, cmd: 'npm test', repo: '/repo', profile: 'p' });
    assert.deepEqual(r.state.unacked, {});
    const failed = decide(state(), { type: 'unmanagedExit', now: 0, session: 's1', jobId: 'u2', code: 2, cmd: 'npm test', repo: '/repo', profile: 'p' });
    assert.deepEqual(failed.state.unacked, { s1: [{ jobId: 'u2', kind: 'failed', code: 2, cmd: 'npm test', repo: '/repo', profile: 'p' }] });
  });

  it('計測が終わったら、計測以外を先に入れる', () => {
    const s = state({ leases: [lease({ id: 'm', class: 'measure' })], waiting: [waiting({ id: 'm2', class: 'measure' }, 0), waiting({ id: 'b' }, 1 * MIN)] });
    const r = decide(s, { type: 'exit', now: 2 * MIN, jobId: 'm', code: 0, killedByCaller: false, durationMs: 1 });
    assert.deepEqual(grants(r.actions), [['b', 1]]);
  });

  it('入場前に包みが終わったら、待ち列から外すだけ', () => {
    const s = state({ capacity: 1, leases: [lease({ id: 'x' })], waiting: [waiting({ id: 'a' })] });
    const r = decide(s, { type: 'exit', now: 0, jobId: 'a', code: 143, killedByCaller: true, durationMs: 0 });
    assert.equal(r.state.waiting.length, 0);
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.state.unacked, {});
  });

  it('cancel で待ち列から外す', () => {
    const s = state({ capacity: 1, leases: [lease({ id: 'x' })], waiting: [waiting({ id: 'a' })] });
    assert.equal(decide(s, { type: 'cancel', now: 0, jobId: 'a' }).state.waiting.length, 0);
  });
});

describe('decide: 包みを見失ったとき', () => {
  it('子がまだ生きていれば孤児として資源を持たせたまま、未確認に積む', () => {
    const s = state({ leases: [lease({ id: 'a', session: 's1', cmd: 'c', locks: ['p'] })], waiting: [waiting({ id: 'b', locks: ['p'] })] });
    const r = decide(s, { type: 'heartbeatLost', now: 0, jobId: 'a', alive: true });
    assert.equal(r.state.leases[0].phase, 'orphan');
    assert.deepEqual(grants(r.actions), []);
    assert.deepEqual(r.state.unacked.s1, [{ jobId: 'a', kind: 'orphan', code: null, cmd: 'c', repo: '/repo', profile: 'p' }]);
  });

  it('子も消えていれば資源を返し、lost として積む', () => {
    const s = state({ leases: [lease({ id: 'a', session: 's1', cmd: 'c', locks: ['p'] })], waiting: [waiting({ id: 'b', locks: ['p'] })] });
    const r = decide(s, { type: 'heartbeatLost', now: 0, jobId: 'a', alive: false });
    assert.deepEqual(grants(r.actions), [['b', 1]]);
    assert.deepEqual(r.state.unacked.s1, [{ jobId: 'a', kind: 'lost', code: null, cmd: 'c', repo: '/repo', profile: 'p' }]);
  });

  it('孤児の子が消えたら資源を返す', () => {
    const s = state({ leases: [lease({ id: 'a', locks: ['p'] }, { phase: 'orphan' })], waiting: [waiting({ id: 'b', locks: ['p'] })] });
    assert.deepEqual(grants(decide(s, { type: 'orphanGone', now: 0, jobId: 'a' }).actions), [['b', 1]]);
  });

  it('孤児でないリースに orphanGone が来ても資源を返さない', () => {
    const s = state({ leases: [lease({ id: 'a', locks: ['p'] })], waiting: [waiting({ id: 'b', locks: ['p'] })] });
    const r = decide(s, { type: 'orphanGone', now: 0, jobId: 'a' });
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.leases.length, 1);
  });
});

describe('decide: 復旧と確認', () => {
  it('resume で待ちの復旧印を外し、入場させる', () => {
    const r = decide(state({ waiting: [{ ...waiting({ id: 'a' }), recovering: true }] }), { type: 'resume', now: 0, jobId: 'a', pid: null, pgid: null });
    assert.deepEqual(grants(r.actions), [['a', 1]]);
  });

  it('resume でリースの復旧印を外し、pid を記録する', () => {
    const s = state({ leases: [lease({ id: 'a' }, { recovering: true, phase: 'granted' })] });
    const l = decide(s, { type: 'resume', now: 0, jobId: 'a', pid: 7, pgid: 7 }).state.leases[0];
    assert.deepEqual([l.recovering, l.phase, l.pid], [false, 'running', 7]);
  });

  it('ack はそのセッションのそのジョブだけを消す', () => {
    const s = state({
      unacked: {
        s1: [{ jobId: 'a', kind: 'failed', code: 1, cmd: 'c' }, { jobId: 'b', kind: 'failed', code: 2, cmd: 'c' }],
        s2: [{ jobId: 'a', kind: 'failed', code: 1, cmd: 'c' }],
      },
    });
    const r = decide(s, { type: 'ack', now: 0, session: 's1', jobId: 'a' });
    assert.deepEqual(r.state.unacked, { s1: [{ jobId: 'b', kind: 'failed', code: 2, cmd: 'c' }], s2: [{ jobId: 'a', kind: 'failed', code: 1, cmd: 'c' }] });
  });

  it('最後の 1 件を ack したら、セッションの欄ごと消す', () => {
    const s = state({ unacked: { s1: [{ jobId: 'a', kind: 'failed', code: 1, cmd: 'c' }] } });
    assert.deepEqual(decide(s, { type: 'ack', now: 0, session: 's1', jobId: 'a' }).state.unacked, {});
  });
});
