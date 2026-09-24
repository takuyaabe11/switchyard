// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, UsageError } from '../../src/cli/args.mjs';
import { cli } from '../../src/cli/main.mjs';
import { cleanUp, withoutShimLines } from '../../src/cli/uninstall.mjs';

const OWN = '/opt/plugins/switchyard/0.10.0/shims';
const line = (/** @type {string} */ p) => `export PATH='${p}':"$PATH"`;

/** 使い捨ての HOME: ~/.claude/session-env の下に環境ファイル 2 つ、~/.switchyard に記録 */
function world() {
  const root = mkdtempSync(join(tmpdir(), 'cuninst-'));
  const envDir = join(root, '.claude', 'session-env', 'sess-1');
  mkdirSync(envDir, { recursive: true });
  const a = join(envDir, 'sessionstart-hook-0.sh');
  writeFileSync(a, [line(OWN), 'export FOO=1', line('/opt/other-plugin/shims'), ''].join('\n'));
  const b = join(root, 'claude-env.sh');
  writeFileSync(b, [line('/old/cache/switchyard/0.8.0/shims'), 'export BAR=2'].join('\n'));
  const home = join(root, '.switchyard');
  mkdirSync(home);
  for (const f of ['state.json', 'events.jsonl', 'events.jsonl.1', 'hooks.jsonl', 'observed.jsonl', 'update-check.json', 'switchyardd.log', 'unmanaged.jsonl.123.taking', 'state.json.99.tmp']) {
    writeFileSync(join(home, f), '{}');
  }
  return { root, a, b, home, env: { HOME: root, CLAUDE_ENV_FILE: b } };
}

describe('switchyard uninstall', () => {
  it('withoutShimLines: switchyard の shims の行だけを除き、他の行(他の plugin の shims を含む)は変えない', () => {
    const text = [line(OWN), 'export FOO=1', line('/opt/other-plugin/shims'), line('/x/switchyard-old/shims'), ''].join('\n');
    const r = withoutShimLines(text, OWN);
    assert.equal(r.removed, 2);
    assert.equal(r.text, ['export FOO=1', line('/opt/other-plugin/shims'), ''].join('\n'));
  });

  it('--dry-run は何も変えず、することだけを返す', () => {
    const w = world();
    const before = readFileSync(w.a, 'utf8');
    const r = cleanUp({ home: w.home, env: w.env, ownShims: OWN, keepLogs: false, dryRun: true });
    assert.deepEqual(r.envFiles.map((f) => [f.file, f.removed]).sort(), [[w.a, 1], [w.b, 1]].sort());
    assert.equal(r.deleted.length, 9);
    assert.equal(r.homeRemoved, true);
    assert.equal(readFileSync(w.a, 'utf8'), before);
    assert.ok(existsSync(join(w.home, 'events.jsonl')));
  });

  it('環境ファイルから shims の行を除き、記録の置き場を消す。--keep-logs なら記録は残す', () => {
    const w = world();
    cleanUp({ home: w.home, env: w.env, ownShims: OWN, keepLogs: true, dryRun: false });
    assert.equal(readFileSync(w.a, 'utf8'), ['export FOO=1', line('/opt/other-plugin/shims'), ''].join('\n'));
    assert.equal(readFileSync(w.b, 'utf8'), 'export BAR=2');
    assert.ok(existsSync(join(w.home, 'events.jsonl')), '--keep-logs');
    const r = cleanUp({ home: w.home, env: w.env, ownShims: OWN, keepLogs: false, dryRun: false });
    assert.equal(r.envFiles.length, 0, '2 回目は取り除く行が無い');
    assert.equal(existsSync(w.home), false);
  });

  it('置き場に switchyard のものでないファイルがあれば、何も消さない(SWITCHYARD_HOME を $HOME に向けていても安全)', () => {
    const w = world();
    writeFileSync(join(w.home, 'notes.txt'), 'mine');
    const r = cleanUp({ home: w.home, env: w.env, ownShims: OWN, keepLogs: false, dryRun: false });
    assert.deepEqual(r.deleted, []);
    assert.deepEqual(r.kept, [join(w.home, 'notes.txt')]);
    assert.ok(existsSync(join(w.home, 'events.jsonl')));
    assert.ok(existsSync(join(w.home, 'notes.txt')));
  });

  it('CLI: デーモンを止め、片付けたことと残りの手順(/plugin uninstall・セッションを開き直す)を出す。引数を読む', async () => {
    const w = world();
    let out = '';
    const run = async (/** @type {string[]} */ args) => {
      out = '';
      return cli(args, { env: { ...w.env, SWITCHYARD_HOME: w.home }, cwd: tmpdir(), stdout: (s) => (out += s), stderr: (s) => (out += s) });
    };
    assert.equal(await run(['uninstall', '--dry-run']), 0);
    assert.match(out, /--dry-run/);
    assert.match(out, /shims の行を 1 行取り除く$/m);
    assert.ok(existsSync(w.home));
    const code = await run(['uninstall']);
    assert.equal(code, 0);
    assert.match(out, /^デーモン: /m);
    assert.match(out, /shims の行を 1 行取り除いた$/m);
    assert.match(out, /置き場そのものを消した/);
    assert.match(out, /\/plugin uninstall switchyard@switchyard/);
    assert.equal(existsSync(w.home), false);
    assert.deepEqual(parseArgs(['uninstall', '--keep-logs', '--dry-run']), { cmd: 'uninstall', keepLogs: true, dryRun: true });
    assert.throws(() => parseArgs(['uninstall', '--force']), UsageError);
  });
});
