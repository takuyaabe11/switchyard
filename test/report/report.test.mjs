// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatReport, summarize } from '../../src/report/report.mjs';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** request の記録 @param {string} id @param {number} at @param {Partial<{ repo: string, profile: string, class: string, cmd: string, sizedFrom: { min: number, max: number } }>} [over] */
const req = (id, at, over = {}) => ({
  at,
  kind: 'event',
  event: { type: 'request', now: at, job: { id, session: 's1', repo: '/repo', profile: 'unit', cmd: 'npm test', class: 'batch', cpus: { min: 2, max: 4 }, locks: [], preempt: 'throttle', why: null, expectedMs: null, ...over } },
});

/** grant の記録 @param {string} id @param {number} at @param {{ cpus?: number, lockChild?: boolean, overcommit?: boolean }} [over] */
const grant = (id, at, over = {}) => ({ at, kind: 'decision', decision: { type: 'grant', jobId: id, cpus: over.cpus ?? 2, ...(over.lockChild === true ? { lockChild: true } : {}), ...(over.overcommit === true ? { overcommit: true } : {}) } });

/** queued の記録 @param {string} id @param {number} at @param {string} reason */
const queued = (id, at, reason) => ({ at, kind: 'decision', decision: { type: 'queued', jobId: id, position: 1, reason, etaAt: null } });

/** history の記録 @param {number} at @param {number} durationMs @param {{ profile?: string, code?: number, repo?: string }} [over] */
const history = (at, durationMs, over = {}) => ({ at, kind: 'history', repo: over.repo ?? '/repo', profile: over.profile ?? 'unit', class: 'batch', cpus: 2, durationMs, code: over.code ?? 0 });

/** hooks.jsonl の 1 行 @param {string} decision @param {number} at @param {string} [cwd] */
const hook = (decision, at, cwd = '/repo') => ({ at, kind: 'hook', decision, session: 's1', cwd, cmd: 'npm test' });

describe('summarize(改善のための集計)', () => {
  it('要求から入場までの待ち時間を、中央値と最大で数える', () => {
    const events = [
      req('a', T0), grant('a', T0),
      req('b', T0), queued('b', T0, 'CPU 不足(空き 1 / 必要 2)'), grant('b', T0 + 2 * MIN),
      req('c', T0), queued('c', T0, 'CPU 不足(空き 1 / 必要 2)'), grant('c', T0 + 6 * MIN),
    ];
    // 0・2・6 分にしてあるのは、中央値(2 分)と平均(2.67 分)が違う形にするため(平均へ変える変異を殺す)
    const s = summarize({ events, hooks: [] });
    assert.equal(s.jobs, 3);
    assert.equal(s.granted, 3);
    assert.equal(s.waited, 2);
    assert.deepEqual([s.waitMs.median, s.waitMs.max], [2 * MIN, 6 * MIN]);
  });

  it('待たせた理由を種別ごとに数える(ジョブごとに最初の理由)', () => {
    const events = [
      req('a', T0), queued('a', T0, '計測 m1 の走行中は入場しない'), grant('a', T0 + MIN),
      req('b', T0), queued('b', T0, 'CPU 不足(空き 1 / 必要 2)'), grant('b', T0 + MIN),
      req('c', T0), queued('c', T0, '鍵 port:4173 を先に待つジョブがいる'), grant('c', T0 + MIN),
      req('d', T0), queued('d', T0, '先頭 a の後ろ(後ろ詰めの見込みなし)'), grant('d', T0 + MIN),
      req('e', T0), queued('e', T0, 'メモリ不足(空き 2500MB・見込み 2500MB・残す 1000MB)'), grant('e', T0 + MIN),
      req('f', T0), queued('f', T0, 'not enough memory (free 2500MB, expects 2500MB, keeps 1000MB)'), grant('f', T0 + MIN),
    ];
    const s = summarize({ events, hooks: [] });
    assert.deepEqual(s.reasons, { measure: 1, cpu: 1, lock: 1, behind: 1, memory: 2 });
  });

  it('環境のせいかもしれない失敗を数える', () => {
    const history = (/** @type {Record<string, unknown>} */ over) => ({ at: T0, kind: 'history', repo: '/repo', profile: 'unit', class: 'batch', cpus: 2, durationMs: 1000, code: 1, ...over });
    const s = summarize({ events: [history({ environmental: ['x'] }), history({}), history({ code: 0 })], hooks: [] });
    assert.deepEqual([s.failures, s.environmental], [2, 1]);
  });

  it('学んだ使い方に合わせて要求を縮めた要求を数える', () => {
    const events = [req('a', T0, { sizedFrom: { min: 2, max: 4 } }), req('b', T0)];
    assert.equal(summarize({ events, hooks: [] }).sized, 1);
    assert.match(formatReport(summarize({ events, hooks: [] }), { repoPrefix: null, sinceDays: null }), /学んだ使い方に合わせて要求を縮めた走行: 1 件/);
  });

  it('実測の空きに詰め込んだ入場を数える', () => {
    const events = [req('a', T0), grant('a', T0, { cpus: 1, overcommit: true }), req('b', T0), grant('b', T0)];
    assert.equal(summarize({ events, hooks: [] }).packed, 1);
  });

  it('容量を超えて借りた入場を数える', () => {
    const events = [req('a', T0), grant('a', T0, { cpus: 2, lockChild: true }), req('b', T0), grant('b', T0)];
    assert.equal(summarize({ events, hooks: [] }).borrows, 1);
  });

  it('profile ごとの本数と所要の中央値、失敗、管理なしの走行を数える', () => {
    const events = [
      // 10・20・120 分は、中央値(20 分)と平均(50 分)が違う形(平均へ変える変異を殺す)
      history(T0, 10 * MIN), history(T0, 20 * MIN), history(T0, 120 * MIN),
      history(T0, 5 * MIN, { profile: 'e2e', code: 1 }),
      { at: T0, kind: 'unmanaged', jobId: 'u1', session: 's1', repo: '/repo', profile: 'unit', cmd: 'npm test', code: 1, durationMs: MIN },
    ];
    const s = summarize({ events, hooks: [] });
    assert.deepEqual(s.byProfile, [
      { repo: '/repo', profile: 'unit', count: 3, medianMs: 20 * MIN },
      { repo: '/repo', profile: 'e2e', count: 1, medianMs: 5 * MIN },
    ]);
    assert.equal(s.failures, 1);
    assert.equal(s.unmanaged, 1);
  });

  it('hooks.jsonl の背景化と拒否を数える', () => {
    const s = summarize({ events: [], hooks: [hook('background', T0), hook('background', T0), hook('deny', T0)] });
    assert.deepEqual(s.hook, { background: 2, deny: 1, wrap: 0, ask: 0, extend: 0, timeoutBackground: 0, timeout: 0, port: 0, portFound: 0 });
  });

  it('Bash の時間切れ(切られた・延ばした・背景へ回した)と、ポートが使用中で落ちた数(握っているプロセスを突き止めた数)を数え、文面に出す', () => {
    const hooks = [
      { ...hook('timeout', T0), limitMs: 120_000 },
      { ...hook('extend', T0), timeoutMs: 240_000, reason: 'timed-out-before' },
      { ...hook('background', T0), timeoutMs: null, reason: 'learned' },
      hook('background', T0),
      { ...hook('port', T0), port: 3000, holders: 1 },
      { ...hook('port', T0), port: null, holders: 0 },
    ];
    const s = summarize({ events: [], hooks });
    assert.deepEqual(s.hook, { background: 1, deny: 0, wrap: 0, ask: 0, extend: 1, timeoutBackground: 1, timeout: 1, port: 2, portFound: 1 });
    const text = formatReport(s, { repoPrefix: null, sinceDays: null });
    assert.match(text, /Bash の時間切れ: 切られた 1 件・切られないよう延ばした 1 件・上限を超えるので背景へ回した 1 件/);
    assert.match(text, /ポートが使用中で落ちた: 2 件\(握っているプロセスを突き止めた 1 件\)/);
  });

  it('repo の前方一致と期間で絞る(決定は、その要求の repo で絞る)', () => {
    const events = [
      req('a', T0, { repo: '/repo/irc' }), grant('a', T0 + MIN),
      req('b', T0, { repo: '/other' }), grant('b', T0 + 9 * MIN),
      req('c', T0 - 10 * MIN, { repo: '/repo/irc' }), grant('c', T0 - 9 * MIN),
      history(T0, 10 * MIN, { repo: '/other' }),
    ];
    const s = summarize({ events, hooks: [hook('deny', T0, '/repo/irc'), hook('deny', T0, '/other')], repoPrefix: '/repo', since: T0 });
    assert.equal(s.jobs, 1);
    assert.equal(s.waitMs.max, MIN);
    assert.deepEqual(s.byProfile, []);
    assert.deepEqual(s.hook, { background: 0, deny: 1, wrap: 0, ask: 0, extend: 0, timeoutBackground: 0, timeout: 0, port: 0, portFound: 0 });
  });
});

describe('効果の集計', () => {
  it('他と取り合って待たされた走行の本数・その待ち時間の合計・単独で走らせた計測の本数を数える', () => {
    const events = [
      req('a', T0), grant('a', T0),
      req('b', T0), queued('b', T0, 'CPU 不足(空き 0 / 必要 2)'), grant('b', T0 + 2 * MIN),
      req('c', T0), queued('c', T0, 'lock k held by a'), grant('c', T0 + 3 * MIN),
      req('d', T0), queued('d', T0, '判断待ち'), grant('d', T0 + 1 * MIN),
      history(T0, MIN), history(T0, MIN), { ...history(T0, MIN), class: 'measure' },
    ];
    const s = summarize({ events });
    assert.equal(s.avoided, 2, '理由の分からない待ちは数えない');
    assert.equal(s.totalWaitMs, 6 * MIN);
    assert.equal(s.measureRuns, 1);
    assert.equal(s.runs, 3);
    assert.match(formatReport(s, { repoPrefix: null, sinceDays: null }), /効果: 走り終えた走行 3 本のうち、他と重ならないよう待たせた 2 本\(待ち時間の合計 6分\)・単独で走らせた計測 1 本/);
  });
});

describe('formatReport', () => {
  it('記録が空でも、何も無いと読める形を出す', () => {
    const text = formatReport(summarize({ events: [], hooks: [] }), { repoPrefix: null, sinceDays: null });
    assert.match(text, /ジョブ 0 件/);
  });

  it('待ち・理由・借り・hook の判断を表に出し、絞り込みを添える', () => {
    const events = [
      req('a', T0), queued('a', T0, '計測 m1 の走行中は入場しない'), grant('a', T0 + 3 * MIN),
      history(T0, 12 * MIN),
    ];
    const text = formatReport(summarize({ events, hooks: [hook('background', T0)] }), { repoPrefix: '/repo', sinceDays: 7 });
    assert.match(text, /絞り込み: repo が \/repo で始まる・直近 7 日/);
    assert.match(text, /ジョブ 1 件/);
    assert.match(text, /計測待ち 1 件/);
    assert.match(text, /背景へ回した 1 件/);
    assert.match(text, /unit/);
  });
});
