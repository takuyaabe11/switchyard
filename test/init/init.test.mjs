// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli } from '../../src/cli/main.mjs';
import { DEFAULT_PROFILES } from '../../src/config/profiles.mjs';
import { foregroundCalls, patternOf, suggest } from '../../src/init/init.mjs';

const T0 = Date.parse('2026-09-10T00:00:00.000Z');
const iso = (/** @type {number} */ ms) => new Date(T0 + ms).toISOString();

/**
 * Bash の tool_use と、その tool_result の 2 行
 * @param {string} id @param {string} command @param {string} cwd @param {number} startMs @param {number} durMs @param {boolean} [bg]
 */
function pair(id, command, cwd, startMs, durMs, bg = false) {
  return [
    JSON.stringify({ type: 'assistant', cwd, timestamp: iso(startMs), message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command, ...(bg ? { run_in_background: true } : {}) } }] } }),
    JSON.stringify({ type: 'user', cwd, timestamp: iso(startMs + durMs), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
  ];
}

/** 記録の根と repo を作る @param {(repo: string) => string[]} lines */
function fixture(lines) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cinit-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const dir = mkdtempSync(join(tmpdir(), 'clogs-'));
  mkdirSync(join(dir, 'p'), { recursive: true });
  writeFileSync(join(dir, 'p', 's.jsonl'), `${lines(repo).join('\n')}\n`);
  return { repo, dir };
}

describe('switchyard init(profile の提案)', () => {
  it('patternOf: 先頭の語とサブコマンドらしい語を最大 3 語、-m は組で取り、パス・旗で止める。前置きは null', () => {
    const p = (/** @type {string} */ c) => patternOf(c.split(' '));
    assert.equal(p('npm run e2e -- --grep x'), 'npm run e2e');
    assert.equal(p('python -m unittest discover'), 'python -m unittest');
    assert.equal(p('./gradlew integrationTest --info'), './gradlew integrationTest');
    assert.equal(p('bazel test //...'), 'bazel test');
    assert.equal(p('cd sub'), null);
    assert.equal(p('tail -50'), null);
  });

  it('foregroundCalls: repo の中の前景の呼び出しを、tool_use から tool_result までの所要で取り出す(背景・repo の外・古いものは除く)', async () => {
    const { repo, dir } = fixture((r) => [
      ...pair('a', 'npm run e2e', r, 0, 60_000),
      ...pair('b', 'npm run e2e', `${r}/sub`, 100_000, 40_000),
      ...pair('c', 'npm run e2e', r, 200_000, 50_000, true),
      ...pair('d', 'npm run e2e', '/elsewhere', 300_000, 50_000),
    ]);
    const calls = await foregroundCalls({ dir, repo, since: null });
    assert.deepEqual(calls.map((c) => c.ms).sort((x, y) => x - y), [40_000, 60_000]);
    assert.deepEqual(await foregroundCalls({ dir, repo, since: T0 + 50_000 }).then((c) => c.map((x) => x.ms)), [40_000]);
  });

  it('suggest: 繰り返し走っていて長く、どの profile にも当たらない形だけを出す。cd の前置きは無視し、shim から見えない形に印を付ける', () => {
    const calls = [
      { command: 'cd e2e && npm run e2e 2>&1 | tail -50', ms: 90_000 },
      { command: 'npm run e2e -- --grep a', ms: 80_000 },
      { command: 'npm test', ms: 90_000 },
      { command: 'npm test', ms: 90_000 },
      { command: './gradlew integrationTest', ms: 300_000 },
      { command: './gradlew integrationTest', ms: 200_000 },
      { command: 'npm run lint', ms: 1_000 },
      { command: 'npm run lint', ms: 1_000 },
      { command: 'npm run once', ms: 99_000 },
      { command: 'npm run a && npm run b', ms: 99_000 },
      { command: 'npm run a && npm run b', ms: 99_000 },
    ];
    const s = suggest({ calls, profiles: DEFAULT_PROFILES });
    assert.deepEqual(
      s.map((x) => [x.name, x.pattern, x.count, x.shimmed]),
      [
        ['gradlew-integrationtest', './gradlew integrationTest', 2, false],
        ['npm-run-e2e', 'npm run e2e', 2, true],
      ],
      'npm test は既定表が見る・lint は短い・once は 1 回・2 つ並んだ呼び出しは所要を分けられない',
    );
  });

  it('CLI: 提案を出し、--write で既にある profile を変えずに書き足す', async () => {
    const { repo, dir } = fixture((r) => [...pair('a', 'npm run e2e', r, 0, 60_000), ...pair('b', 'npm run e2e', r, 100_000, 70_000)]);
    writeFileSync(join(repo, 'switchyard.json'), JSON.stringify({ profiles: { unit: { match: ['npm run unit'], class: 'batch' } } }));
    /** @type {string[]} */
    const out = [];
    const run = (/** @type {string[]} */ args) => cli(['init', '--dir', dir, ...args], { cwd: repo, env: { HOME: repo }, stdout: (x) => out.push(x), stderr: (x) => out.push(x), now: () => T0 });
    assert.equal(await run([]), 0);
    assert.match(out.join(''), /npm-run-e2e: "npm run e2e"/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(repo, 'switchyard.json'), 'utf8')).profiles), ['unit'], '--write が無ければ書かない');
    assert.equal(await run(['--write']), 0);
    const written = JSON.parse(readFileSync(join(repo, 'switchyard.json'), 'utf8')).profiles;
    assert.deepEqual(written.unit, { match: ['npm run unit'], class: 'batch' });
    assert.deepEqual(written['npm-run-e2e'], { match: ['npm run e2e', 'npm run e2e *'], class: 'batch', cpus: { min: 2, max: 4 } });
  });
});
