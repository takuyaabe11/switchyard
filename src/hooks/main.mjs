// @ts-check
// hook の入口(設計 §9.2): 標準入力の JSON を読み、イベントごとの判定を呼び、結果を標準出力へ書く。
// 判断の記録(§4.2 の hooks.jsonl)もここで行う — 判定そのもの(preToolUse)は書かない純粋な関数に保つ。
// switchyard replay の空回しや、テストでの試算が、実際の記録を汚さないようにするため。
import { switchyardHome, pathsOf } from '../daemon/paths.mjs';
import { appendRecord } from '../daemon/store.mjs';
import { preToolUse } from './pretooluse.mjs';
import { sessionStart, stop } from './session.mjs';

/** @typedef {import('../config/profiles.mjs').NamedProfile} NamedProfile */

/**
 * PreToolUse の判断を hooks.jsonl へ 1 行残す。何もしなかった分(out が null)は書かない。
 * 書けなくても hook の判断はそのまま返す(記録は補助で、失敗で作業を止めない)。
 * @param {Record<string, unknown>} input @param {Record<string, unknown> | null} out @param {NodeJS.ProcessEnv} env
 */
function recordPreToolUse(input, out, env) {
  if (out === null) return;
  const h = /** @type {Record<string, unknown>} */ (typeof out.hookSpecificOutput === 'object' && out.hookSpecificOutput !== null ? out.hookSpecificOutput : {});
  const decision = h.permissionDecision === 'deny' ? 'deny' : 'background';
  const ti = /** @type {Record<string, unknown>} */ (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {});
  try {
    appendRecord(pathsOf(switchyardHome(env)).hooks, {
      at: Date.now(),
      kind: 'hook',
      decision,
      session: typeof input.session_id === 'string' ? input.session_id : '',
      cwd: typeof input.cwd === 'string' ? input.cwd : '',
      cmd: typeof ti.command === 'string' ? ti.command : '',
    });
  } catch {
    /* 記録できないときは黙って進む */
  }
}

/**
 * @param {string} event pre-tool-use / session-start / stop
 * @param {string} raw 標準入力
 * @param {{ write?: (s: string) => void, env?: NodeJS.ProcessEnv, profilesFor?: (cwd: string) => NamedProfile[] }} [opts]
 * @returns {Promise<void>}
 */
export async function runHook(event, raw, { write = (s) => process.stdout.write(s), env = process.env, profilesFor } = {}) {
  const input = raw.trim() === '' ? {} : JSON.parse(raw);
  switch (event) {
    case 'pre-tool-use': {
      const out = preToolUse(input, { env, ...(profilesFor === undefined ? {} : { profilesFor }) });
      recordPreToolUse(input, out, env);
      if (out !== null) write(JSON.stringify(out));
      return;
    }
    case 'session-start': {
      const lines = await sessionStart(input);
      if (lines.length > 0) write(`${lines.join('\n')}\n`);
      return;
    }
    case 'stop': {
      const out = await stop(input);
      if (out !== null) write(JSON.stringify(out));
      return;
    }
    default:
      throw new Error(`知らない hook: ${event}`);
  }
}
