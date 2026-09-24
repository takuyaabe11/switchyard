// @ts-check
// 同じ状態での走り直しの数え方(switchyard replay の一部)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROFILES } from '../../src/config/profiles.mjs';
import { formatReport, replay } from '../../src/replay/replay.mjs';
import { countMishaps, countSession, emptyMishaps, emptyReruns, intervalsOf, isReadOnly, stepsOf, timingOf } from '../../src/replay/reruns.mjs';

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

/** 中身を持つ tool_result の行 @param {string} id @param {number} ms @param {unknown} content @param {boolean} [isError] */
const resultWith = (id, ms, content, isError = true) => JSON.stringify({ type: 'user', timestamp: iso(ms), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } });

/** @param {string[]} lines */
function mishaps(lines) {
  const acc = emptyMishaps();
  const byCommand = { timeouts: new Map(), portInUse: new Map() };
  const heavy = (/** @type {{ command: string }} */ c) => /^(npm test|cargo test)/.test(c.command.replace(/\s+/g, ' ').trim());
  countMishaps(lines.flatMap(stepsOf), heavy, acc, byCommand);
  return { acc, byCommand };
}

describe('countMishaps(1 本のセッションでも起きる事故: 時間切れ・ポートが使用中)', () => {
  it('Claude Code の時間切れの結果(Exit code 143・Command timed out after)を数え、切れるまでの時間と既定の時間切れかを数える', () => {
    const { acc } = mishaps([
      bash('a', 'npm test', 0),
      resultWith('a', 120_000, 'Exit code 143\nCommand timed out after 2m 0s'),
      use('b', 'Bash', { command: 'sleep 99', timeout: 5000 }, 200_000),
      resultWith('b', 205_000, [{ type: 'text', text: 'Exit code 143\nCommand timed out after 5s' }]),
    ]);
    assert.deepEqual(
      { count: acc.timeouts.count, heavy: acc.timeouts.heavy, atDefault: acc.timeouts.atDefault, ms: acc.timeouts.ms },
      { count: 2, heavy: 1, atDefault: 1, ms: 125_000 },
    );
  });

  it('時間切れの後に同じ場所で同じコマンドが走れば走り直しと数え、背景で走ったかも数える。失敗していない結果の文面は見ない', () => {
    const { acc, byCommand } = mishaps([
      bash('a', 'npm test', 0),
      resultWith('a', 120_000, 'Exit code 143\nCommand timed out after 2m 0s'),
      bash('b', 'npm  test', 130_000, true),
      resultWith('b', 131_000, 'Command running in background', false),
      // 走り直しの後にもう一度走っても、1 回の時間切れにつき走り直しは 1 回
      bash('f', 'npm test', 140_000),
      resultWith('f', 150_000, 'ok', false),
      bash('c', 'cargo test', 200_000),
      resultWith('c', 320_000, 'Exit code 143\nCommand timed out after 2m 0s'),
      use('d', 'Bash', { command: 'cargo test' }, 400_000, '/w/other'),
      resultWith('d', 401_000, 'ok', false),
      bash('e', 'echo "Command timed out after 1s"', 500_000),
      resultWith('e', 500_100, 'Command timed out after 1s', false),
    ]);
    assert.deepEqual([acc.timeouts.count, acc.timeouts.rerun, acc.timeouts.rerunBackground], [2, 1, 1]);
    assert.deepEqual([...byCommand.timeouts.values()].map((v) => v.count), [1, 1]);
  });

  it('ポートが使用中で落ちた結果(EADDRINUSE・address already in use・docker の port is already allocated)を数える', () => {
    const { acc } = mishaps([
      bash('a', 'npm test', 0),
      resultWith('a', 1000, 'Error: listen EADDRINUSE: address already in use :::3000'),
      bash('b', 'docker compose up -d', 2000),
      resultWith('b', 3000, 'Bind for 0.0.0.0:5432 failed: port is already allocated'),
      bash('c', 'python -m http.server 8000', 4000),
      resultWith('c', 5000, 'OSError: [Errno 98] Address already in use'),
      bash('d', 'grep -r EADDRINUSE src', 6000),
      resultWith('d', 6100, 'src/a.js: // EADDRINUSE', false),
    ]);
    assert.deepEqual([acc.portInUse.count, acc.portInUse.heavy, acc.timeouts.count], [3, 1, 0]);
  });

  it('replay が数えて文面に出す', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmis-'));
    mkdirSync(join(dir, 'p'));
    writeFileSync(
      join(dir, 'p', 's.jsonl'),
      `${[bash('a', 'npm test', 0), resultWith('a', 120_000, 'Exit code 143\nCommand timed out after 2m 0s'), bash('b', 'npm test', 130_000, true), resultWith('b', 131_000, 'ok', false), bash('c', 'npm run dev', 200_000), resultWith('c', 201_000, 'Error: listen EADDRINUSE: address already in use :::3000')].join('\n')}\n`,
    );
    const r = await replay({ dir, cwdPrefix: null, since: null, profilesFor: () => DEFAULT_PROFILES, examples: 3 });
    assert.deepEqual([r.mishaps.timeouts.count, r.mishaps.timeouts.rerun, r.mishaps.timeouts.rerunBackground, r.mishaps.portInUse.count], [1, 1, 1, 1]);
    const text = formatReport(r, { cwdPrefix: null, sinceDays: null, examples: 3 });
    assert.match(text, /Bash の時間切れ: 1 件\(うち重い走行 1 件・既定の時間切れ 1 件\)・切れるまで待った時間の合計 2分/);
    assert.match(text, /その後に同じコマンドを走り直した: 1 件\(うち背景で 1 件\)/);
    assert.match(text, /ポートが使用中で落ちた Bash: 1 件/);
    assert.match(text, /1 回 {2}npm run dev/);
  });
});
