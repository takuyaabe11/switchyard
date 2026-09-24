// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROFILES } from '../../src/config/profiles.mjs';
import { bashCallsOf, formatReport, judgeCall, replay } from '../../src/replay/replay.mjs';

/** @typedef {import('../../src/config/profiles.mjs').NamedProfile} NamedProfile */

const defaults = () => DEFAULT_PROFILES;

/** port 4173 を使う e2e を宣言したプロジェクトの profile(--config の試算に使う形) @type {NamedProfile} */
const E2E = { name: 'e2e', profile: { match: ['npm run e2e*'], class: 'batch', locks: ['port:4173'] } };

/**
 * Claude Code のセッション記録の、Bash を呼んだ assistant の 1 行。
 * @param {{ id: string, command: string, cwd?: string, ts?: string, bg?: boolean }} o
 */
function bashLine({ id, command, cwd = '/w/irc', ts = '2026-09-10T01:02:03.000Z', bg = false }) {
  /** @type {Record<string, unknown>} */
  const input = { command, description: '説明' };
  if (bg) input.run_in_background = true;
  return JSON.stringify({
    type: 'assistant',
    cwd,
    sessionId: 's1',
    timestamp: ts,
    message: { role: 'assistant', content: [{ type: 'text', text: '走らせる' }, { type: 'tool_use', id, name: 'Bash', input }] },
  });
}

/** 判定に渡す 1 件 @param {string} command @param {boolean} [bg] */
const call = (command, bg = false) => ({ id: 't', command, runInBackground: bg, cwd: '/w/irc', timestamp: '2026-09-10T01:02:03.000Z' });

/**
 * 記録の根: メインのセッション・サブエージェント・別のプロジェクトの記録と、記録でないファイル。
 * @returns {string}
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'crep-'));
  mkdirSync(join(root, '-w-irc', 'sess1', 'subagents'), { recursive: true });
  mkdirSync(join(root, '-w-other'));
  const npmTest = bashLine({ id: 'a1', command: 'npm test', ts: '2026-09-10T01:00:00.000Z' });
  writeFileSync(
    join(root, '-w-irc', 'sess1.jsonl'),
    [
      npmTest,
      bashLine({ id: 'a2', command: 'cat benchmarks/standards.json', ts: '2026-09-11T01:00:00.000Z' }),
      bashLine({ id: 'a3', command: '/usr/bin/git commit -m x', ts: '2026-09-12T01:00:00.000Z' }),
      // 再開したセッションは前の行を持ち越すことがある: 同じ tool_use の id は 1 回だけ数える
      npmTest,
      'not json {"name":"Bash"',
      JSON.stringify({ type: 'user', cwd: '/w/irc', timestamp: '2026-09-12T02:00:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'a3', content: '{"name":"Bash"}' }] } }),
      bashLine({ id: 'a4', command: 'git commit -m x', ts: '2026-09-13T01:00:00.000Z' }),
    ].join('\n') + '\n',
  );
  writeFileSync(join(root, '-w-irc', 'sess1', 'subagents', 'agent-1.jsonl'), bashLine({ id: 'b1', command: 'npm test', ts: '2026-09-14T01:00:00.000Z', bg: true }) + '\n');
  writeFileSync(join(root, '-w-other', 'sess2.jsonl'), bashLine({ id: 'c1', command: 'npm test', cwd: '/w/other', ts: '2026-09-15T01:00:00.000Z' }) + '\n');
  writeFileSync(join(root, '-w-irc', 'notes.txt'), bashLine({ id: 'z1', command: 'npm test' }) + '\n');
  return root;
}

describe('bashCallsOf(記録の 1 行)', () => {
  it('assistant の Bash の tool_use を取り出す', () => {
    assert.deepEqual(bashCallsOf(bashLine({ id: 'a', command: 'npm test', bg: true })), [
      { id: 'a', command: 'npm test', runInBackground: true, cwd: '/w/irc', timestamp: '2026-09-10T01:02:03.000Z' },
    ]);
  });

  it('Bash 以外の道具・user の行・壊れた行・空の行は取り出さない', () => {
    const read = JSON.stringify({ type: 'assistant', cwd: '/w', timestamp: 't', message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: 'x' } }] } });
    const user = JSON.stringify({ type: 'user', cwd: '/w', timestamp: 't', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: '{"name":"Bash"}' }] } });
    assert.deepEqual(bashCallsOf(read), []);
    assert.deepEqual(bashCallsOf(user), []);
    assert.deepEqual(bashCallsOf('not json {"name":"Bash"'), []);
    assert.deepEqual(bashCallsOf(''), []);
  });
});

describe('judgeCall(PreToolUse と shim の分類器の実物で判定する)', () => {
  it('読むだけのコマンドは何もしない。shim も通らない', () => {
    assert.deepEqual(judgeCall(call('cat benchmarks/standards.json'), { profilesFor: defaults, git: true }), { hook: 'none', shims: [] });
  });

  it('前景の npm test は背景へ。shim は既定表で包む', () => {
    assert.deepEqual(judgeCall(call('npm test'), { profilesFor: defaults, git: true }), { hook: 'background', shims: [{ word: 'npm', answer: 'run default:batch' }] });
  });

  it('既に背景の重い走行は「既に背景」', () => {
    assert.deepEqual(judgeCall(call('npm test', true), { profilesFor: defaults, git: true }), {
      hook: 'already-background',
      shims: [{ word: 'npm', answer: 'run default:batch' }],
    });
  });

  it('パスで呼ぶ git commit は拒否、git commit は鍵だけ、git status は素通し', () => {
    assert.deepEqual(judgeCall(call('/usr/bin/git commit -m x'), { profilesFor: defaults, git: true }), { hook: 'deny', shims: [] });
    assert.deepEqual(judgeCall(call('git commit -m x'), { profilesFor: defaults, git: true }), { hook: 'none', shims: [{ word: 'git', answer: 'lock' }] });
    assert.deepEqual(judgeCall(call('git status'), { profilesFor: defaults, git: true }), { hook: 'none', shims: [{ word: 'git', answer: 'pass' }] });
  });

  it('区切った単純コマンドごとに shim の答えを並べる', () => {
    assert.deepEqual(judgeCall(call('npm install && npm run lint'), { profilesFor: defaults, git: true }), {
      hook: 'none',
      shims: [
        { word: 'npm', answer: 'pass' },
        { word: 'npm', answer: 'pass' },
      ],
    });
  });

  it('渡した profile で判定する(--config の試算)', () => {
    assert.deepEqual(judgeCall(call('npm run e2e'), { profilesFor: () => [E2E, ...DEFAULT_PROFILES] }), {
      hook: 'background',
      shims: [{ word: 'npm', answer: 'run e2e' }],
    });
    assert.deepEqual(judgeCall(call('npm run e2e'), { profilesFor: defaults, git: true }), { hook: 'none', shims: [{ word: 'npm', answer: 'pass' }] });
  });

  it('走らせている側の環境(考える層の印・入れ子の印)で判定を変えない', () => {
    const saved = { thinker: process.env.SWITCHYARD_THINKER, inJob: process.env.SWITCHYARD_IN_JOB };
    process.env.SWITCHYARD_THINKER = '1';
    process.env.SWITCHYARD_IN_JOB = '1';
    try {
      assert.deepEqual(judgeCall(call('npm test'), { profilesFor: defaults, git: true }), { hook: 'background', shims: [{ word: 'npm', answer: 'run default:batch' }] });
    } finally {
      if (saved.thinker === undefined) delete process.env.SWITCHYARD_THINKER;
      else process.env.SWITCHYARD_THINKER = saved.thinker;
      if (saved.inJob === undefined) delete process.env.SWITCHYARD_IN_JOB;
      else process.env.SWITCHYARD_IN_JOB = saved.inJob;
    }
  });
});

describe('replay(記録の根を読んで集計する)', () => {
  it('メインとサブエージェントの記録を読み、同じ tool_use を 1 回だけ数える', async () => {
    const r = await replay({ dir: fixture(), cwdPrefix: null, since: null, profilesFor: defaults, examples: 5, git: true });
    assert.equal(r.files, 3);
    assert.equal(r.calls, 6);
    assert.deepEqual(r.hook, { deny: 1, background: 2, alreadyBackground: 1, none: 2 });
    assert.deepEqual(r.shim, { run: { 'default:batch': 3 }, lock: 1, pass: 0 });
    assert.equal(r.first, '2026-09-10T01:00:00.000Z');
    assert.equal(r.last, '2026-09-15T01:00:00.000Z');
  });

  it('cwd の前方一致と、期間の始まりで絞る', async () => {
    const dir = fixture();
    const irc = await replay({ dir, cwdPrefix: '/w/irc', since: null, profilesFor: defaults, examples: 5, git: true });
    assert.equal(irc.calls, 5);
    assert.deepEqual(irc.hook, { deny: 1, background: 1, alreadyBackground: 1, none: 2 });
    const recent = await replay({ dir, cwdPrefix: null, since: Date.parse('2026-09-12T00:00:00.000Z'), profilesFor: defaults, examples: 5, git: true });
    assert.equal(recent.calls, 4);
    assert.equal(recent.first, '2026-09-12T01:00:00.000Z');
  });

  it('例は新しい順に、決めた件数まで', async () => {
    const dir = fixture();
    const all = await replay({ dir, cwdPrefix: null, since: null, profilesFor: defaults, examples: 5, git: true });
    assert.deepEqual(
      all.examples.background.map((e) => [e.cwd, e.timestamp]),
      [
        ['/w/other', '2026-09-15T01:00:00.000Z'],
        ['/w/irc', '2026-09-10T01:00:00.000Z'],
      ],
    );
    assert.deepEqual(all.examples.deny.map((e) => e.command), ['/usr/bin/git commit -m x']);
    const one = await replay({ dir, cwdPrefix: null, since: null, profilesFor: defaults, examples: 1, git: true });
    assert.deepEqual(one.examples.background.map((e) => e.cwd), ['/w/other']);
  });
});

describe('formatReport(端末に出す文面)', () => {
  it('件数・割合・profile の内訳・絞り込み・例を出す', async () => {
    const r = await replay({ dir: fixture(), cwdPrefix: '/w/irc', since: null, profilesFor: defaults, examples: 5, git: true });
    const text = formatReport(r, { cwdPrefix: '/w/irc', sinceDays: null, examples: 5 });
    assert.match(text, /対象: 記録 3 本・Bash の呼び出し 5 件\(2026-09-10 〜 2026-09-14\)/);
    assert.match(text, /絞り込み: cwd が \/w\/irc で始まる/);
    assert.match(text, /拒否: 1 件\(20\.0%\)/);
    assert.match(text, /背景へ書き換え: 1 件\(20\.0%\)/);
    assert.match(text, /既に背景の重い走行: 1 件\(20\.0%\)/);
    assert.match(text, /何もしない: 2 件\(40\.0%\)/);
    assert.match(text, /包む: 2 件\(default:batch 2\)/);
    assert.match(text, /鍵だけ: 1 件/);
    assert.match(text, /素通し: 0 件/);
    assert.match(text, /拒否の例[^\n]*\n {2}2026-09-12 01:00 {2}\/w\/irc {2}\/usr\/bin\/git commit -m x\n/);
  });

  it('0 件なら割合も例も出さない', async () => {
    const empty = await replay({ dir: mkdtempSync(join(tmpdir(), 'crep-')), cwdPrefix: null, since: null, profilesFor: defaults, examples: 5, git: true });
    const text = formatReport(empty, { cwdPrefix: null, sinceDays: 7, examples: 5 });
    assert.match(text, /Bash の呼び出しは 0 件/);
    assert.match(text, /絞り込み: 直近 7 日/);
    assert.doesNotMatch(text, /NaN|拒否の例/);
  });

  it('ヒアドキュメントの本文は数えず、例には判定を起こした部分を添える', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crep-'));
    mkdirSync(join(root, 'p'));
    const heredocOnly = "cat > notes.md <<'EOF'\nrun npm test and cargo build here\nEOF";
    const thenTest = "cat > notes.md <<'EOF'\nsome text\nEOF\nnpm test";
    writeFileSync(join(root, 'p', 's.jsonl'), [bashLine({ id: 'h1', command: heredocOnly }), bashLine({ id: 'h2', command: thenTest })].join('\n') + '\n');
    const r = await replay({ dir: root, cwdPrefix: null, since: null, profilesFor: defaults, examples: 5, git: true });
    assert.equal(r.hook.background, 1, '本文の中の npm test は数えない');
    assert.equal(r.examples.background[0].trigger, 'npm test');
    assert.match(formatReport(r, { cwdPrefix: null, sinceDays: null, examples: 5 }), /→ 判定した部分: npm test/);
  });

  it('例のコマンドは 1 行にまとめ、長ければ 120 字で切る', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crep-'));
    mkdirSync(join(root, 'p'));
    const long = `npm test -- ${'x'.repeat(200)}\n  && echo done`;
    writeFileSync(join(root, 'p', 's.jsonl'), bashLine({ id: 'l1', command: long }) + '\n');
    const r = await replay({ dir: root, cwdPrefix: null, since: null, profilesFor: defaults, examples: 5, git: true });
    const example = formatReport(r, { cwdPrefix: null, sinceDays: null, examples: 5 })
      .split('\n')
      .find((l) => l.includes('npm test -- x'));
    assert.ok(example !== undefined);
    const shown = example.slice(example.indexOf('npm test'));
    assert.equal(shown, `${`npm test -- ${'x'.repeat(200)}`.slice(0, 120)}…`);
  });
});
