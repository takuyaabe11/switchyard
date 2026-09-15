// @ts-check
// hook の入口(設計 §9.2): 標準入力の JSON を読み、イベントごとの判定を呼び、結果を標準出力へ書く。
import { preToolUse } from './pretooluse.mjs';
import { sessionStart, stop } from './session.mjs';

/**
 * @param {string} event pre-tool-use / session-start / stop
 * @param {string} raw 標準入力
 * @param {{ write?: (s: string) => void }} [opts]
 * @returns {Promise<void>}
 */
export async function runHook(event, raw, { write = (s) => process.stdout.write(s) } = {}) {
  const input = raw.trim() === '' ? {} : JSON.parse(raw);
  switch (event) {
    case 'pre-tool-use': {
      const out = preToolUse(input);
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
