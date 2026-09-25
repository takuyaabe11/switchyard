// @ts-check
// switchyard report --share: 公開の場に貼れる集計。数だけを出し、repo・パス・コマンド・profile の名前・セッション id を出さない。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../../src/report/report.mjs';
import { duration, formatShare, sharedSettings } from '../../src/report/share.mjs';

const MIN = 60_000;
const T0 = 1_700_000_000_000;
const REPO = '/home/alice/src/acme-payments';
const SECRET_CMD = 'API_TOKEN=sk-live-abc123 npm run e2e -- --grep checkout';

/** @param {string} id @param {number} at @param {string} session @param {string} profile */
const req = (id, at, session, profile) => ({
  at,
  kind: 'event',
  event: { type: 'request', now: at, job: { id, session, repo: REPO, profile, cmd: SECRET_CMD, class: 'batch', cpus: { min: 2, max: 4 }, locks: ['port:4173'], preempt: 'never', why: 'checkout flow', expectedMs: null } },
});
/** @param {string} id @param {number} at @param {Record<string, unknown>} [over] */
const grant = (id, at, over = {}) => ({ at, kind: 'decision', decision: { type: 'grant', jobId: id, cpus: 2, ...over } });
/** @param {string} profile @param {number} durationMs @param {Record<string, unknown>} [over] */
const history = (profile, durationMs, over = {}) => ({ at: T0 + 3 * 86_400_000, kind: 'history', repo: REPO, profile, class: 'batch', cpus: 2, durationMs, code: 0, ...over });

const META = { version: '9.9.9', node: '22.0.0', platform: 'linux', arch: 'x64', cores: 8, memoryGb: 32, settings: { SWITCHYARD_STOP: 'block' } };

function sample() {
  const events = [
    req('a', T0, 'sess-alice-1', 'default:batch'),
    grant('a', T0),
    req('b', T0 + 3 * 86_400_000, 'sess-alice-2', 'acme-e2e'),
    { at: T0 + 3 * 86_400_000, kind: 'decision', decision: { type: 'queued', jobId: 'b', position: 1, reason: '鍵 port:4173 を先に待つジョブがいる', etaAt: null } },
    grant('b', T0 + 3 * 86_400_000 + 2 * MIN, { overcommit: true }),
    history('default:batch', 4 * MIN),
    history('default:batch', 6 * MIN, { repo: '/home/alice/src/other' }),
    history('acme-e2e', 9 * MIN, { code: 1, environmental: ['busy'] }),
    history('cmd:deploy-acme staging', MIN),
  ];
  const hooks = [
    { at: T0, kind: 'hook', decision: 'background', session: 'sess-alice-1', cwd: REPO, cmd: SECRET_CMD },
    { at: T0, kind: 'hook', decision: 'ask', session: 'sess-alice-1', cwd: REPO, cmd: 'switchyard run -- echo hi' },
  ];
  return summarize({ events, hooks });
}

describe('formatShare(switchyard report --share)', () => {
  it('repo・パス・コマンド・switchyard.json の profile 名・セッション id・鍵の名前・目的を出さない', () => {
    const text = formatShare({ summary: sample(), observed: null, meta: META });
    for (const leak of ['alice', 'acme', '/home', 'sk-live', 'API_TOKEN', 'e2e', 'checkout', 'sess-', 'port:4173', 'npm run', 'deploy', 'staging', 'cmd:']) {
      assert.equal(text.includes(leak), false, `${leak} が出ている:\n${text}`);
    }
  });

  it('数と、既定の表の profile ごとの本数と、機械と変えた設定を出す', () => {
    const s = sample();
    assert.deepEqual([s.sessions, s.spanDays, s.hook.ask], [2, 3, 1]);
    const text = formatShare({ summary: s, observed: null, meta: META });
    assert.match(text, /switchyard 9\.9\.9, Node 22\.0\.0, linux x64, 8 cores, 32 GB/);
    assert.match(text, /settings changed from the defaults: SWITCHYARD_STOP=block/);
    assert.match(text, /period: 3 day\(s\), 2 session\(s\), 2 jobs/);
    assert.match(text, /finished runs: 4; held back so they would not overlap: 1 \(total wait 2m/);
    assert.match(text, /why: lock 1/);
    assert.match(text, /packed into measured spare CPU: 1; borrowed beyond capacity: 0; sized down to learned use: 0/);
    assert.match(text, /default:batch 2 runs \(typical run 4m/);
    assert.match(text, /project profiles 1 runs in 1 profile\/repo pairs; wrapped without a profile 1 runs/);
    assert.match(text, /failed runs: 1 \(1 flagged as possibly not the code\)/);
    assert.match(text, /PreToolUse: background 1, wrapped 0, refused 0, asked 1/);
    assert.doesNotMatch(text, /observe mode/);
  });

  it('重なりによる遅れは、倍率と本数と見込みだけを出す(どの profile かは出さない)', () => {
    const none = formatShare({ summary: sample(), observed: null, meta: META });
    assert.match(none, /slowdown when overlapped, learned for 0 profile\/repo pair\(s\); admitted without waiting as not slowed by overlap: 0; slowdown avoided by holding back \(estimate, not measured\): 0s over 0 run\(s\)/);
    const runs = (/** @type {string} */ profile, /** @type {number} */ quiet, /** @type {number} */ busy) => [
      ...[0, 1, 2].map(() => history(profile, quiet, { overlap: 'alone' })),
      ...[0, 1, 2].map(() => history(profile, busy, { overlap: 'contended' })),
    ];
    const events = [...runs('acme-e2e', 10 * MIN, 13 * MIN), ...runs('default:batch', 10 * MIN, 10 * MIN), grant('x', T0, { tolerant: true })];
    const text = formatShare({ summary: summarize({ events, hooks: [] }), observed: null, meta: META });
    assert.match(text, /slowdown when overlapped, learned for 2 profile\/repo pair\(s\): 1x, 1\.3x; admitted without waiting/);
    assert.equal(text.includes('acme'), false);
  });

  it('観察だけのモードの記録があれば、重なりの数も出す', () => {
    const observed = { runs: 5, heavy: 4, overlapped: 3, overlapMs: 90_000, sessions: 2, measureDisturbed: 1, lockClashes: 2, hook: { background: 1, deny: 0, wrap: 0 } };
    const text = formatShare({ summary: sample(), observed, meta: { ...META, settings: {} } });
    assert.match(text, /settings changed from the defaults: none/);
    assert.match(text, /observe mode: 3 of 4 heavy runs overlapped another \(1m 30s in total\) across 2 session\(s\); measurements beside a heavy run: 1; same-lock overlaps: 2/);
  });
});

describe('sharedSettings', () => {
  it('決めた設定の名前だけを拾い、短い語でない値は「set」とだけ書く', () => {
    assert.deepEqual(sharedSettings({ SWITCHYARD_STOP: 'block', SWITCHYARD_CAPACITY: '8', SWITCHYARD_HOME: '/home/alice/.sy', SWITCHYARD_GIT: '', SWITCHYARD_BACKGROUND: 'a very long value here', HOME: '/home/alice' }), {
      SWITCHYARD_STOP: 'block',
      SWITCHYARD_CAPACITY: '8',
      SWITCHYARD_BACKGROUND: 'set',
    });
  });
});

describe('duration(英語の時間の表記)', () => {
  it('言語の設定によらず英語で書く', () => {
    assert.deepEqual([0, 45_000, 240_000, 90_000, 3_600_000, 7_500_000].map(duration), ['0s', '45s', '4m', '1m 30s', '1h', '2h 5m']);
  });
});
