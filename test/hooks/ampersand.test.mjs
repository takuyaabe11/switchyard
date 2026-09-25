// @ts-check
// 重い走行を最後の & で裏に回す呼び出しを、& を外して背景実行にする(src/hooks/ampersand.mjs・shell の trailingAmpersand・hook の入口・report・replay)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PROFILES } from '../../src/config/profiles.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { foregroundAmpersand, withoutTrailingAmpersand } from '../../src/hooks/ampersand.mjs';
import { runHook } from '../../src/hooks/main.mjs';
import { simpleCommands, trailingAmpersand } from '../../src/hooks/shell.mjs';
import { formatReport as formatReplay, replay } from '../../src/replay/replay.mjs';
import { formatReport, summarize } from '../../src/report/report.mjs';

describe('trailingAmpersand(最後の & の位置)', () => {
  it('いちばん外側の & が 1 つだけで、コマンドの最後にあれば、その位置', () => {
    assert.equal(trailingAmpersand('npm test &'), 9);
    assert.equal(trailingAmpersand('npm test > log 2>&1 &'), 20);
    assert.equal(trailingAmpersand('cd a && npm test &> log &'), 24);
    assert.equal(trailingAmpersand('npm test & # 裏で'), 9);
    assert.equal(trailingAmpersand('npm test &\n'), 9);
    assert.equal(trailingAmpersand('npm test && echo ok &'), 20);
    // ( … ) の中の & は数えない(外側の最後の & だけ)
    assert.equal(trailingAmpersand('(npm test & sleep 1) &'), 21);
  });

  it('途中の &・2 つ以上の &・&& だけ・リダイレクトの &・引用符・( … )・heredoc の本文の & は数えない', () => {
    for (const c of ['npm test & wait', 'npm test &\necho started', 'a & b &', 'npm test &&', 'npm test 2>&1', 'npm test &> log', 'echo "a &"', "echo 'a &'", '(npm test &)', 'x=$(npm test &)', 'cat <<EOF\nnpm test &\nEOF', 'npm test | tee log']) {
      assert.equal(trailingAmpersand(c), -1, c);
    }
  });

  it('区切りの読み方を変えても、単純コマンドの分け方は変わらない', () => {
    assert.deepEqual(simpleCommands('a && b || c | d & e; f'), [['a'], ['b'], ['c'], ['d'], ['e'], ['f']]);
  });

  it('withoutTrailingAmpersand は & と前の空白を外す(& だけのコマンドは null)', () => {
    assert.equal(withoutTrailingAmpersand('npm test > log 2>&1 &'), 'npm test > log 2>&1');
    assert.equal(withoutTrailingAmpersand('npm test'), null);
    assert.equal(withoutTrailingAmpersand(' &'), null);
  });
});

describe('foregroundAmpersand(書き換え)', () => {
  const cmd = 'npm test > log 2>&1 &';
  it('& を外して背景実行にし、背景では効かない timeout を外す。他の書き換えの上に重ねる', () => {
    assert.deepEqual(foregroundAmpersand({ command: cmd, timeout: 300_000, description: 'd' }, null, {}, true), {
      out: { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'npm test > log 2>&1', description: 'd', run_in_background: true } } },
      applied: true,
    });
    const extended = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: `cd x && ${cmd}`, timeout: 240_000, run_in_background: true } } };
    assert.deepEqual(foregroundAmpersand({ command: 'x' }, extended, {}, true).out, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'cd x && npm test > log 2>&1', run_in_background: true } },
    });
  });

  it('重い走行が無い・拒否・承認を求める・最後の & でない・SWITCHYARD_AMP_BACKGROUND=0 は触らない', () => {
    assert.equal(foregroundAmpersand({ command: cmd }, null, {}, false).applied, false);
    for (const decision of ['deny', 'ask']) {
      const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: 'r' } };
      assert.equal(foregroundAmpersand({ command: cmd }, out, {}, true).out, out, decision);
    }
    assert.equal(foregroundAmpersand({ command: 'npm test & wait' }, null, {}, true).applied, false);
    assert.equal(foregroundAmpersand({ command: cmd }, null, { SWITCHYARD_AMP_BACKGROUND: '0' }, true).applied, false);
  });
});

describe('hook の入口・report・replay', () => {
  /** @param {string} command @param {string} cwd */
  const pre = (command, cwd) => JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

  it('runHook は重い走行の最後の & を外して背景実行にし、hooks.jsonl に amp-background を残す。重くない走行は触らない', async () => {
    const home = mkdtempSync(join(tmpdir(), 'camp-'));
    const cwd = mkdtempSync(join(tmpdir(), 'campcwd-'));
    /** @type {string[]} */
    const out = [];
    const env = { SWITCHYARD_HOME: home, SWITCHYARD_BACKGROUND: 'never' };
    await runHook('pre-tool-use', pre('npm test > /tmp/t.log 2>&1 &', cwd), { env, profilesFor: () => DEFAULT_PROFILES, write: (s) => out.push(s) });
    assert.deepEqual(JSON.parse(out[0]).hookSpecificOutput.updatedInput, { command: 'npm test > /tmp/t.log 2>&1', run_in_background: true });
    const rows = readFileSync(pathsOf(home).hooks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.filter((r) => r.decision === 'amp-background').length, 1);
    out.length = 0;
    await runHook('pre-tool-use', pre('python3 -m http.server 8000 &', cwd), { env, profilesFor: () => DEFAULT_PROFILES, write: (s) => out.push(s) });
    assert.equal(out.length, 0);
    // 観察だけのモードでは書き換えない
    await runHook('pre-tool-use', pre('npm test &', cwd), { env: { ...env, SWITCHYARD_OBSERVE: '1' }, profilesFor: () => DEFAULT_PROFILES, write: (s) => out.push(s) });
    assert.equal(out.length, 0);
  });

  it('report は amp-background を数えて文面に出す', () => {
    const hooks = [{ at: 1, kind: 'hook', decision: 'amp-background', session: 's', cwd: '/r', cmd: 'npm test' }];
    const s = summarize({ events: [], hooks });
    assert.equal(s.hook.ampBackground, 1);
    assert.match(formatReport(s, { repoPrefix: null, sinceDays: null }), /& で裏に回した重い走行を背景実行にした 1 件/);
  });

  it('replay は、今の設定なら & を外して背景実行にした重い走行を数える', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'campr-'));
    mkdirSync(join(dir, 'p'));
    const line = (/** @type {string} */ id, /** @type {string} */ command) =>
      JSON.stringify({ type: 'assistant', cwd: '/w', timestamp: '2026-09-10T00:00:00.000Z', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
    writeFileSync(join(dir, 'p', 's.jsonl'), `${[line('a', 'npm test > t.log 2>&1 &'), line('b', 'npm test'), line('c', 'ls &'), line('d', 'npm test & wait')].join('\n')}\n`);
    const r = await replay({ dir, cwdPrefix: null, since: null, profilesFor: () => DEFAULT_PROFILES, examples: 3 });
    assert.equal(r.hook.ampBackground, 1);
    assert.match(formatReplay(r, { cwdPrefix: null, sinceDays: null, examples: 3 }), /& で裏に回した重い走行を背景実行にする\(上と重なる\): 1 件\(25\.0%\)/);
  });
});
