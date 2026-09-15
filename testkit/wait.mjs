// @ts-check

/**
 * 条件が真になるまで待つ。時間内に真にならなければ投げる。
 * @param {() => boolean} fn @param {number} [timeoutMs] @param {number} [stepMs]
 */
export async function waitFor(fn, timeoutMs = 2_000, stepMs = 10) {
  const until = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > until) throw new Error(`${timeoutMs}ms 待っても条件が成り立たない`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
