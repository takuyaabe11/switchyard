// @ts-check
// Bash ツールの時間切れ(既定 2 分)で、長い走行が途中で切られないようにする。1 本のセッションでも起きる。
// - 時間切れで切られたコマンドを覚えておき(PostToolUseFailure)、次に同じ場所で同じコマンドが走るとき、時間切れを延ばす(倍・上限まで)
// - 自分で終わった走行の所要を学んでいれば(デーモンの帳簿)、それより短い時間切れを延ばす。上限でも足りなければ背景へ回す
// 終わったことの無いコマンド(watch モード・サーバー)は背景へ回さない。回すと、誰も止めないまま走り続ける。
// SWITCHYARD_TIMEOUT_GUARD=0 で止める。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { pathsOf, switchyardHome, PRIVATE_FILE_MODE, ensurePrivateDir } from '../daemon/paths.mjs';

/** Claude Code の既定の時間切れ(BASH_DEFAULT_TIMEOUT_MS が無いとき) */
export const DEFAULT_TIMEOUT_MS = 120_000;
/** Claude Code の時間切れの上限(BASH_MAX_TIMEOUT_MS が無いとき) */
export const MAX_TIMEOUT_MS = 600_000;
/** 学んだ所要に足す余裕(最長の 1.5 倍) */
export const LEARNED_MARGIN = 1.5;
/** 覚えておく時間切れの数と日数 */
export const REMEMBER_LIMIT = 50;
export const REMEMBER_DAYS = 30;

/** @param {string | undefined} v @returns {number | null} */
const positive = (v) => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * この呼び出しの時間切れと上限(ms)。Claude Code と同じく、上限は既定との大きい方。
 * @param {Record<string, unknown>} ti @param {NodeJS.ProcessEnv} env @returns {{ limit: number, max: number }}
 */
export function limitsOf(ti, env) {
  const def = positive(env.BASH_DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
  const max = Math.max(positive(env.BASH_MAX_TIMEOUT_MS) ?? MAX_TIMEOUT_MS, def);
  const asked = typeof ti.timeout === 'number' && ti.timeout > 0 ? ti.timeout : null;
  return { limit: Math.min(asked ?? def, max), max };
}

/**
 * 時間切れの文面(`Command timed out after 2m 0s`・`after 3s`・`after 1h 2m`)から、切られた時間(ms)を読む。読めなければ null。
 * @param {string} text @returns {number | null}
 */
export function timedOutAfter(text) {
  const m = /Command timed out after ((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/.exec(text);
  if (m === null) return null;
  let ms = 0;
  for (const p of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/g)) {
    const n = Number(p[1]);
    ms += p[2] === 'ms' ? n : p[2] === 's' ? n * 1000 : p[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return ms > 0 ? Math.round(ms) : null;
}

/** 覚える鍵のためのコマンドの形(空白の並びを 1 つに) @param {string} command */
export const normalized = (command) => command.replace(/\s+/g, ' ').trim();

/**
 * @typedef {{ root: string, command: string, exact?: string, limitMs: number, at: number }} TimedOut
 * command は空白をならした形(比べる鍵)、exact は元の形(PreToolUse の sh のふるいが、hook の入力の JSON の文字列と比べる)
 */

/** @param {NodeJS.ProcessEnv} env @returns {TimedOut[]} */
export function readTimedOut(env) {
  const file = pathsOf(switchyardHome(env)).timeouts;
  if (!existsSync(file)) return [];
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(v)) return [];
    return v.filter((e) => e !== null && typeof e === 'object' && typeof e.root === 'string' && typeof e.command === 'string' && typeof e.limitMs === 'number' && typeof e.at === 'number');
  } catch {
    return [];
  }
}

/**
 * 時間切れを覚える。同じ場所・同じコマンドは新しい方で上書きし、古いもの・多すぎる分は捨てる。
 * PreToolUse の sh のふるいが読む一覧(1 行に 1 つ、JSON の文字列の中身の形のコマンド)も書き直す。
 * @param {NodeJS.ProcessEnv} env @param {TimedOut} entry @param {number} [now]
 */
export function rememberTimedOut(env, entry, now = Date.now()) {
  const home = switchyardHome(env);
  const p = pathsOf(home);
  ensurePrivateDir(home);
  const kept = readTimedOut(env).filter((e) => !(e.root === entry.root && e.command === entry.command) && now - e.at < REMEMBER_DAYS * 86_400_000);
  const list = [...kept, entry].slice(-REMEMBER_LIMIT);
  const write = (/** @type {string} */ file, /** @type {string} */ text) => {
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, text, { mode: PRIVATE_FILE_MODE });
    renameSync(tmp, file);
  };
  write(p.timeouts, JSON.stringify(list));
  // ふるい(awk)は hook の入力の JSON の中の command の文字列を、エスケープのまま比べる
  write(p.timeoutsSieve, list.map((e) => `${JSON.stringify(e.exact ?? e.command).slice(1, -1)}\n`).join(''));
}

/**
 * この呼び出しに要る時間(ms)。分からなければ null。
 * - 前に同じ場所・同じコマンドが時間切れになっていれば、その時の時間切れの倍(それでは終わらなかった)
 * - デーモンが学んだ、自分で終わった走行の最長の所要があれば、その 1.5 倍
 * @param {{ remembered: TimedOut | null, longestMs: number | null }} r
 * @returns {{ needMs: number, finishes: boolean } | null} finishes: 自分で終わることを知っている(学んだ所要から出した)
 */
export function neededTime({ remembered, longestMs }) {
  const fromTimeout = remembered === null ? null : remembered.limitMs * 2;
  const fromLearned = longestMs === null ? null : Math.round(longestMs * LEARNED_MARGIN);
  if (fromTimeout === null && fromLearned === null) return null;
  return { needMs: Math.max(fromTimeout ?? 0, fromLearned ?? 0), finishes: fromLearned !== null };
}

/**
 * 時間切れを延ばす / 背景へ回す書き換え。何もしなくてよければ out をそのまま返す。
 * - 要る時間が今の時間切れ以内: 何もしない
 * - 上限以内: timeout を要る時間(秒に切り上げ)にする
 * - 上限を超え、自分で終わることを知っている: 背景へ回す(時間切れが無い)
 * - 上限を超え、終わったことが無い: 上限まで延ばすだけ(終わらない走行を背景に置き去りにしない)
 * @param {Record<string, unknown>} ti 元の tool_input
 * @param {Record<string, unknown> | null} out preToolUse の判定(書き換えがあればその上に重ねる)
 * @param {{ needMs: number, finishes: boolean }} need
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ out: Record<string, unknown> | null, action: 'extend' | 'background' | null, timeoutMs: number | null }}
 */
export function guardTimeout(ti, out, need, env) {
  const h = out !== null && typeof out.hookSpecificOutput === 'object' && out.hookSpecificOutput !== null ? /** @type {Record<string, unknown>} */ (out.hookSpecificOutput) : null;
  // 拒否する呼び出しは走らないので触らない
  if (h !== null && h.permissionDecision === 'deny') return { out, action: null, timeoutMs: null };
  const input = /** @type {Record<string, unknown>} */ (h !== null && typeof h.updatedInput === 'object' && h.updatedInput !== null ? h.updatedInput : ti);
  // 背景の走行には時間切れが無い
  if (input.run_in_background === true) return { out, action: null, timeoutMs: null };
  const { limit, max } = limitsOf(input, env);
  if (need.needMs <= limit) return { out, action: null, timeoutMs: null };
  /** @type {Record<string, unknown>} */
  let updated;
  /** @type {'extend' | 'background'} */
  let action;
  let timeoutMs = null;
  if (need.needMs > max && need.finishes) {
    updated = { ...input, run_in_background: true };
    action = 'background';
  } else {
    timeoutMs = Math.min(max, Math.ceil(need.needMs / 1000) * 1000);
    if (timeoutMs <= limit) return { out, action: null, timeoutMs: null };
    updated = { ...input, timeout: timeoutMs };
    action = 'extend';
  }
  return { out: { hookSpecificOutput: { ...(h ?? {}), hookEventName: 'PreToolUse', updatedInput: updated } }, action, timeoutMs };
}
