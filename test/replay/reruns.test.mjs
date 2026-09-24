// @ts-check
// 同じ状態での走り直しの数え方(switchyard replay の一部)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROFILES } from '../../src/config/profiles.mjs';
import { formatReport, replay } from '../../src/replay/replay.mjs';
import { countSession, emptyReruns, intervalsOf, isReadOnly, stepsOf, timingOf } from '../../src/replay/reruns.mjs';

const T0 = Date.parse('2026-09-10T00:00:00.000Z');
const iso = (/** @type {number} */ ms) => new Date(T0 + ms).toISOString();

/** assistant の tool_use の行 @param {string} id @param {string} name @param {Record<string, unknown>} input @param {number} ms */
const use = (id, name, input, ms, cwd = '/w/app') => JSON.stringify({ type: 'assistant', cwd, timestamp: iso(ms), message: { content: [{ type: 'tool_use', id, name, input }] } });
/** user の tool_result の行 @param {string} id @param {number} ms @param {boolean} [isError] */
const result = (id, ms, isError = false) => JSON.stringify({ type: 'user', timestamp: iso(ms), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });
const bash = (/** @type {string} */ id, /** @type {string} */ command, /** @type {number} */ ms, bg = false) => use(id, 'Bash', { command, ...(bg ? { run_in_background: true } : {}) }, ms);

/** @param {string[]} lines */
function count(lines) {
  const acc = emptyReruns();
  const byCommand = new Map();
  const heavy = (/** @type {{ command: string }} */ c) => /^(npm test|cargo test)/.test(c.command.replace(/\s+/g, " ").trim());
  countSession(lines.flatMap(stepsOf), heavy, acc, byCommand);
  return { acc, byCommand };
}

describe('isReadOnly(ファイルを書き換えないと言い切れるか)', () => {
  it('読むだけのコマンド・読むだけの git・/dev/null への捨て先は真', () => {
    for (const c of ['ls -la', 'cat a | grep b | wc -l', 'git status', 'git diff HEAD~1', 'git log --oneline -5', 'rg foo src 2>/dev/null', 'sed -n 1,20p a.txt', 'cd app && ls', 'switchyard top', 'echo done 2>&1']) {
      assert.equal(isReadOnly(c), true, c);
    }
  });
  it('書き換えうるコマンド・ファイルへの書き出し・sed -i は偽', () => {
    for (const c of ['python3 fix.py', "sed -i 's/a/b/' x", 'echo x > a.txt', 'cat a >> b', 'git checkout main', 'git commit -m x', 'npm install', 'rm -f a', 'node scripts/gen.mjs', 'switchyard ack j1']) {
      assert.equal(isReadOnly(c), false, c);
    }
  });
});

describe('countSession(同じ状態での走り直し)', () => {
  it('間に読むだけの操作しか無ければ、厳しめにも緩めにも数え、前景の所要を足す', () => {
    const { acc, byCommand } = count([bash('a', 'npm test', 0), result('a', 10_000), bash('b', 'git status', 11_000), result('b', 11_100), bash('c', 'npm  test ', 12_000), result('c', 22_000)]);
    assert.deepEqual([acc.runs, acc.strict.count, acc.strict.ms, acc.loose.count, acc.loose.ms], [2, 1, 10_000, 1, 10_000]);
    assert.deepEqual([...byCommand.values()], [{ count: 1, ms: 10_000 }]);
  });

  it('間に書き換えのツールがあれば数えない', () => {
    const { acc } = count([bash('a', 'npm test', 0), result('a', 1000), use('e', 'Edit', { file_path: 'x' }, 2000), bash('b', 'npm test', 3000), result('b', 4000)]);
    assert.deepEqual([acc.strict.count, acc.loose.count], [0, 0]);
  });

  it('間に書き換えうる Bash があれば、緩めにだけ数える', () => {
    const { acc } = count([bash('a', 'npm test', 0), result('a', 1000), bash('p', 'python3 fix.py', 2000), result('p', 2100), bash('b', 'npm test', 3000), result('b', 5000)]);
    assert.deepEqual([acc.strict.count, acc.strict.ms, acc.loose.count, acc.loose.ms], [0, 0, 1, 2000]);
  });

  it('失敗の直後の走り直しを数え、場所やコマンドが違えば別の走行とみなす', () => {
    const { acc } = count([
      bash('a', 'npm test', 0), result('a', 1000, true),
      bash('b', 'npm test', 2000), result('b', 3000),
      bash('c', 'cargo test', 4000), result('c', 5000),
      use('d', 'Bash', { command: 'npm test' }, 6000, '/w/other'), result('d', 7000),
    ]);
    assert.deepEqual([acc.runs, acc.strict.count, acc.afterFailure], [4, 1, 1]);
  });

  it('背景の走行は数えるが、所要は足さない(結果はすぐ返る)', () => {
    const { acc } = count([bash('a', 'npm test', 0, true), result('a', 100), bash('b', 'npm test', 1000, true), result('b', 1100)]);
    assert.deepEqual([acc.strict.count, acc.strict.ms], [1, 0]);
  });
});

describe('replay の走り直しの集計', () => {
  it('記録を読んで数え、再開したセッションが持ち越した行は 2 度数えず、文面に出す', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crr-'));
    mkdirSync(join(root, 'p'));
    const session = [bash('a', 'npm test', 0), result('a', 10_000), bash('b', 'ls', 11_000), result('b', 11_100), bash('c', 'npm test', 12_000), result('c', 20_000)];
    writeFileSync(join(root, 'p', 's1.jsonl'), session.join('\n') + '\n');
    // 再開したセッション: 前の行を持ち越し、その後に 1 回走り直す
    writeFileSync(join(root, 'p', 's2.jsonl'), [...session, bash('d', 'npm test', 30_000), result('d', 35_000)].join('\n') + '\n');
    const r = await replay({ dir: root, cwdPrefix: null, since: null, profilesFor: () => DEFAULT_PROFILES, examples: 5, git: false });
    assert.equal(r.reruns.runs, 3);
    assert.deepEqual([r.reruns.strict.count, r.reruns.strict.ms], [1, 8000]);
    const text = formatReport(r, { cwdPrefix: null, sinceDays: null, examples: 5 });
    assert.match(text, /同じ状態での走り直し\(重い走行 3 件のうち/);
    assert.match(text, /厳しめ: 1 件\(33\.3%\)・前景の所要の合計 8秒/);
    assert.match(text, /1 回・8秒 {2}npm test/);
  });
});

describe('intervalsOf・timingOf(重い走行の時間とセッションをまたいだ重なり)', () => {
  const heavy = (/** @type {{ command: string }} */ c) => c.command.startsWith('npm test');

  it('前景で結果を待った重い走行だけを区間にし、背景の走行は数だけ', () => {
    const { intervals, background } = intervalsOf([bash('a', 'npm test', 0), result('a', 5000), bash('b', 'ls', 6000), result('b', 6100), bash('c', 'npm test', 7000, true), result('c', 7100)].flatMap(stepsOf), heavy, 3);
    assert.deepEqual(intervals, [{ start: T0, end: T0 + 5000, session: 3 }]);
    assert.equal(background, 1);
  });

  it('所要の分布と、2 本以上が同時に走っていた時間・重なった走行・最大同時を出す(つながっているだけなら重ならない)', () => {
    const iv = (/** @type {number} */ s, /** @type {number} */ e, /** @type {number} */ session) => ({ start: s * 1000, end: e * 1000, session });
    // 2 本以上が同時なのは 5〜12 秒(7 秒。8〜10 秒は 3 本同時)。20-30 は 5-20 につながるだけ。100-200 は単独
    const tm = timingOf([iv(0, 10, 0), iv(5, 20, 1), iv(8, 12, 2), iv(20, 30, 0), iv(100, 200, 1)], 4);
    assert.equal(tm.runs, 5);
    assert.equal(tm.background, 4);
    assert.equal(tm.totalMs, (10 + 15 + 4 + 10 + 100) * 1000);
    assert.deepEqual([tm.medianMs, tm.p90Ms], [10_000, 15_000]);
    assert.deepEqual([tm.under10s, tm.under60s], [1, 4]);
    assert.deepEqual([tm.overlappedRuns, tm.overlapMs, tm.maxConcurrent], [3, 7000, 3]);
  });

  it('区間が無ければ 0', () => {
    assert.deepEqual(timingOf([], 0), { runs: 0, background: 0, totalMs: 0, medianMs: 0, p90Ms: 0, under10s: 0, under60s: 0, overlappedRuns: 0, overlapMs: 0, maxConcurrent: 0 });
  });

  it('replay はセッション(記録)をまたいだ重なりを数え、文面に出す', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crt-'));
    mkdirSync(join(root, 'p'));
    writeFileSync(join(root, 'p', 'a.jsonl'), [bash('a1', 'npm test', 0), result('a1', 20_000)].join('\n') + '\n');
    writeFileSync(join(root, 'p', 'b.jsonl'), [bash('b1', 'npm test', 10_000), result('b1', 40_000), bash('b2', 'npm test', 50_000, true), result('b2', 50_100)].join('\n') + '\n');
    const r = await replay({ dir: root, cwdPrefix: null, since: null, profilesFor: () => DEFAULT_PROFILES, examples: 5, git: false });
    assert.deepEqual([r.timing.runs, r.timing.background, r.timing.overlappedRuns, r.timing.overlapMs, r.timing.maxConcurrent], [2, 1, 2, 10_000, 2]);
    const text = formatReport(r, { cwdPrefix: null, sinceDays: null, examples: 5 });
    assert.match(text, /重い走行の時間\(前景で結果を待った 2 本。背景の 1 本は/);
    assert.match(text, /Claude が結果を待った時間の合計: 50秒/);
    assert.match(text, /他と重なった走行 2 本\(100\.0%\)・2 本以上が同時に走っていた時間 10秒\(待った時間の合計の 20\.0%\)・最大同時 2 本/);
  });
});
