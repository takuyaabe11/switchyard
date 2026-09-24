// @ts-check
// 割り当てたコア数を、よく使う道具の並列度として渡す。
// switchyard が CPU を 4 割り当てても、cargo や go test は既定で機械の全コアを使う。割り当てを実際に守らせるには、
// 道具が読む並列度の環境変数を渡すしかない。渡すのは、配布物の中身で読むことを確かめた変数だけ:
//   Rust(cargo のビルド・テストの実行・rayon)、Go、OpenMP(numpy などの数値計算)、pytest-xdist の -n auto、
//   Vitest(1〜3 は THREADS / FORKS、4 以降は WORKERS)
// Jest・Playwright・Gradle・Maven・make には確かな環境変数が無いので渡さない(make の MAKEFLAGS は並列を想定しない
// Makefile を壊しうる)。利用者が自分で決めた値(親の環境にある値・profile の env)は上書きしない。

/** 並列度として割り当てたコア数を入れる環境変数 */
export const THREAD_ENV_VARS = [
  'CARGO_BUILD_JOBS',
  'RUST_TEST_THREADS',
  'RAYON_NUM_THREADS',
  'GOMAXPROCS',
  'OMP_NUM_THREADS',
  'PYTEST_XDIST_AUTO_NUM_WORKERS',
  'VITEST_MAX_THREADS',
  'VITEST_MAX_FORKS',
  'VITEST_MAX_WORKERS',
];

/**
 * 子に足す並列度の環境変数。親の環境に既にある変数は足さない。threads が 1 未満なら何も足さない。
 * @param {number} threads @param {NodeJS.ProcessEnv} parent @returns {Record<string, string>}
 */
export function threadEnv(threads, parent) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!(threads >= 1)) return out;
  for (const name of THREAD_ENV_VARS) if (parent[name] === undefined) out[name] = String(Math.floor(threads));
  return out;
}
