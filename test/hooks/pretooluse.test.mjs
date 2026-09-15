// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROFILES } from '../../src/config/profiles.mjs';
import { headWord, preToolUse } from '../../src/hooks/pretooluse.mjs';

/** @type {import('../../src/config/profiles.mjs').NamedProfile[]} */
const PROFILES = [
  { name: 'vitest', profile: { match: ['*vitest run*'], class: 'batch' } },
  { name: 'lint', profile: { match: ['npx eslint*'], class: 'quick' } },
  ...DEFAULT_PROFILES,
];
const opts = { env: {}, profilesFor: () => PROFILES };

/** @param {string} command @param {Record<string, unknown>} [extra] */
const bash = (command, extra = {}) => ({ session_id: 's', cwd: '/repo', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, ...extra } });

describe('headWord', () => {
  it('VAR=値 と包みのコマンドを読み飛ばして先頭の語を取る', () => {
    assert.equal(headWord('FOO=1 BAR=2 npm test').head, 'npm');
    assert.equal(headWord('timeout 60 npm test').head, 'npm');
    assert.equal(headWord('timeout -s KILL 60 npm test').head, 'npm');
    assert.equal(headWord('nice -n 5 make all').head, 'make');
    assert.equal(headWord('env -i A=1 node x.mjs').head, 'node');
    assert.deepEqual(headWord('nohup ./node_modules/.bin/vitest run'), { head: './node_modules/.bin/vitest', rest: ['run'] });
  });

  it('env の値つきのオプション(-u NAME・-C DIR など)は値の語も読み飛ばし、time / command のオプションも読み飛ばす', () => {
    assert.deepEqual(headWord('env -u FOO npm test'), { head: 'npm', rest: ['test'] });
    assert.equal(headWord('env -u FOO -C sub BAR=1 npm test').head, 'npm');
    assert.equal(headWord('time -p npm test').head, 'npm');
    assert.equal(headWord('command npm test').head, 'npm');
  });
});

describe('preToolUse(設計 §9.2)', () => {
  it('batch を前景で打ったら、run_in_background だけを true にし、決定は付けない', () => {
    assert.deepEqual(preToolUse(bash('npm test', { description: 'テスト', timeout: 120000 }), opts), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'npm test', description: 'テスト', timeout: 120000, run_in_background: true } },
    });
  });

  it('既に背景なら何もしない', () => {
    assert.equal(preToolUse(bash('npm test', { run_in_background: true }), opts), null);
  });

  it('quick と管理外は前景のまま通す', () => {
    assert.equal(preToolUse(bash('npm install'), opts), null);
    assert.equal(preToolUse(bash('npx eslint src'), opts), null);
  });

  it('包みのコマンドの後ろの measure も背景に回す', () => {
    const out = /** @type {any} */ (preToolUse(bash('timeout 600 node benchmarks/run.mjs'), opts));
    assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, true);
  });

  it('区切りの後ろの部分が batch でも背景に回す', () => {
    const out = /** @type {any} */ (preToolUse(bash('cd sub && npm test'), opts));
    assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, true);
  });

  it('管理対象なのに shim を通らない形は拒否し、直し方を示す', () => {
    const out = /** @type {any} */ (preToolUse(bash('./node_modules/.bin/vitest run'), opts));
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /\.\/node_modules\/\.bin\/vitest run/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /conductor run -- <その部分>/);
  });

  it('パスで呼ぶ git commit は拒否し、git commit は通す', () => {
    assert.equal(/** @type {any} */ (preToolUse(bash('/usr/bin/git commit -m x'), opts)).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(preToolUse(bash('git commit -m x'), opts), null);
  });

  it('拒否は背景への書き換えより先に効く', () => {
    assert.equal(/** @type {any} */ (preToolUse(bash('npm test && ./node_modules/.bin/vitest run'), opts)).hookSpecificOutput.permissionDecision, 'deny');
  });

  it('conductor run で包んだ部分は拒否しない。背景への判定は包みが要求する性格で行う', () => {
    assert.equal(preToolUse(bash('conductor run --class quick -- ./node_modules/.bin/vitest run'), opts), null);
    const out = /** @type {any} */ (preToolUse(bash('conductor run -- ./node_modules/.bin/vitest run'), opts));
    assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'PreToolUse', updatedInput: { command: 'conductor run -- ./node_modules/.bin/vitest run', run_in_background: true } });
  });

  it('CONDUCTOR_THINKER=1 と Bash 以外では何もしない', () => {
    assert.equal(preToolUse(bash('./node_modules/.bin/vitest run'), { ...opts, env: { CONDUCTOR_THINKER: '1' } }), null);
    assert.equal(preToolUse({ ...bash('npm test'), tool_name: 'Read' }, opts), null);
  });
});
