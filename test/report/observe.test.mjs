// @ts-check
// 観察だけのモード(SWITCHYARD_OBSERVE=1): 記録の集計・run と hook の振る舞い・report の出力。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli } from '../../src/cli/main.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { runHook } from '../../src/hooks/main.mjs';
import { formatObserved, summarizeObserved } from '../../src/report/observe.mjs';
import { summarize } from '../../src/report/report.mjs';
import { runJob } from '../../src/run/run.mjs';

const S = 1_000;
/** @param {number} start @param {number} end @param {Record<string, unknown>} [over] */
const run = (start, end, over = {}) => ({ kind: 'observed', start, end, session: 's1', repo: '/r', profile: 'p', class: 'batch', locks: [], cmd: 'npm test', ...over });

describe('summarizeObserved', () => {
  it('重い走行同士の重なりの本数と時間、重なりの横の計測、同じ鍵の重なり、hook の判断を数える', () => {
    const s = summarizeObserved({
      observed: [
        run(0, 10 * S, { session: 'a' }),
        run(5 * S, 15 * S, { session: 'b' }),
        run(8 * S, 9 * S, { session: 'c', class: 'measure' }),
        run(20 * S, 30 * S, { session: 'a' }),
        run(1 * S, 2 * S, { class: 'quick', locks: ['git:/r'] }),
        run(1.5 * S, 3 * S, { class: 'quick', locks: ['git:/r'] }),
        run(40 * S, 41 * S, { class: 'quick', locks: ['git:/r'] }),
      ],
      hooks: [
        { kind: 'hook', observe: true, decision: 'deny', at: 0, cwd: '/r' },
        { kind: 'hook', observe: true, decision: 'background', at: 0, cwd: '/r' },
        { kind: 'hook', observe: true, decision: 'wrap', at: 0, cwd: '/r' },
        { kind: 'hook', decision: 'background', at: 0, cwd: '/r' },
      ],
    });
    assert.deepEqual(s, {
      runs: 7,
      heavy: 4,
      overlapped: 3,
      // 1 本目は 5〜10 秒、2 本目は 5〜10 秒、計測は 8〜9 秒の 1 秒
      overlapMs: 5 * S + 5 * S + 1 * S,
      sessions: 3,
      measureDisturbed: 1,
      lockClashes: 1,
      hook: { background: 1, deny: 1, wrap: 1 },
    });
  });

  it('repo と期間で絞り、形の違う行は数えない。重なりが無ければ、得るものが少ないと言う', () => {
    const s = summarizeObserved({ observed: [run(0, 10 * S), run(5 * S, 8 * S, { repo: '/other' }), { kind: 'observed', start: 'x' }], repoPrefix: '/r', since: null });
    assert.equal(s.heavy, 1);
    assert.equal(s.overlapped, 0);
    assert.match(formatObserved(s), /重なりは無かった/);
  });

  it('report の普段の集計は、観察だけのモードの hook の行を数えない', () => {
    const s = summarize({ events: [], hooks: [{ kind: 'hook', observe: true, decision: 'deny', at: 0, cwd: '/r' }] });
    assert.deepEqual(s.hook, { background: 0, deny: 0, wrap: 0, ask: 0 });
  });
});

describe('観察だけのモードの run と hook', () => {
  it('run: デーモンに要求を出さずにすぐ走らせ、始まりと終わりを observed.jsonl に残す', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cobs-'));
    let connected = false;
    const code = await runJob({
      argv: [process.execPath, '-e', 'setTimeout(() => process.exit(3), 50)'],
      flags: { class: 'batch', cpus: { min: 2, max: 4 }, locks: ['port:1'] },
      home,
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, SWITCHYARD_OBSERVE: '1' },
      out: () => {},
      connect: async () => {
        connected = true;
        throw new Error('観察だけのモードでデーモンに繋いだ');
      },
    });
    assert.equal(code, 3);
    assert.equal(connected, false);
    const rows = readFileSync(pathsOf(home).observed, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].kind, rows[0].class, rows[0].locks, rows[0].code], ['observed', 'batch', ['port:1'], 3]);
    assert.ok(rows[0].end >= rows[0].start + 40);
    assert.equal(existsSync(pathsOf(home).unmanaged), false);
  });

  it('hook: 拒否も背景化もせず何も出さない。判断は observe つきで記録する。Stop も差し戻さない', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cobs-'));
    /** @type {string[]} */
    const written = [];
    const opts = { env: { SWITCHYARD_HOME: home, SWITCHYARD_OBSERVE: '1' }, profilesFor: () => [{ name: 'unit', profile: { match: ['npm test*'], class: /** @type {const} */ ('batch') } }], write: (/** @type {string} */ s) => written.push(s) };
    const input = (/** @type {string} */ command) => JSON.stringify({ session_id: 's1', cwd: '/repo', tool_name: 'Bash', tool_input: { command } });
    await runHook('pre-tool-use', input('npm test'), opts);
    await runHook('pre-tool-use', input('/usr/local/bin/npm test'), opts);
    await runHook('stop', JSON.stringify({ session_id: 's1' }), opts);
    assert.deepEqual(written, []);
    const rows = readFileSync(pathsOf(home).hooks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => [r.decision, r.observe]), [['background', true], ['deny', true]]);
  });

  it('report: 観察の記録があれば、入れていれば何が起きたかを出す', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cobs-'));
    writeFileSync(pathsOf(home).observed, [run(0, 10 * S, { session: 'a' }), run(5 * S, 15 * S, { session: 'b' })].map((r) => JSON.stringify(r)).join('\n') + '\n');
    let out = '';
    const code = await cli(['report'], { env: { SWITCHYARD_HOME: home }, cwd: tmpdir(), stdout: (s) => (out += s), stderr: () => {} });
    assert.equal(code, 0);
    assert.match(out, /観察だけのモードの記録/);
    assert.match(out, /重い走行 2 本\(2 セッション\)のうち、他の重い走行と重なった 2 本/);
  });
});
