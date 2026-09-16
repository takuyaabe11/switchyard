// @ts-check
// 実行の文脈: どの repo で走るか、祖先のジョブが何を持っているか。
// shim の分類器(npm や node のたびに呼ばれる)からも読むので、重いモジュールを import しない。
import { execFileSync } from 'node:child_process';

/** git の作業ツリーの根。git の外なら cwd @param {string} cwd @returns {string} */
export function repoRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return cwd;
  }
}

/** 祖先のジョブが持つ鍵(SWITCHYARD_HELD_LOCKS のカンマ区切り。設計 §4.3 の 7) @param {NodeJS.ProcessEnv} env @returns {Set<string>} */
export function heldLocks(env) {
  return new Set((env.SWITCHYARD_HELD_LOCKS ?? '').split(',').filter((k) => k !== ''));
}
