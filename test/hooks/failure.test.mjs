// @ts-check
// PostToolUseFailure(Bash): 失敗のうち、コードのせいではないもの(時間切れ・ポートが使用中)を Claude に知らせる(src/hooks/failure.mjs)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { postToolUseFailure } from '../../src/hooks/failure.mjs';
import { runHook } from '../../src/hooks/main.mjs';
import { readTimedOut } from '../../src/hooks/timeouts.mjs';
import { setLang } from '../../src/i18n.mjs';

/** 英語で走らせる(終わったら日本語へ戻す) @template T @param {() => T} f @returns {T} */
const inEnglish = (f) => {
  setLang('en');
  try {
    return f();
  } finally {
    setLang('ja');
  }
};

/** 実物の入力の形(Claude Code 2.1 で確かめた) @param {string} command @param {string} error @param {Record<string, unknown>} [extra] */
const failed = (command, error, extra = {}) => ({ session_id: 's1', cwd: '/w/app', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command }, tool_use_id: 't', error, is_interrupt: false, duration_ms: 1, ...extra });

/** @param {ReturnType<typeof postToolUseFailure>} r */
const context = (r) => String(/** @type {any} */ (r.out)?.hookSpecificOutput?.additionalContext ?? '');

const noHolders = { holders: () => [], detail: () => ({ command: null, cwd: null, elapsedSec: null }), remember: () => {} };

describe('postToolUseFailure(時間切れ)', () => {
  it('切られた時間と、次に延ばす時間(倍)を伝え、場所(repo の根)とコマンドを覚える', () => {
    /** @type {any[]} */
    const remembered = [];
    const r = postToolUseFailure(failed('npm  test', 'Exit code 143\nCommand timed out after 2m 0s'), {}, { ...noHolders, remember: (_env, e) => remembered.push(e), now: () => 7 });
    assert.match(context(r), /Bash の時間切れ\(2分\)で切られた。コードのせいではない。.*時間切れを 4分 に延ばす/);
    assert.equal(r.out?.hookSpecificOutput && /** @type {any} */ (r.out.hookSpecificOutput).hookEventName, 'PostToolUseFailure');
    assert.deepEqual(remembered, [{ root: '/w/app', command: 'npm test', exact: 'npm  test', limitMs: 120_000, at: 7 }]);
    assert.deepEqual(r.records, [{ decision: 'timeout', limitMs: 120_000 }]);
  });

  it('秘密らしい値を含むコマンドと、コマンドを記録しない設定では、コマンドを覚えず、Claude に自分で timeout を渡すよう伝える', () => {
    /** @type {any[]} */
    const remembered = [];
    const deps = { ...noHolders, remember: (/** @type {any} */ _env, /** @type {any} */ e) => remembered.push(e) };
    const secret = postToolUseFailure(failed('API_TOKEN=abc123 npm test', 'Command timed out after 2m 0s'), {}, deps);
    assert.match(context(secret), /このコマンドは覚えない.*timeout に 240000 ミリ秒ほど/);
    assert.deepEqual(secret.records, [{ decision: 'timeout', limitMs: 120_000, remembered: false }]);
    const none = postToolUseFailure(failed('npm test', 'Command timed out after 2m 0s'), { SWITCHYARD_LOG_COMMANDS: 'none' }, deps);
    assert.match(context(none), /このコマンドは覚えない/);
    assert.deepEqual(remembered, []);
  });

  it('上限(10 分)で切られたら、延ばせないので背景で走らせるよう伝える', () => {
    const r = postToolUseFailure(failed('npm test', 'Command timed out after 10m 0s'), {}, noHolders);
    assert.match(context(r), /上限\(10分\)で切られた。これ以上は延ばせない。.*run_in_background/);
  });

  it('英語でも伝える。人が止めた(is_interrupt)・Bash 以外・SWITCHYARD_OFF・SWITCHYARD_TIMEOUT_GUARD=0 では何もしない', () => {
    assert.match(context(inEnglish(() => postToolUseFailure(failed('x', 'Command timed out after 3s'), {}, noHolders))), /cut off by the Bash time limit \(3s\).*gives it 6s/);
    assert.equal(postToolUseFailure(failed('x', 'Command timed out after 3s', { is_interrupt: true }), {}, noHolders).out, null);
    assert.equal(postToolUseFailure({ ...failed('x', 'Command timed out after 3s'), tool_name: 'Read' }, {}, noHolders).out, null);
    assert.equal(postToolUseFailure(failed('x', 'Command timed out after 3s'), { SWITCHYARD_OFF: '1' }, noHolders).out, null);
    assert.equal(postToolUseFailure(failed('x', 'Command timed out after 3s'), { SWITCHYARD_TIMEOUT_GUARD: '0' }, noHolders).out, null);
  });

  it('時間切れでもポートでもない失敗(テストが赤い)には何も言わない', () => {
    const r = postToolUseFailure(failed('npm test', 'Exit code 1\n1 failing'), {}, noHolders);
    assert.deepEqual(r, { out: null, records: [] });
  });
});

describe('postToolUseFailure(ポートが使用中)', () => {
  it('握っているプロセスの pid・コマンド・走っている時間・作業場所を伝え、止め方を添える', () => {
    const r = postToolUseFailure(failed('npm run dev', 'Error: listen EADDRINUSE: address already in use :::3000'), {}, {
      ...noHolders,
      holders: (p) => (p === 3000 ? [{ pid: 4321, name: 'node' }] : []),
      detail: () => ({ command: 'node server.js', cwd: '/w/app-wt2', elapsedSec: 1500 }),
    });
    assert.match(context(r), /ポート 3000 が使用中で起動できなかった。コードのせいではない。握っているのは pid 4321\(node server\.js・25分前から・作業場所 \/w\/app-wt2\)。.*kill 4321/);
    assert.deepEqual(r.records, [{ decision: 'port', port: 3000, holders: 1 }]);
  });

  it('Docker が公開しているポートは docker ps で確かめるよう伝える', () => {
    const r = inEnglish(() =>
      postToolUseFailure(failed('docker compose up', 'Bind for 0.0.0.0:5432 failed: port is already allocated'), {}, {
        ...noHolders,
        holders: () => [{ pid: 77, name: 'docker-proxy' }],
      }),
    );
    assert.match(context(r), /Port 5432 is already in use.*A Docker container publishes this port \(pid 77 \(docker-proxy\)\)\. Check with docker ps/);
  });

  it('握っているプロセスが見つからない・番号が読めないときも、コードのせいではないことは伝える', () => {
    assert.match(context(postToolUseFailure(failed('npm run dev', 'listen EADDRINUSE: address already in use :::3000'), {}, noHolders)), /ポート 3000 が使用中.*握っているプロセスは見つからなかった/);
    const r = postToolUseFailure(failed('python serve.py', 'OSError: [Errno 98] Address already in use'), {}, noHolders);
    assert.match(context(r), /番号は出力から読めなかった/);
    assert.deepEqual(r.records, [{ decision: 'port', port: null, holders: 0 }]);
  });

  it('ポートを調べる道具が失敗しても、hook は止まらない', () => {
    const r = postToolUseFailure(failed('npm run dev', 'listen EADDRINUSE :::3000'), {}, {
      ...noHolders,
      holders: () => {
        throw new Error('lsof が壊れている');
      },
    });
    assert.match(context(r), /握っているプロセスは見つからなかった/);
  });
});

describe('runHook(post-tool-use-failure)', () => {
  it('知らせを書き、hooks.jsonl に残し、時間切れを覚える。観察だけのモードでは記録だけ(何も書かず、覚えない)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cfail-'));
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'cfailrepo-')));
    mkdirSync(join(repo, '.git'));
    const input = JSON.stringify({ ...failed('npm test', 'Exit code 143\nCommand timed out after 2m 0s'), cwd: repo });
    /** @type {string[]} */
    const out = [];
    await runHook('post-tool-use-failure', input, { env: { SWITCHYARD_HOME: home, SWITCHYARD_OBSERVE: '1' }, write: (s) => out.push(s) });
    assert.equal(out.length, 0);
    assert.deepEqual(readTimedOut({ SWITCHYARD_HOME: home }), []);
    await runHook('post-tool-use-failure', input, { env: { SWITCHYARD_HOME: home }, write: (s) => out.push(s) });
    assert.equal(out.length, 1);
    assert.match(JSON.parse(out[0]).hookSpecificOutput.additionalContext, /\[switchyard\]/);
    assert.deepEqual(readTimedOut({ SWITCHYARD_HOME: home }).map((e) => [e.root, e.command, e.limitMs]), [[repo, 'npm test', 120_000]]);
    const rows = readFileSync(pathsOf(home).hooks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => [r.kind, r.decision, r.limitMs, r.observe === true, r.cmd]), [
      ['hook', 'timeout', 120_000, true, 'npm test'],
      ['hook', 'timeout', 120_000, false, 'npm test'],
    ]);
  });
});
