// @ts-check
// shim の分類器(設計 §9.1)。shim の sh が `node decide.mjs <語> <引数…>` で呼び、答えを 1 行出す。
//   run <profile>  conductor run --profile <profile> で包む
//   lock <鍵>      鍵だけのジョブとして conductor run で包む
//   pass           本物をそのまま実行する
// npm や node のたびに呼ばれるので、軽いモジュールだけを import する。
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { heldLocks, repoRoot } from '../config/context.mjs';
import { classifiableCommand, classify, loadProfiles } from '../config/profiles.mjs';

/** git の index を書き換えるサブコマンド(設計 §9.1) */
export const GIT_LOCK_SUBCOMMANDS = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'stash', 'am']);

/** この plugin の conductor の CLI の入口(bin/conductor は PATH の node で、これを起動する) */
const OWN_CLI = fileURLToPath(new URL('../../bin/conductor.mjs', import.meta.url));

/**
 * node の最初の引数が、この plugin の conductor の CLI の入口か(相対パス・symlink でも実パスで比べる)。
 * @param {string | undefined} script @param {string} cwd @returns {boolean}
 */
function isOwnCli(script, cwd) {
  if (script === undefined || basename(script) !== 'conductor.mjs') return false;
  try {
    return realpathSync(resolve(cwd, script)) === realpathSync(OWN_CLI);
  } catch {
    return false;
  }
}

/** @typedef {{ kind: 'run', profile: string } | { kind: 'lock', lock: string } | { kind: 'pass' }} ShimAnswer */

/** git の作業ツリーの git-dir の実パス。git の外なら null @param {string} cwd @returns {string | null} */
export function absoluteGitDir(cwd) {
  try {
    return realpathSync(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
  }
}

/**
 * profilesFor は、cwd の repo の設定の代わりに使う profile の表(conductor replay の --config。省けば repo の conductor.json と既定表)。
 * @param {{
 *   word: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
 *   gitDir?: (cwd: string) => string | null,
 *   profilesFor?: (cwd: string) => import('../config/profiles.mjs').NamedProfile[]
 * }} input
 * @returns {ShimAnswer}
 */
export function decideShim({ word, args, cwd, env, gitDir = absoluteGitDir, profilesFor = (dir) => loadProfiles(repoRoot(dir)).profiles }) {
  // CPU を持つジョブの中なら、そのジョブの一部として走らせる(設計 §4.3 の 7)
  if (env.CONDUCTOR_IN_JOB === '1') return { kind: 'pass' };
  // conductor の CLI 自身は包まない(bin/conductor が PATH の node、つまり node の shim を通る)。包むと、外側のジョブが CPU と計測の quiet を
  // 取ってから内側の conductor run が鍵を 2 段目に要求し、資源を一括で取る(設計 §5.3)が崩れる。性格は内側の conductor run が決める
  if (word === 'node' && isOwnCli(args[0], cwd)) return { kind: 'pass' };
  if (word === 'git') {
    if (!GIT_LOCK_SUBCOMMANDS.has(args[0] ?? '')) return { kind: 'pass' };
    const dir = gitDir(cwd);
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
