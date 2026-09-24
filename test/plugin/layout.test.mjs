// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIM_WORDS } from '../../src/hooks/pretooluse.mjs';
import { POSIX_ONLY, SH_BIN, WIN } from '../../testkit/platform.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** @param {string} rel */
const json = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
/** @param {string} rel */
const executable = (rel) => (statSync(join(ROOT, rel)).mode & 0o111) !== 0;

/** 呼び出し元の PATH から shims を除いたもの */
const BASE_PATH = (process.env.PATH ?? '')
  .split(delimiter)
  .filter((d) => d !== '' && (!existsSync(d) || realpathSync(d) !== realpathSync(join(ROOT, 'shims'))))
  .join(delimiter);

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

  it('hooks.json は SessionStart・PreToolUse(Bash)・PostToolUseFailure(Bash)・Stop だけを、plugin の hook の入口へつなぐ', () => {
    const hooks = json('hooks/hooks.json').hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUseFailure', 'PreToolUse', 'SessionStart', 'Stop']);
    assert.equal(hooks.PreToolUse[0].matcher, 'Bash');
    assert.equal(hooks.PostToolUseFailure[0].matcher, 'Bash');
    /** @type {Record<string, string>} */
    const arg = { SessionStart: 'session-start', Stop: 'stop' };
    /** @type {Record<string, string>} Bash の呼び出しごとに走る hook は sh のふるいを通す(node を起動しない)。ふるいは node の同じ入口へ渡す */
    const sieve = { PreToolUse: 'switchyard-pretooluse.sh', PostToolUseFailure: 'switchyard-posttoolusefailure.sh' };
    for (const [event, entries] of Object.entries(hooks)) {
      const expected = sieve[event] !== undefined ? `sh "\${CLAUDE_PLUGIN_ROOT}/bin/${sieve[event]}"` : `node "\${CLAUDE_PLUGIN_ROOT}/bin/switchyard-hook.mjs" ${arg[event]}`;
      assert.equal(entries[0].hooks[0].command, expected);
    }
    assert.match(readFileSync(join(ROOT, 'bin/switchyard-pretooluse.sh'), 'utf8'), /switchyard-hook\.mjs" pre-tool-use/);
    assert.match(readFileSync(join(ROOT, 'bin/switchyard-posttoolusefailure.sh'), 'utf8'), /switchyard-hook\.mjs" post-tool-use-failure/);
    assert.ok(existsSync(join(ROOT, 'bin/switchyard-hook.mjs')));
  });

  it('hooks.json のコマンドを sh で実際に走らせると、判定の無い入力には何も出さずに終わる', () => {
    const command = json('hooks/hooks.json').hooks.PreToolUse[0].hooks[0].command;
    const out = execFileSync(SH_BIN, ['-c', command], { input: JSON.stringify({ tool_name: 'Read', tool_input: {} }), encoding: 'utf8', env: { PATH: BASE_PATH, CLAUDE_PLUGIN_ROOT: ROOT } });
    assert.equal(out, '');
  });

  it('shims/ の実行ファイルは、PreToolUse が知っている 21 語とちょうど同じ', () => {
    const files = readdirSync(join(ROOT, 'shims')).filter((f) => !f.startsWith('_'));
    assert.deepEqual(files.sort(), [...SHIM_WORDS].sort());
    // Windows のファイルには実行の権限の印が無い(Git Bash は shebang で起動する)
    if (!WIN) for (const f of files) assert.ok(executable(`shims/${f}`), f);
  });

  it('bin/switchyard は実行でき、CLI へつながる', { skip: POSIX_ONLY }, () => {
    assert.ok(executable('bin/switchyard'));
    assert.match(execFileSync(join(ROOT, 'bin/switchyard'), ['help'], { encoding: 'utf8', env: { PATH: BASE_PATH, SWITCHYARD_LANG: 'ja' } }), /^使い方:/);
  });

  it('言語の指定が無く、ロケールも日本語でなければ英語で出す。LANG が ja なら日本語', { skip: POSIX_ONLY }, () => {
    const help = (/** @type {Record<string, string>} */ env) => execFileSync(join(ROOT, 'bin/switchyard'), ['help'], { encoding: 'utf8', env: { PATH: BASE_PATH, ...env } });
    assert.match(help({}), /^Usage:/);
    assert.match(help({ LANG: 'en_US.UTF-8' }), /^Usage:/);
    assert.match(help({ LANG: 'ja_JP.UTF-8' }), /^使い方:/);
    assert.match(help({ LANG: 'ja_JP.UTF-8', SWITCHYARD_LANG: 'en' }), /^Usage:/);
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
