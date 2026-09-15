// @ts-check
// PreToolUse(Bash)の判定(設計 §9.2)。hook の標準入力の JSON を受け、出力の JSON を返す(何もしないなら null)。
import { basename } from 'node:path';
import { repoRoot } from '../config/context.mjs';
import { classify, loadProfiles, segments } from '../config/profiles.mjs';
import { GIT_LOCK_SUBCOMMANDS } from '../shim/decide.mjs';

/** @typedef {import('../config/profiles.mjs').NamedProfile} NamedProfile */

/** shim を置く語(設計 §9.1)。shims/ の実物と同じ 8 語 */
export const SHIM_WORDS = ['npm', 'npx', 'node', 'cargo', 'pytest', 'go', 'make', 'git'];

/**
 * 部分(§4.5 の区切りの 1 つ)の先頭の語と、それより後ろの語。
 * VAR=値 と、env / timeout N / nice [-n N] / time / nohup / command を読み飛ばす。
 * @param {string} segment @returns {{ head: string, rest: string[] }}
 */
export function headWord(segment) {
  const words = segment.split(' ').filter((w) => w !== '');
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1;
    } else if (w === 'timeout') {
      // timeout [オプション] 時間 コマンド
      i += 1;
      while (i < words.length && words[i].startsWith('-')) i += words[i] === '-s' || words[i] === '-k' ? 2 : 1;
      i += 1;
    } else if (w === 'nice') {
      i += 1;
      if (words[i] === '-n') i += 2;
      else if (/^-[0-9]+$/.test(words[i] ?? '')) i += 1;
    } else if (w === 'env' || w === 'time' || w === 'nohup' || w === 'command') {
      i += 1;
      while (i < words.length && words[i].startsWith('-')) i += 1;
    } else {
      break;
    }
  }
  return { head: words[i] ?? '', rest: words.slice(i + 1) };
}

/**
 * @param {Record<string, unknown>} input hook の標準入力
 * @param {{ env?: NodeJS.ProcessEnv, profilesFor?: (cwd: string) => NamedProfile[] }} [opts]
 * @returns {Record<string, unknown> | null}
 */
export function preToolUse(input, { env = process.env, profilesFor = (cwd) => loadProfiles(repoRoot(cwd)).profiles } = {}) {
  if (env.CONDUCTOR_THINKER === '1') return null;
  if (input.tool_name !== 'Bash') return null;
  const ti = /** @type {Record<string, unknown>} */ (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {});
  const command = typeof ti.command === 'string' ? ti.command : '';
  const parts = segments(command).map((seg) => ({ seg, ...headWord(seg) }));
  // 明示的に conductor run で包んだコマンドは、書いた人の意図どおりに通す
  if (parts.some((p) => (basename(p.head) === 'conductor' || basename(p.head) === 'conductor.mjs') && p.rest[0] === 'run')) return null;

  const profiles = profilesFor(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  let heavy = false;
  /** @type {string[]} */
  const unshimmed = [];
  for (const { seg, head, rest } of parts) {
    const gitLock = basename(head) === 'git' && GIT_LOCK_SUBCOMMANDS.has(rest[0] ?? '');
    const hit = classify([head, ...rest].join(' '), profiles) ?? classify(seg, profiles);
    if (hit === null && !gitLock) continue;
    if (!SHIM_WORDS.includes(head)) unshimmed.push(seg);
    if (hit !== null && hit.profile.class !== 'quick') heavy = true;
  }

  if (unshimmed.length > 0) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `[conductor] 重いコマンドとして管理される部分が、shim(${SHIM_WORDS.join(' / ')})を通らない形になっている: ${unshimmed.join(' / ')}。` +
          'PATH から呼べる形(例: npx vitest run)に書き直すか、`conductor run -- <その部分>` で包んでから実行する(包んだコマンドには普段どおり権限の確認が出る)。',
      },
    };
  }
  if (heavy && ti.run_in_background !== true) {
    // 決定(permissionDecision)は付けない。allow は権限の確認を飛ばすので使わない(設計 §12)
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, run_in_background: true } } };
  }
  return null;
}
