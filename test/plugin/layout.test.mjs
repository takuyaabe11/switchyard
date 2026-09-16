// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIM_WORDS } from '../../src/hooks/pretooluse.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** @param {string} rel */
const json = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
/** @param {string} rel */
const executable = (rel) => (statSync(join(ROOT, rel)).mode & 0o111) !== 0;

/** 呼び出し元の PATH から shims を除いたもの */
const BASE_PATH = (process.env.PATH ?? '')
  .split(':')
  .filter((d) => d !== '' && (!existsSync(d) || realpathSync(d) !== realpathSync(join(ROOT, 'shims'))))
  .join(':');

describe('plugin の形(設計 §9・§9.6)', () => {
  it('plugin.json と marketplace.json の名前と版が、package.json の版とそろう', () => {
    const plugin = json('.claude-plugin/plugin.json');
    const market = json('.claude-plugin/marketplace.json');
    const version = json('package.json').version;
    assert.deepEqual([plugin.name, plugin.version], ['switchyard', version]);
    assert.deepEqual([market.plugins[0].name, market.plugins[0].version, market.plugins[0].source], [plugin.name, version, './']);
  });

  it('package-lock.json の版も package.json とそろう(npm ci が食い違わない)', () => {
    const lock = json('package-lock.json');
    const version = json('package.json').version;
    assert.deepEqual([lock.name, lock.version, lock.packages[''].version], ['switchyard', version, version]);
  });

  it('hooks.json は SessionStart・PreToolUse(Bash)・Stop だけを、plugin の hook の入口へつなぐ', () => {
    const hooks = json('hooks/hooks.json').hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop']);
    assert.equal(hooks.PreToolUse[0].matcher, 'Bash');
    /** @type {Record<string, string>} */
    const arg = { SessionStart: 'session-start', PreToolUse: 'pre-tool-use', Stop: 'stop' };
    for (const [event, entries] of Object.entries(hooks)) {
      assert.equal(entries[0].hooks[0].command, `node "\${CLAUDE_PLUGIN_ROOT}/bin/switchyard-hook.mjs" ${arg[event]}`);
    }
    assert.ok(existsSync(join(ROOT, 'bin/switchyard-hook.mjs')));
  });

  it('hooks.json のコマンドを sh で実際に走らせると、判定の無い入力には何も出さずに終わる', () => {
    const command = json('hooks/hooks.json').hooks.PreToolUse[0].hooks[0].command;
    const out = execFileSync('/bin/sh', ['-c', command], { input: JSON.stringify({ tool_name: 'Read', tool_input: {} }), encoding: 'utf8', env: { PATH: BASE_PATH, CLAUDE_PLUGIN_ROOT: ROOT } });
    assert.equal(out, '');
  });

  it('shims/ の実行ファイルは、PreToolUse が知っている 8 語とちょうど同じ', () => {
    const files = readdirSync(join(ROOT, 'shims')).filter((f) => !f.startsWith('_'));
    assert.deepEqual(files.sort(), [...SHIM_WORDS].sort());
    for (const f of files) assert.ok(executable(`shims/${f}`), f);
  });

  it('bin/switchyard は実行でき、CLI へつながる', () => {
    assert.ok(executable('bin/switchyard'));
    assert.match(execFileSync(join(ROOT, 'bin/switchyard'), ['help'], { encoding: 'utf8', env: { PATH: BASE_PATH } }), /^使い方:/);
  });

  it('skill switchyard は名前と説明を持つ', () => {
    const text = readFileSync(join(ROOT, 'skills/switchyard/SKILL.md'), 'utf8');
    assert.match(text, /^---\nname: switchyard\ndescription: .+\n---\n/);
  });

  it('コマンド /switchyard:status は説明を持ち、状態の 3 つ(統治下か・走行と待ち・直近の集計)を指す', () => {
    const text = readFileSync(join(ROOT, 'commands/status.md'), 'utf8');
    assert.match(text, /^---\ndescription: .+\n---\n/);
    // 表示の文言ではなく、実際に走らせる口を指しているか(どれかが欠けると状態が分からない)
    for (const needle of ['which npm', 'switchyard top', 'switchyard report']) assert.ok(text.includes(needle), needle);
  });
});
