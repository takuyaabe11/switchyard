// @ts-check
// 実行の文脈: どの repo で走るか、祖先のジョブが何を持っているか。
// shim の分類器(npm や node のたびに呼ばれる)からも読むので、重いモジュールを import せず、外部プロセスも起動しない。
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * git の作業ツリーの根。git の外なら cwd。
 * `git rev-parse --show-toplevel` を起動せず、`.git`(ディレクトリでも、worktree / submodule のファイルでも)を上へ探す。
 * 分類器と PreToolUse が 1 コマンドごとに呼ぶ経路なので、ここで外部プロセスを 1 本起動すると
 * 素通しのコマンドにもその時間がまるごと乗る(実測: この機械で git rev-parse は 29ms、分類器全体の約 46%)。
 * git との違いは、git が中身を認めない `.git`(空のディレクトリなど)と、`.git` の中から呼んだときだけ。
 * どちらも switchyard.json を探す用途と、見込みの帳簿の鍵としては、上方探索の答えの方が素直。
 * @param {string} cwd @returns {string}
 */
export function repoRoot(cwd) {
  /** @type {string} */
  let start;
  try {
    start = realpathSync(cwd);
  } catch {
    return cwd;
  }
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    // 見つからなければ cwd をそのまま返す(git を呼んでいた頃と同じ。実パスへ直さないので、記録の鍵も変わらない)
    if (up === dir) return cwd;
    dir = up;
  }
}

/** 祖先のジョブが持つ鍵(SWITCHYARD_HELD_LOCKS のカンマ区切り。設計 §4.3 の 7) @param {NodeJS.ProcessEnv} env @returns {Set<string>} */
export function heldLocks(env) {
  return new Set((env.SWITCHYARD_HELD_LOCKS ?? '').split(',').filter((k) => k !== ''));
}
