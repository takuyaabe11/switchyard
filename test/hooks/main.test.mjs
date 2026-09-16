// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { runHook } from '../../src/hooks/main.mjs';
import { preToolUse } from '../../src/hooks/pretooluse.mjs';

/** @type {import('../../src/config/profiles.mjs').NamedProfile[]} */
const PROFILES = [{ name: 'unit', profile: { match: ['npm test*'], class: 'batch' } }];

/** hook の標準入力(Bash) @param {string} command */
const bash = (command) => JSON.stringify({ session_id: 's1', cwd: '/repo', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

describe('runHook(pre-tool-use)の記録(設計 §4.2・§9.2)', () => {
  it('背景へ回した判断と拒否した判断を hooks.jsonl に残し、何もしなかった分は書かない', async () => {
    const home = mkdtempSync(join(tmpdir(), 'chook-'));
    const opts = { env: { SWITCHYARD_HOME: home }, profilesFor: () => PROFILES, write: () => {} };
    await runHook('pre-tool-use', bash('npm test'), opts);
    await runHook('pre-tool-use', bash('/usr/local/bin/npm test'), opts);
    await runHook('pre-tool-use', bash('echo hi'), opts);
    const rows = readFileSync(pathsOf(home).hooks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(
      rows.map((r) => [r.kind, r.decision, r.cmd, r.session, r.cwd, typeof r.at]),
      [
        ['hook', 'background', 'npm test', 's1', '/repo', 'number'],
        ['hook', 'deny', '/usr/local/bin/npm test', 's1', '/repo', 'number'],
      ],
    );
  });

  it('判定そのもの(preToolUse)は何も書かない — switchyard replay の空回しが記録を汚さないため', () => {
    const home = mkdtempSync(join(tmpdir(), 'chook-'));
    const out = preToolUse(JSON.parse(bash('npm test')), { env: { SWITCHYARD_HOME: home }, profilesFor: () => PROFILES });
    assert.notEqual(out, null);
    assert.equal(existsSync(pathsOf(home).hooks), false);
  });

  it('記録の置き場所へ書けなくても、判断はそのまま返す', async () => {
    /** @type {string[]} */
    const written = [];
    // SWITCHYARD_HOME をファイル(ディレクトリを作れない場所)にして、記録の書き込みだけを失敗させる
    const file = join(mkdtempSync(join(tmpdir(), 'chook-')), 'not-a-dir');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, '');
    await runHook('pre-tool-use', bash('npm test'), { env: { SWITCHYARD_HOME: file }, profilesFor: () => PROFILES, write: (s) => written.push(s) });
    assert.equal(written.length, 1);
    assert.match(written[0], /run_in_background/);
  });
});
