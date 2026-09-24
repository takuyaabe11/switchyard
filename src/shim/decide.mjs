// @ts-check
// shim の分類器(設計 §9.1)。shim の sh が `node decide.mjs <語> <引数…>` で呼び、答えを 1 行出す。
//   run <profile>  switchyard run --profile <profile> で包む
//   lock <鍵>      鍵だけのジョブとして switchyard run で包む
//   pass           本物をそのまま実行する
// npm や node のたびに呼ばれるので、軽いモジュールだけを import する。
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heldLocks, repoRoot } from '../config/context.mjs';
import { classifiableCommand, classify, loadProfiles } from '../config/profiles.mjs';

/**
 * git の index を書き換えるサブコマンド(設計 §9.1)。shims/_shim.sh の case と同じ集合
 * (test/shim/shims.test.mjs が食い違いを止める)。
 * 2 つのセッションが同時に走らせると、片方が index.lock で失敗するか、相手の stage を巻き込む。
 */
export const GIT_LOCK_SUBCOMMANDS = new Set([
  'commit', 'merge', 'rebase', 'cherry-pick', 'stash', 'am',
  'add', 'rm', 'mv', 'reset', 'restore', 'checkout', 'switch', 'pull', 'revert',
]);

/** 値の語を取る git の大域オプション(`-C dir`・`-c k=v` など。`--git-dir=x` の形は 1 語) */
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/**
 * git の引数を、大域オプション(`-C dir`・`-c k=v`・`--no-pager` など)とサブコマンドに分ける。
 * 最初の引数だけを見ると `git -C repo commit` が鍵を取らずに素通りする(Claude は -C をよく使う)。
 * @param {string[]} args @returns {{ globals: string[], sub: string }}
 */
export function gitSubcommand(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += GIT_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
  return { globals: args.slice(0, Math.min(i, args.length)), sub: args[i] ?? '' };
}

/** この plugin の switchyard の CLI の入口(bin/switchyard は PATH の node で、これを起動する) */
const OWN_CLI = fileURLToPath(new URL('../../bin/switchyard.mjs', import.meta.url));

/**
 * node の最初の引数が、この plugin の switchyard の CLI の入口か(相対パス・symlink でも実パスで比べる)。
 * @param {string | undefined} script @param {string} cwd @returns {boolean}
 */
function isOwnCli(script, cwd) {
  if (script === undefined || basename(script) !== 'switchyard.mjs') return false;
  try {
    return realpathSync(resolve(cwd, script)) === realpathSync(OWN_CLI);
  } catch {
    return false;
  }
}

/** @typedef {{ kind: 'run', profile: string } | { kind: 'lock', lock: string } | { kind: 'pass' }} ShimAnswer */

/**
 * git の作業ツリーの git-dir の実パス。git の外なら null。
 * globals は呼び出しの大域オプション(`-C dir` など)で、同じものを付けて問う(鍵が指す repo を取り違えない)。
 * @param {string} cwd @param {string[]} [globals] @returns {string | null}
 */
export function absoluteGitDir(cwd, globals = []) {
  try {
    return realpathSync(execFileSync('git', [...globals, 'rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
  }
}

/**
 * profilesFor は、cwd の repo の設定の代わりに使う profile の表(switchyard replay の --config。省けば repo の switchyard.json と既定表)。
 * @param {{
 *   word: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
 *   gitDir?: (cwd: string, globals: string[]) => string | null,
 *   profilesFor?: (cwd: string) => import('../config/profiles.mjs').NamedProfile[]
 * }} input
 * @returns {ShimAnswer}
 */
export function decideShim({ word, args, cwd, env, gitDir = absoluteGitDir, profilesFor = (dir) => loadProfiles(repoRoot(dir)).profiles }) {
  // CPU を持つジョブの中なら、そのジョブの一部として走らせる(設計 §4.3 の 7)
  if (env.SWITCHYARD_IN_JOB === '1') return { kind: 'pass' };
  // switchyard の CLI 自身は包まない(bin/switchyard が PATH の node、つまり node の shim を通る)。包むと、外側のジョブが CPU と計測の quiet を
  // 取ってから内側の switchyard run が鍵を 2 段目に要求し、資源を一括で取る(設計 §5.3)が崩れる。性格は内側の switchyard run が決める
  if (word === 'node' && isOwnCli(args[0], cwd)) return { kind: 'pass' };
  if (word === 'git') {
    // git の index の鍵は SWITCHYARD_GIT=1 のときだけ取る(既定は素通し)。worktree ごとに index は別なので、
    // worktree で分けて作業する人には要らない。全コマンドの前に割り込まれるのを嫌う声も多かった
    if (env.SWITCHYARD_GIT !== '1') return { kind: 'pass' };
    const { globals, sub } = gitSubcommand(args);
    if (!GIT_LOCK_SUBCOMMANDS.has(sub)) return { kind: 'pass' };
    const dir = gitDir(cwd, globals);
    if (dir === null) return { kind: 'pass' };
    const lock = `git-index:${dir}`;
    // 祖先が同じ鍵を持っていれば待たない(git commit の中の git stash)
    return heldLocks(env).has(lock) ? { kind: 'pass' } : { kind: 'lock', lock };
  }
  const named = classify(classifiableCommand([word, ...args]), profilesFor(cwd));
  return named === null ? { kind: 'pass' } : { kind: 'run', profile: named.name };
}

/** @param {ShimAnswer} a @returns {string} */
export function formatAnswer(a) {
  if (a.kind === 'run') return `run ${a.profile}`;
  if (a.kind === 'lock') return `lock ${a.lock}`;
  return 'pass';
}

// 直接実行されたときだけ CLI として動く。import されたときは何もしない(argv[1] が実在しない起動でも投げない)
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  const [word, ...args] = process.argv.slice(2);
  if (word === undefined) {
    process.stderr.write('使い方: node decide.mjs <語> <引数...>\n');
    process.exitCode = 2;
  } else {
    process.stdout.write(`${formatAnswer(decideShim({ word, args, cwd: process.cwd(), env: process.env }))}\n`);
  }
}
