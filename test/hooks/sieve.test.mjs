// @ts-check
// PreToolUse の入口の sh のふるい(bin/switchyard-pretooluse.sh・.awk)。
// ふるいが「判定は何もしない」と言って node を起動しなかった呼び出しでは、node の判定も本当に何もしないことを確かめる。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROFILES, defaultHeadWords } from '../../src/config/profiles.mjs';
import { preToolUse, SHIM_WORDS } from '../../src/hooks/pretooluse.mjs';
import { GIT_LOCK_SUBCOMMANDS } from '../../src/shim/decide.mjs';
import { basePath, SH_BIN } from '../../testkit/platform.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const AWK = join(ROOT, 'bin/switchyard-pretooluse.awk');
const SH = join(ROOT, 'bin/switchyard-pretooluse.sh');
const BASE_PATH = basePath('/usr/local/bin:/usr/bin:/bin');

/** @param {string} command @param {string} cwd @param {Record<string, unknown>} [extra] */
const input = (command, cwd, extra = {}) => ({ session_id: 's', transcript_path: '/home/u/.claude/projects/-home-u-go-node/s.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd', ...extra }, tool_use_id: 't' });

/** ふるいが node を起動しないと言うか(env はふるいに渡す環境) */
const skips = (/** @type {unknown} */ json, /** @type {Record<string, string>} */ env = {}) => {
  const r = spawnSync('awk', ['-f', AWK], { input: typeof json === 'string' ? json : JSON.stringify(json), env: { PATH: BASE_PATH, ...env } });
  assert.ok(r.status === 0 || r.status === 1, `awk の終了コード ${r.status}: ${r.stderr}`);
  return r.status === 0;
};

const bare = () => realpathSync(mkdtempSync(join(tmpdir(), 'sieve-')));

/** テストの判定の入力から集めた、いろいろな形のコマンド */
function corpus() {
  /** @type {Set<string>} */
  const out = new Set([
    'ls -la', 'cat README.md | head -50', 'grep -rn foo src', 'echo "npm test"', "sh -c 'npm test'", 'bash -lc "cargo build"',
    'FOO=1 go test ./...', 'timeout 60 make', 'env -i npm test', 'PATH=/x npm test', 'source .venv/bin/activate && pytest -q',
    '.venv/bin/pytest', './gradlew test', './mvnw verify', 'switchyard run -- ./bench.sh', 'node node_modules/.bin/vitest run',
    './node_modules/.bin/vitest run', '/usr/local/bin/npm test', '/usr/bin/git commit -m x', 'cd sub && npm run build',
    'ls\nnpm test', 'echo a;npm test', 'x=$(npm test)', 'echo `npm test`', '(npm test)', 'npm\ttest', 'rg gopher', 'tsc -b',
    'python3.11 -m pytest', 'git status', 'git add -A', 'docker build .', 'kubectl apply -f x', 'sleep 1', 'find . -name "*.go"',
    'npm-run-all build', 'cat package.json', 'vim notes', 'echo nodejs', 'echo node_modules', 'du -sh ~/go',
  ]);
  for (const f of ['test/hooks/pretooluse.test.mjs', 'test/hooks/agreement.test.mjs', 'test/hooks/main.test.mjs']) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/'((?:[^'\\\n]|\\.){3,200})'/g)) out.add(m[1].replace(/\\'/g, "'"));
  }
  return [...out];
}

describe('PreToolUse の入口のふるい(bin/switchyard-pretooluse.awk)', () => {
  it('ふるいの語は、shim の語・既定表が始まる語・包み(switchyard・gradlew・mvnw・node_modules)をすべて含む', () => {
    const text = readFileSync(AWK, 'utf8');
    const m = /\(npm\|[^)]*\)/.exec(text);
    assert.ok(m !== null);
    const words = new Set(m[0].slice(1, -1).split('|'));
    for (const w of [...defaultHeadWords(), 'switchyard', 'gradlew', 'mvnw', 'node_modules']) assert.ok(words.has(w), w);
    // 既定表に無い shim の語は node と git だけ(node は node_modules で、git はサブコマンドの語で拾う)
    assert.deepEqual(SHIM_WORDS.filter((w) => !words.has(w)).sort(), ['git', 'node']);
    const lock = /\(commit\|[^)]*\)/.exec(text);
    assert.ok(lock !== null);
    assert.deepEqual(lock[0].slice(1, -1).split('|').sort(), [...GIT_LOCK_SUBCOMMANDS].sort());
  });

  it('ふるいが node を起動しないと言った呼び出しでは、判定も何もしない(設定ファイルの無い repo・git の鍵のあり/なし)', () => {
    const cwd = bare();
    let skipped = 0;
    for (const env of /** @type {Array<Record<string, string>>} */ ([{}, { SWITCHYARD_GIT: '1' }])) {
      for (const c of corpus()) {
        if (!skips(input(c, cwd), env)) continue;
        skipped += 1;
        assert.equal(preToolUse(input(c, cwd), { env, profilesFor: () => DEFAULT_PROFILES }), null, `${c} ${JSON.stringify(env)}`);
      }
    }
    assert.ok(skipped >= 30, `素通しが少なすぎる: ${skipped}`);
  });

  it('重い形・拒否する形は必ず node の判定へ回す', () => {
    const cwd = bare();
    for (const c of ['npm test', '/usr/local/bin/npm test', './gradlew test', '.venv/bin/pytest', 'switchyard run -- x', 'ls\nnpm test', 'echo a;npm test', 'x=$(cargo build)', './node_modules/.bin/vitest run', 'bash -c "go test ./..."', 'node node_modules/.bin/jest']) {
      assert.equal(skips(input(c, cwd)), false, c);
    }
    // git は SWITCHYARD_GIT=1 のときだけ見る
    for (const c of ['/usr/bin/git commit -m x', 'PATH=/x git add .']) {
      assert.equal(skips(input(c, cwd), { SWITCHYARD_GIT: '1' }), false, c);
      assert.equal(skips(input(c, cwd)), true, c);
    }
  });

  it('普段のコマンドは、cwd や transcript_path に go・node などの語があっても node を起動しない', () => {
    const cwd = join(bare(), 'go', 'node');
    mkdirSync(cwd, { recursive: true });
    for (const c of ['ls -la', 'cat src/a.ts | head -20', 'rg gopher', 'echo nodejs', 'docker build .', 'git status', 'git diff HEAD~1', 'git log --oneline -5', 'node -e "1"', 'node scripts/x.mjs']) {
      assert.equal(skips(input(c, cwd)), true, c);
    }
  });

  it('SWITCHYARD_OFF=1 なら、どれも node を起動しない(判定も何もしない)', () => {
    const cwd = bare();
    for (const c of ['npm test', '/usr/local/bin/npm test']) assert.equal(skips(input(c, cwd), { SWITCHYARD_OFF: '1' }), true, c);
  });

  it('cwd から上に switchyard.json(改名前の conductor.json)があれば、どれも node の判定へ回す', () => {
    for (const name of ['switchyard.json', 'conductor.json']) {
      const repo = bare();
      writeFileSync(join(repo, name), '{"profiles":{}}');
      const cwd = join(repo, 'a', 'b');
      mkdirSync(cwd, { recursive: true });
      assert.equal(skips(input('ls -la', cwd)), false, name);
    }
  });

  it('読めない入力(command・cwd が無い・相対の cwd・説明の中の偽の "command")は node の判定へ回す', () => {
    const cwd = bare();
    assert.equal(skips({ tool_name: 'Bash', cwd, tool_input: {} }), false);
    assert.equal(skips({ tool_name: 'Bash', tool_input: { command: 'ls' } }), false);
    assert.equal(skips(input('ls', 'rel/dir')), false);
    assert.equal(skips('not json'), false);
    // 説明の文字列の中に "command":"ls" があっても、本物の command(npm test)を見る
    assert.equal(skips({ tool_name: 'Bash', cwd, tool_input: { description: '","command":"ls', command: 'npm test' } }), false);
    assert.equal(skips({ tool_name: 'Bash', cwd, tool_input: { description: '{"command":"ls"}', command: 'npm test' } }), false);
  });

  it('入口の sh: 素通しは何も出さず、それ以外は node の判定の出力をそのまま返す。SWITCHYARD_HOOK_SIEVE=0 でふるいを外す', () => {
    const cwd = bare();
    const run = (/** @type {string} */ c, /** @type {Record<string, string>} */ env = {}) =>
      execFileSync(SH_BIN, [SH], { input: JSON.stringify(input(c, cwd)), encoding: 'utf8', env: { PATH: `${BASE_PATH}:${process.env.PATH}`, SWITCHYARD_HOME: bare(), SWITCHYARD_LANG: 'en', ...env } });
    assert.equal(run('ls -la'), '');
    assert.equal(JSON.parse(run('/usr/local/bin/npm test')).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(run('echo hi', { SWITCHYARD_HOOK_SIEVE: '0' }), '');
  });
});
