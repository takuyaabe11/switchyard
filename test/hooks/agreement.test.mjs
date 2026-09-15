// @ts-check
// 三者の判定の表(最後の全体レビューの Recommendation 1)。
// 同じコマンド列について、次の 3 つを 1 行に並べて固定する。
//   1. shim の分類器(src/shim/decide.mjs)が、bash が起こす shim の呼び出しに何と答えるか
//   2. conductor run で包んだ部分を、包みがどの性格で要求するか(buildRequest)
//   3. PreToolUse が背景に回すか・拒否するか・何もしないか
// 行ごとに「shim か包みが CPU を持つ重い走行を起こすのに、PreToolUse が前景のまま通す」形が無いことも、答えそのものから確かめる。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../../src/cli/args.mjs';
import { loadProfiles } from '../../src/config/profiles.mjs';
import { preToolUse } from '../../src/hooks/pretooluse.mjs';
import { buildRequest } from '../../src/run/run.mjs';
import { decideShim, formatAnswer } from '../../src/shim/decide.mjs';

/** この repo の conductor の CLI の入口(bin/conductor は PATH の node でこれを起動する) */
const CLI = realpathSync(fileURLToPath(new URL('../../bin/conductor.mjs', import.meta.url)));

/** git init 済みで、プロジェクトの profile を持つ作業場所 */
function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cagree-')));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(
    join(dir, 'conductor.json'),
    JSON.stringify({ profiles: { vitest: { match: ['*vitest run*'], class: 'batch' }, lint: { match: ['npx eslint*', 'eslint*'], class: 'quick' } } }),
  );
  return dir;
}

/** 答えの中の git の鍵(作業場所ごとに決まる)の置き場 */
const LOCK = 'lock <git-index>';

// 本文の行が shim の語で始まっても、heredoc の本文はコマンドではない
const MESSAGE = 'fix: flaky test; retry measure step\n\nnpm test is green again\n\nCo-Authored-By: Claude <noreply@example.com>';
/** Claude が標準で使う heredoc の commit */
const HEREDOC_COMMIT = `git commit -m "$(cat <<'EOF'\n${MESSAGE}\nEOF\n)"`;

/**
 * shims: bash が(shims を PATH の先頭に置き、ジョブの外で)このコマンドを走らせたときに起きる shim の呼び出しと、分類器の答え。
 *   パスや PATH で呼んだ node のスクリプト(`#!/usr/bin/env node`)は、env が PATH の node を引くので node の shim を通る。
 * run: conductor run の部分の `run` より後ろの引数と、包みが要求する性格。
 * hook: PreToolUse の答え。
 * @typedef {{ command: string, shims: Array<[string[], string]>, run?: [string[], string], hook: 'background' | 'deny' | null }} Row
 */

/** @type {Row[]} */
const ROWS = [
  // 読むだけのコマンド: shim を通らず、重い走行を起こさない。拒否も背景も無い(C1)
  { command: 'cat benchmarks/standards.json', shims: [], hook: null },
  { command: 'ls bench', shims: [], hook: null },
  { command: 'grep -rn measure src', shims: [], hook: null },
  { command: 'echo measure', shims: [], hook: null },
  { command: 'grep -rn "vitest run" src', shims: [], hook: null },
  { command: 'cd benchmarks && npm install', shims: [[['npm', 'install'], 'pass']], hook: null },
  // git: profile で分類しない。index を書き換えるサブコマンドだけが鍵だけのジョブになる(C1)
  { command: 'git commit -m "fix bench flake"', shims: [[['git', 'commit', '-m', 'fix bench flake'], LOCK]], hook: null },
  { command: 'git diff -- benchmarks/', shims: [[['git', 'diff', '--', 'benchmarks/'], 'pass']], hook: null },
  { command: 'git log -- benchmarks', shims: [[['git', 'log', '--', 'benchmarks'], 'pass']], hook: null },
  { command: HEREDOC_COMMIT, shims: [[['git', 'commit', '-m', MESSAGE], LOCK]], hook: null },
  { command: '/usr/bin/git diff -- benchmarks/', shims: [], hook: null },
  { command: '/usr/bin/git commit -m x', shims: [], hook: 'deny' },
  // shim が CPU を持つ走行を包む形は、どこに書いても背景に回す(I1)
  { command: 'npm test', shims: [[['npm', 'test'], 'run default:batch']], hook: 'background' },
  { command: 'cd benchmarks && npm test', shims: [[['npm', 'test'], 'run default:batch']], hook: 'background' },
  { command: 'bash -c "npm test"', shims: [[['npm', 'test'], 'run default:batch']], hook: 'background' },
  { command: "sh -c 'cd sub && npx vitest run'", shims: [[['npx', 'vitest', 'run'], 'run vitest']], hook: 'background' },
  { command: '(npm test)', shims: [[['npm', 'test'], 'run default:batch']], hook: 'background' },
  { command: 'echo "$(npm test)"', shims: [[['npm', 'test'], 'run default:batch']], hook: 'background' },
  { command: 'env -u FOO npm test', shims: [[['npm', 'test'], 'run default:batch']], hook: 'background' },
  { command: 'time npm test', shims: [[['npm', 'test'], 'run default:batch']], hook: 'background' },
  { command: 'command npm test', shims: [[['npm', 'test'], 'run default:batch']], hook: 'background' },
  { command: 'timeout 600 node benchmarks/run.mjs', shims: [[['node', 'benchmarks/run.mjs'], 'run default:measure']], hook: 'background' },
  { command: 'cd sub\nnpm test', shims: [[['npm', 'test'], 'run default:batch']], hook: 'background' },
  { command: 'if npm test; then echo ok; fi', shims: [[['npm', 'test'], 'run default:batch']], hook: 'background' },
  // quick と管理外は前景のまま
  { command: 'npx eslint src', shims: [[['npx', 'eslint', 'src'], 'run lint']], hook: null },
  { command: 'npm install', shims: [[['npm', 'install'], 'pass']], hook: null },
  // conductor run での出し直し: 拒否しない。包みが CPU を持つ性格なら背景に回す(I1)。conductor の CLI 自身は node の shim に包まれない(I2)
  {
    command: 'conductor run -- npx vitest run',
    shims: [[['node', CLI, 'run', '--', 'npx', 'vitest', 'run'], 'pass']],
    run: [['--', 'npx', 'vitest', 'run'], 'batch'],
    hook: 'background',
  },
  {
    command: 'conductor run --lock port:4173 -- node scripts/e2e.mjs',
    shims: [[['node', CLI, 'run', '--lock', 'port:4173', '--', 'node', 'scripts/e2e.mjs'], 'pass']],
    run: [['--lock', 'port:4173', '--', 'node', 'scripts/e2e.mjs'], 'batch'],
    hook: 'background',
  },
  {
    command: 'conductor run -- ./node_modules/.bin/vitest run',
    shims: [[['node', CLI, 'run', '--', './node_modules/.bin/vitest', 'run'], 'pass']],
    run: [['--', './node_modules/.bin/vitest', 'run'], 'batch'],
    hook: 'background',
  },
  {
    command: 'conductor run --class quick -- ./node_modules/.bin/eslint src',
    shims: [[['node', CLI, 'run', '--class', 'quick', '--', './node_modules/.bin/eslint', 'src'], 'pass']],
    run: [['--class', 'quick', '--', './node_modules/.bin/eslint', 'src'], 'quick'],
    hook: null,
  },
  {
    command: `node ${CLI} run --lock port:4173 -- npm run bench`,
    shims: [[['node', CLI, 'run', '--lock', 'port:4173', '--', 'npm', 'run', 'bench'], 'pass']],
    run: [['--lock', 'port:4173', '--', 'npm', 'run', 'bench'], 'measure'],
    hook: 'background',
  },
  // shim を迂回して管理対象を起動する形は拒否する(パスで直に呼ぶ・当たった glob がその語で始まる)
  { command: './node_modules/.bin/vitest run', shims: [[['node', './node_modules/.bin/vitest', 'run'], 'run vitest']], hook: 'deny' },
  { command: './node_modules/.bin/eslint src', shims: [[['node', './node_modules/.bin/eslint', 'src'], 'pass']], hook: 'deny' },
  { command: 'eslint src', shims: [[['node', '/r/node_modules/.bin/eslint', 'src'], 'pass']], hook: 'deny' },
  { command: 'scripts/probe-run.sh benchmark', shims: [], hook: 'deny' },
  { command: '/usr/local/bin/npm test', shims: [[['node', '/usr/local/lib/node_modules/npm/bin/npm-cli.js', 'test'], 'pass']], hook: 'deny' },
  {
    command: 'npm test && ./node_modules/.bin/vitest run',
    shims: [
      [['npm', 'test'], 'run default:batch'],
      [['node', './node_modules/.bin/vitest', 'run'], 'run vitest'],
    ],
    hook: 'deny',
  },
];

/** @param {Record<string, unknown> | null} out @returns {'background' | 'deny' | null} */
function outcome(out) {
  if (out === null) return null;
  const h = /** @type {Record<string, unknown>} */ (out.hookSpecificOutput);
  assert.notEqual(h.permissionDecision, 'allow', 'PreToolUse は allow を返さない');
  if (h.permissionDecision === 'deny') return 'deny';
  assert.equal(h.permissionDecision, undefined);
  assert.equal(/** @type {Record<string, unknown>} */ (h.updatedInput).run_in_background, true);
  return 'background';
}

describe('三者の判定の表(shim の分類器・conductor run の包み・PreToolUse)', () => {
  const dir = project();
  const lock = `lock git-index:${realpathSync(join(dir, '.git'))}`;
  const { profiles } = loadProfiles(dir);
  /** @param {string} name */
  const classOf = (name) => profiles.find((p) => p.name === name)?.profile.class;

  for (const row of ROWS) {
    // テスト名は置き場所に依らないようにする(変異の走行は一時ディレクトリの写しで走る)
    it(JSON.stringify(row.command.split(CLI).join('<bin/conductor.mjs>')), () => {
      const answers = row.shims.map(([argv]) => formatAnswer(decideShim({ word: argv[0], args: argv.slice(1), cwd: dir, env: {} })));
      assert.deepEqual(answers, row.shims.map(([, a]) => (a === LOCK ? lock : a)), '分類器の答え');

      /** @type {string | null} */
      let wrapper = null;
      if (row.run !== undefined) {
        const parsed = parseArgs(['run', ...row.run[0]]);
        if (parsed.cmd !== 'run') throw new Error('run として読めない');
        wrapper = buildRequest({ argv: parsed.argv, flags: parsed.flags, env: {}, cwd: dir }).job.class;
        assert.equal(wrapper, row.run[1], '包みの性格');
      }

      const hook = outcome(preToolUse({ session_id: 's', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: row.command } }, { env: {} }));
      assert.equal(hook, row.hook, 'PreToolUse の答え');

      // 食い違いの検査: CPU を持つ重い走行が起きるなら、前景のまま通さない
      const heavyShim = answers.some((a) => a.startsWith('run ') && classOf(a.slice(4)) !== 'quick');
      const heavyWrapper = wrapper !== null && wrapper !== 'quick';
      if (heavyShim || heavyWrapper) assert.notEqual(hook, null, '重い走行が起きるのに PreToolUse が前景のまま通す');
    });
  }
});
