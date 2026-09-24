// @ts-check
// Bash の時間切れで長い走行が切られないようにする(src/hooks/timeouts.mjs・hook の入口での組み立て)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EstimateBook } from '../../src/core/estimate.mjs';
import { usageKey } from '../../src/core/usage.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { runHook } from '../../src/hooks/main.mjs';
import { DEFAULT_TIMEOUT_MS, guardTimeout, limitsOf, MAX_TIMEOUT_MS, neededTime, readTimedOut, rememberTimedOut, REMEMBER_LIMIT, timedOutAfter } from '../../src/hooks/timeouts.mjs';
import { openClient } from '../../testkit/client.mjs';
import { jobRequest } from '../../testkit/requests.mjs';
import { SH_BIN, WIN } from '../../testkit/platform.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** @type {import('../../src/config/profiles.mjs').NamedProfile[]} */
const PROFILES = [{ name: 'unit', profile: { match: ['npm test*'], class: 'batch' } }];

/** @param {string} command @param {string} cwd @param {Record<string, unknown>} [extra] */
const pre = (command, cwd, extra = {}) => JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, ...extra } });

describe('時間切れの読み方と、要る時間の見積もり', () => {
  it('時間切れと上限: 既定 2 分・上限 10 分・Claude が渡した timeout・BASH_DEFAULT_TIMEOUT_MS・BASH_MAX_TIMEOUT_MS(上限は既定との大きい方)', () => {
    assert.deepEqual(limitsOf({}, {}), { limit: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
    assert.deepEqual(limitsOf({ timeout: 3000 }, {}), { limit: 3000, max: MAX_TIMEOUT_MS });
    assert.deepEqual(limitsOf({ timeout: 9_000_000 }, {}), { limit: MAX_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
    assert.deepEqual(limitsOf({}, { BASH_DEFAULT_TIMEOUT_MS: '300000', BASH_MAX_TIMEOUT_MS: '1200000' }), { limit: 300_000, max: 1_200_000 });
    assert.deepEqual(limitsOf({}, { BASH_DEFAULT_TIMEOUT_MS: '900000' }), { limit: 900_000, max: 900_000 });
  });

  it('Claude Code の時間切れの文面から、切られた時間を読む', () => {
    assert.equal(timedOutAfter('Exit code 143\nCommand timed out after 3s'), 3000);
    assert.equal(timedOutAfter('Command timed out after 2m 0s'), 120_000);
    assert.equal(timedOutAfter('Command timed out after 1m 30.5s'), 90_500);
    assert.equal(timedOutAfter('Command timed out after 1h 2m'), 3_720_000);
    assert.equal(timedOutAfter('Exit code 1\nnpm ERR! Test failed'), null);
  });

  it('要る時間: 前の時間切れの倍と、自分で終わった最長の 1.5 倍の大きい方。学んだ所要があるときだけ「終わる」と分かる', () => {
    const r = (/** @type {number} */ limitMs) => ({ root: '/r', command: 'x', limitMs, at: 0 });
    assert.equal(neededTime({ remembered: null, longestMs: null }), null);
    assert.deepEqual(neededTime({ remembered: r(120_000), longestMs: null }), { needMs: 240_000, finishes: false });
    assert.deepEqual(neededTime({ remembered: null, longestMs: 100_000 }), { needMs: 150_000, finishes: true });
    assert.deepEqual(neededTime({ remembered: r(120_000), longestMs: 200_000 }), { needMs: 300_000, finishes: true });
  });
});

describe('guardTimeout(時間切れを延ばす / 背景へ回す書き換え)', () => {
  const ti = { command: 'npm test' };
  it('要る時間が今の時間切れ以内なら何もしない', () => {
    const g = guardTimeout(ti, null, { needMs: 100_000, finishes: true }, {});
    assert.deepEqual(g, { out: null, action: null, timeoutMs: null });
  });

  it('上限以内なら timeout を要る時間(秒に切り上げ)にする。他の書き換え(switchyard run で包む)の上に重ねる', () => {
    assert.deepEqual(guardTimeout(ti, null, { needMs: 150_400, finishes: true }, {}).out, { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'npm test', timeout: 151_000 } } });
    const wrapped = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'switchyard run -- ./gradlew test' } } };
    assert.deepEqual(guardTimeout({ command: './gradlew test' }, wrapped, { needMs: 200_000, finishes: false }, {}).out, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'switchyard run -- ./gradlew test', timeout: 200_000 } },
    });
  });

  it('上限を超え、自分で終わると分かっていれば背景へ回す。終わったことが無ければ上限まで延ばすだけ(終わらない走行を背景に置き去りにしない)', () => {
    const bg = guardTimeout(ti, null, { needMs: 900_000, finishes: true }, {});
    assert.equal(bg.action, 'background');
    assert.deepEqual(bg.out, { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'npm test', run_in_background: true } } });
    const ext = guardTimeout(ti, null, { needMs: 900_000, finishes: false }, {});
    assert.deepEqual([ext.action, ext.timeoutMs], ['extend', MAX_TIMEOUT_MS]);
  });

  it('もう上限の時間切れなら、終わったことが無いコマンドには何もしない', () => {
    assert.equal(guardTimeout({ command: 'npm run dev', timeout: MAX_TIMEOUT_MS }, null, { needMs: 2 * MAX_TIMEOUT_MS, finishes: false }, {}).action, null);
  });

  it('拒否する呼び出し・もう背景の呼び出しには触らない', () => {
    const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'x' } };
    assert.equal(guardTimeout(ti, deny, { needMs: 900_000, finishes: true }, {}).out, deny);
    const bg = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'npm test', run_in_background: true } } };
    assert.equal(guardTimeout(ti, bg, { needMs: 900_000, finishes: true }, {}).out, bg);
    assert.equal(guardTimeout({ command: 'npm test', run_in_background: true }, null, { needMs: 900_000, finishes: true }, {}).out, null);
  });

  it('承認を求める判定(ask)には、延ばした timeout を添えて承認の求めは残す', () => {
    const ask = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'r' } };
    assert.deepEqual(guardTimeout(ti, ask, { needMs: 200_000, finishes: true }, {}).out, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'r', updatedInput: { command: 'npm test', timeout: 200_000 } },
    });
  });
});

describe('時間切れを覚える(timeouts.json と、sh のふるいが読む timeouts.txt)', () => {
  it('同じ場所・同じコマンドは上書きし、古いもの(30 日)と多すぎる分を捨て、ふるいの一覧は JSON の文字列の中身の形で書く', () => {
    const home = mkdtempSync(join(tmpdir(), 'cto-'));
    const env = { SWITCHYARD_HOME: home };
    const day = 86_400_000;
    rememberTimedOut(env, { root: '/r', command: 'old', limitMs: 1, at: 0 }, 0);
    rememberTimedOut(env, { root: '/r', command: 'npm test', exact: 'npm  test', limitMs: 120_000, at: 40 * day }, 40 * day);
    rememberTimedOut(env, { root: '/r', command: 'npm test', exact: 'npm  test', limitMs: 240_000, at: 41 * day }, 41 * day);
    rememberTimedOut(env, { root: '/r', command: 'echo "a"', limitMs: 3000, at: 41 * day }, 41 * day);
    assert.deepEqual(
      readTimedOut(env).map((e) => [e.command, e.limitMs]),
      [
        ['npm test', 240_000],
        ['echo "a"', 3000],
      ],
    );
    assert.equal(readFileSync(pathsOf(home).timeoutsSieve, 'utf8'), 'npm  test\necho \\"a\\"\n');
    for (let i = 0; i < REMEMBER_LIMIT + 5; i += 1) rememberTimedOut(env, { root: '/r', command: `c${i}`, limitMs: 1, at: 41 * day }, 41 * day);
    assert.equal(readTimedOut(env).length, REMEMBER_LIMIT);
  });

  it('壊れた・無いファイルは空として読む', () => {
    const home = mkdtempSync(join(tmpdir(), 'cto-'));
    assert.deepEqual(readTimedOut({ SWITCHYARD_HOME: home }), []);
    writeFileSync(pathsOf(home).timeouts, '{broken');
    assert.deepEqual(readTimedOut({ SWITCHYARD_HOME: home }), []);
  });

  it('PreToolUse の sh のふるいは、覚えたコマンドなら重い語が無くても node の判定へ回す(SWITCHYARD_TIMEOUT_GUARD=0 なら回さない)', () => {
    const home = mkdtempSync(join(tmpdir(), 'cto-'));
    const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'ctocwd-')));
    const awk = join(ROOT, 'bin/switchyard-pretooluse.awk');
    const skips = (/** @type {string} */ command, /** @type {Record<string, string>} */ env = {}) =>
      spawnSync('awk', ['-f', awk], { input: pre(command, cwd), env: { PATH: process.env.PATH ?? '', SWITCHYARD_HOME: home, ...env } }).status === 0;
    assert.equal(skips('./scripts/e2e.sh "all"'), true);
    rememberTimedOut({ SWITCHYARD_HOME: home }, { root: cwd, command: './scripts/e2e.sh "all"', limitMs: 120_000, at: Date.now() });
    assert.equal(skips('./scripts/e2e.sh "all"'), false);
    assert.equal(skips('./scripts/e2e.sh "other"'), true);
    assert.equal(skips('./scripts/e2e.sh "all"', { SWITCHYARD_TIMEOUT_GUARD: '0' }), true);
  });
});

describe('hook の入口での組み立て(runHook)', () => {
  it('前に時間切れで切られたコマンドは、次に同じ repo で走るとき時間切れを倍に延ばし、hooks.jsonl に extend と残す', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cto-'));
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'ctorepo-')));
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'sub'));
    const env = { SWITCHYARD_HOME: home };
    rememberTimedOut(env, { root: repo, command: './slow.sh', limitMs: 120_000, at: Date.now() });
    /** @type {string[]} */
    const out = [];
    // 場所が repo の中の別のディレクトリでも、同じ repo なら同じコマンド
    await runHook('pre-tool-use', pre('./slow.sh', join(repo, 'sub')), { env, profilesFor: () => PROFILES, write: (s) => out.push(s) });
    assert.deepEqual(JSON.parse(out[0]), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: './slow.sh', timeout: 240_000 } } });
    const rows = readFileSync(pathsOf(home).hooks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => [r.decision, r.timeoutMs, r.reason]), [['extend', 240_000, 'timed-out-before']]);
    // 別の repo・SWITCHYARD_TIMEOUT_GUARD=0 では何もしない
    const other = realpathSync.native(mkdtempSync(join(tmpdir(), 'ctorepo-')));
    out.length = 0;
    await runHook('pre-tool-use', pre('./slow.sh', other), { env, profilesFor: () => PROFILES, write: (s) => out.push(s) });
    await runHook('pre-tool-use', pre('./slow.sh', repo), { env: { ...env, SWITCHYARD_TIMEOUT_GUARD: '0' }, profilesFor: () => PROFILES, write: (s) => out.push(s) });
    assert.deepEqual(out, []);
  });

  it('デーモンが学んだ、自分で終わった最長の所要が時間切れを超える重い走行は、時間切れを延ばす(待ちが無ければ前景のまま)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cto-'));
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'ctorepo-')));
    mkdirSync(join(repo, '.git'));
    const d = await startDaemon({ home, capacity: 4, tickMs: 20 });
    try {
      // 200 秒で終わった走行を 1 本、帳簿に入れる
      const c = await openClient(pathsOf(home).sock);
      c.send({ t: 'request', job: jobRequest({ repo, profile: 'unit', cpus: { min: 1, max: 1 } }) });
      const acc = await c.next((m) => m.t === 'accepted');
      await c.next((m) => m.t === 'grant');
      c.send({ t: 'started', jobId: acc.jobId, pid: process.pid, pgid: null });
      c.send({ t: 'exit', jobId: acc.jobId, code: 1, killedByCaller: false, durationMs: 200_000, escape: null, cpuMs: null });
      await c.next((m) => m.t === 'ok');
      c.close();
      /** @type {string[]} */
      const out = [];
      await runHook('pre-tool-use', pre('npm test', repo), { env: { SWITCHYARD_HOME: home }, profilesFor: () => PROFILES, write: (s) => out.push(s) });
      assert.deepEqual(JSON.parse(out[0]), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'npm test', timeout: 300_000 } } });
    } finally {
      await d.close();
    }
  });
});

describe('学んだ所要の帳簿(自分で終わった走行の最長)', () => {
  it('成否を問わず自分で終わった走行を数え、信号で終わった(時間切れ・Ctrl-C で殺された)走行は数えない', () => {
    const b = new EstimateBook();
    b.record('/r', 'unit', 1000, 0);
    b.record('/r', 'unit', 5000, 1);
    b.record('/r', 'unit', 99_000, 143);
    b.record('/r', 'unit', 99_000, 130);
    b.record('/r', 'dev', 120_000, 143);
    assert.deepEqual(b.longestAll(), { [usageKey('/r', 'unit')]: 5000 });
    // 所要の見込み(成功だけの中央値)は変わらない
    assert.equal(b.expected('/r', 'unit'), null);
  });
});

describe('PostToolUseFailure の入口の sh のふるい', () => {
  it('時間切れ・ポートの文言が無い失敗では node を起動せず何も出さない。あれば node の判定へ渡す', { skip: WIN ? '入口の sh はふるいの語だけを見る(Windows の Git Bash の sh でも同じだが、PATH の node の差し替えが POSIX の形)' : false }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfsh-'));
    // node の代わりに、渡された入力を書き出すだけの偽物を PATH の先頭に置く
    writeFileSync(join(dir, 'node'), '#!/bin/sh\ncat > "$(dirname "$0")/called"\necho called\n');
    execFileSync('chmod', ['+x', join(dir, 'node')]);
    const run = (/** @type {string} */ error) =>
      execFileSync(SH_BIN, [join(ROOT, 'bin/switchyard-posttoolusefailure.sh')], {
        input: JSON.stringify({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'x' }, error }),
        encoding: 'utf8',
        env: { PATH: `${dir}:${process.env.PATH}` },
      });
    assert.equal(run('Exit code 1\nnpm ERR! Test failed'), '');
    assert.equal(run('Exit code 143\nCommand timed out after 2m 0s'), 'called\n');
    assert.equal(run('Error: listen EADDRINUSE: address already in use :::3000'), 'called\n');
    assert.equal(run('Error: listen EADDRINUSE :::3000'), 'called\n');
    assert.equal(run('Bind for 0.0.0.0:5432 failed: port is already allocated'), 'called\n');
    assert.equal(run('OSError: [Errno 98] Address already in use'), 'called\n');
  });
});
