// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, UsageError } from '../../src/cli/args.mjs';
import { cli } from '../../src/cli/main.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';

const MIN = 60_000;
const T0 = 1_700_000_000_000;

/** 記録を書いた一時の home @param {Record<string, unknown>[]} events @param {Record<string, unknown>[]} [hooks] */
function home(events, hooks = []) {
  const dir = mkdtempSync(join(tmpdir(), 'crep-'));
  const p = pathsOf(dir);
  writeFileSync(p.events, events.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (hooks.length > 0) writeFileSync(p.hooks, hooks.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}

/** @param {string[]} args @param {string} h */
async function capture(args, h) {
  let out = '';
  let err = '';
  const code = await cli(args, { env: { SWITCHYARD_HOME: h }, cwd: tmpdir(), stdout: (s) => (out += s), stderr: (s) => (err += s) });
  return { code, out, err };
}

describe('parseArgs report', () => {
  it('オプションが無ければ既定の値', () => {
    assert.deepEqual(parseArgs(['report']), { cmd: 'report', repoPrefix: null, sinceDays: null });
  });

  it('--repo と --since を読む', () => {
    assert.deepEqual(parseArgs(['report', '--repo', '/home/u/dev/irc', '--since', '7d']), { cmd: 'report', repoPrefix: '/home/u/dev/irc', sinceDays: 7 });
  });

  it('--since の形が違えば使い方の誤り', () => {
    assert.throws(() => parseArgs(['report', '--since', '7']), UsageError);
    assert.throws(() => parseArgs(['report', '--nope']), UsageError);
  });
});

describe('switchyard report', () => {
  it('events.jsonl と hooks.jsonl を読んで集計を出す', async () => {
    const h = home(
      [
        { at: T0, kind: 'event', event: { type: 'request', now: T0, job: { id: 'a', session: 's1', repo: '/repo', profile: 'unit', cmd: 'npm test', class: 'batch', cpus: { min: 2, max: 4 }, locks: [], preempt: 'throttle', why: null, expectedMs: null } } },
        { at: T0, kind: 'decision', decision: { type: 'queued', jobId: 'a', position: 1, reason: 'CPU 不足(空き 1 / 必要 2)', etaAt: null } },
        { at: T0 + 2 * MIN, kind: 'decision', decision: { type: 'grant', jobId: 'a', cpus: 2 } },
        { at: T0 + 12 * MIN, kind: 'history', repo: '/repo', profile: 'unit', class: 'batch', cpus: 2, durationMs: 10 * MIN, code: 0 },
      ],
      [{ at: T0, kind: 'hook', decision: 'background', session: 's1', cwd: '/repo', cmd: 'npm test' }],
    );
    const r = await capture(['report'], h);
    assert.equal(r.code, 0);
    assert.match(r.out, /ジョブ 1 件/);
    assert.match(r.out, /CPU 待ち 1 件/);
    assert.match(r.out, /背景へ回した 1 件/);
  });

  it('記録がまだ無ければ、その旨を出して 0 で終わる', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crep-'));
    const r = await capture(['report'], dir);
    assert.equal(r.code, 0);
    assert.match(r.out, /ジョブ 0 件/);
  });
});
