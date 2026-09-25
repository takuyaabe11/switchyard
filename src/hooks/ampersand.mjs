// @ts-check
// `npm test > log 2>&1 &` のように、重い走行をコマンドの最後の `&` で裏に回す呼び出しを、`&` を外して Claude Code の背景実行
// (run_in_background)に書き換える。`&` で裏に回すと Bash の呼び出しはすぐ返り、走行が終わっても Claude に知らせが届かない。
// そのため Claude は、ログを sleep しながら見に行くループで終わりを待ちがちになる(利用者の記録で、時間切れの最多は前景で待つループ)。
// 背景実行なら、終われば Claude Code が Claude に知らせる。リダイレクト(> log)はそのまま残すので、出力の行き先は変わらない。
// 書き換えるのは、いちばん外側の `&` が 1 つだけで、それがコマンドの最後にあるときだけ(`& wait`・`$!` を後で使う形・途中の `&` は触らない)。
// SWITCHYARD_AMP_BACKGROUND=0 で止める。
import { trailingAmpersand } from './shell.mjs';

/**
 * 最後の `&` を外したコマンド。書き換えられない形なら null。
 * @param {string} command @returns {string | null}
 */
export function withoutTrailingAmpersand(command) {
  const at = trailingAmpersand(command);
  if (at < 0) return null;
  const stripped = command.slice(0, at).trimEnd();
  return stripped === '' ? null : stripped;
}

/**
 * 重い走行を `&` で裏に回す呼び出しを、背景実行へ書き換える。何もしなくてよければ out をそのまま返す。
 * 拒否・承認を求める呼び出しは触らない。他の書き換え(switchyard run で包む・背景へ回す・時間切れを延ばす)の上に重ねる。
 * @param {Record<string, unknown>} ti 元の tool_input @param {Record<string, unknown> | null} out ここまでの書き換え
 * @param {NodeJS.ProcessEnv} env @param {boolean} heavy 重い走行を含むか(PreToolUse の判定)
 * @returns {{ out: Record<string, unknown> | null, applied: boolean }}
 */
export function foregroundAmpersand(ti, out, env, heavy) {
  const none = { out, applied: false };
  if (!heavy || env.SWITCHYARD_AMP_BACKGROUND === '0') return none;
  const h = out !== null && typeof out.hookSpecificOutput === 'object' && out.hookSpecificOutput !== null ? /** @type {Record<string, unknown>} */ (out.hookSpecificOutput) : null;
  if (h !== null && (h.permissionDecision === 'deny' || h.permissionDecision === 'ask')) return none;
  const input = /** @type {Record<string, unknown>} */ (h !== null && typeof h.updatedInput === 'object' && h.updatedInput !== null ? h.updatedInput : ti);
  const command = typeof input.command === 'string' ? input.command : '';
  const stripped = withoutTrailingAmpersand(command);
  if (stripped === null) return none;
  // 時間切れは背景では効かないので外す
  const { timeout: _t, ...rest } = input;
  return { out: { hookSpecificOutput: { ...(h ?? {}), hookEventName: 'PreToolUse', updatedInput: { ...rest, command: stripped, run_in_background: true } } }, applied: true };
}
