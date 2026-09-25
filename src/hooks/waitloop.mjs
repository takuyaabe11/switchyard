// @ts-check
// 前景で待つループ(何かが終わるのを sleep しながら待つ until / while / for)を見つけ、長くなりうるものを背景へ回す。
// 利用者の 30 日の記録で、Bash の時間切れ 170 件・25 時間のうち、前景で待つループが最も多かった
// (背景に回した走行の終わりを、前景のループで 10 分の上限まで待って切られる)。
// 背景の走行には時間切れが無く、終わると Claude Code が Claude に知らせるので、前景で張り付く必要が無くなる。
// 終わらないループ(抜け道の無い while true・tail -f・watch)は背景へ回さない。回すと誰も止めないまま走り続ける。
// SWITCHYARD_WAIT_LOOPS=0 で止める。
import { simpleCommands } from './shell.mjs';

/** sleep を含む until / while / for のループ(do の後ろに sleep) */
export const WAIT_LOOP = /\b(?:until|while|for)\b[\s\S]*\bdo\b[\s\S]*\bsleep\b/;

/** 背景へ回す目安(ms)。見積もりがこれ以下のループは前景のまま(すぐ終わる待ちまで背景にしない) */
export const WAIT_BACKGROUND_MS = 60_000;
/** 回数の決まらないループを背景へ回す、1 回の sleep の最小(秒) */
export const UNBOUNDED_MIN_SLEEP_S = 5;

/**
 * sleep の引数(秒)。2・0.5・2s・3m・1h の形。読めなければ null。
 * @param {string} arg @returns {number | null}
 */
export function sleepSeconds(arg) {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(arg);
  if (m === null) return null;
  const n = Number(m[1]);
  return m[2] === 'm' ? n * 60 : m[2] === 'h' ? n * 3600 : m[2] === 'd' ? n * 86_400 : n;
}

/**
 * ループの回数の上限。読めなければ null(回数の決まらないループ)。
 * - for i in $(seq N) / $(seq A B) / {1..N} / 1 2 3 …
 * - for ((i = 0; i < N; i++))
 * - while [ $n -lt N ](数える変数を 0 か 1 から足していく形)
 * @param {string} command @returns {number | null}
 */
export function loopIterations(command) {
  let m = /\bfor\s+\w+\s+in\s+\$\(\s*seq\s+(?:(\d+)\s+)?(\d+)\s*\)/.exec(command);
  if (m !== null) return Math.max(0, Number(m[2]) - Number(m[1] ?? 1) + 1);
  m = /\bfor\s+\w+\s+in\s+\{(\d+)\.\.(\d+)\}/.exec(command);
  if (m !== null) return Math.abs(Number(m[2]) - Number(m[1])) + 1;
  m = /\bfor\s*\(\(\s*\w+\s*=\s*(\d+)\s*;\s*\w+\s*(<=?)\s*(\d+)\s*;/.exec(command);
  if (m !== null) return Math.max(0, Number(m[3]) - Number(m[1]) + (m[2] === '<=' ? 1 : 0));
  m = /\bfor\s+\w+\s+in\s+(\d+(?:\s+\d+)*)\s*(?:;|\bdo\b)/.exec(command);
  if (m !== null) return m[1].trim().split(/\s+/).length;
  m = /\bwhile\s+\[\[?\s+"?\$\w+"?\s+-(lt|le)\s+(\d+)\s*\]\]?/.exec(command);
  if (m !== null) return Number(m[2]) + (m[1] === 'le' ? 1 : 0);
  return null;
}

/**
 * 抜け道の無い無限ループか(while true / while : / until false で、break も exit も return も無い)。
 * @param {string} command @returns {boolean}
 */
function endless(command) {
  const forever = /\bwhile\s+(?:true|:|\[\s*1\s*\])\s*;?\s*do\b|\buntil\s+false\s*;?\s*do\b/.test(command);
  return forever && !/\b(?:break|exit|return)\b/.test(command);
}

/**
 * ループと sleep を実際に走らせるか(heredoc の本文や引用の中に書いてあるだけではないか)。
 * 単純コマンドに分けて、先頭が until / while / for のものと、sleep を走らせるもの(先頭か、do・then・else の次)がそろうかを見る。
 * @param {string} command @returns {boolean}
 */
function runsLoopWithSleep(command) {
  const cmds = simpleCommands(command);
  const loop = cmds.some((w) => w[0] === 'until' || w[0] === 'while' || w[0] === 'for');
  const sleeps = cmds.some((w) => w[0] === 'sleep' || (['do', 'then', 'else'].includes(w[0] ?? '') && w[1] === 'sleep'));
  return loop && sleeps;
}

/**
 * 前景で待つ形か、どれだけ待ちうるか。
 * @param {string} command
 * @returns {{ wait: false } | { wait: true, estimateMs: number | null, background: boolean }}
 *   estimateMs: 回数 × sleep の見積もり。回数の決まらないループ(until 条件・while 条件)は null
 *   background: 背景へ回す(見積もりが WAIT_BACKGROUND_MS を超えるか、回数は決まらないが終わる条件がある)
 */
export function waitLoopOf(command) {
  const trimmed = command.trim();
  // sleep だけ(Claude が時間をつぶしている)
  const alone = /^sleep\s+(\S+)\s*$/.exec(trimmed);
  if (alone !== null) {
    const s = sleepSeconds(alone[1]);
    if (s === null) return { wait: false };
    const estimateMs = s * 1000;
    return { wait: true, estimateMs, background: estimateMs > WAIT_BACKGROUND_MS };
  }
  // gh run watch は CI が終われば終わる
  if (/(?:^|[;&|]\s*)gh\s+run\s+watch\b/.test(trimmed)) return { wait: true, estimateMs: null, background: true };
  if (!WAIT_LOOP.test(trimmed) || !runsLoopWithSleep(trimmed)) return { wait: false };
  if (endless(trimmed)) return { wait: true, estimateMs: null, background: false };
  const iterations = loopIterations(trimmed);
  const sleeps = [...trimmed.matchAll(/\bsleep\s+(\d+(?:\.\d+)?[smhd]?)(?![\w.])/g)].map((m) => sleepSeconds(m[1])).filter((s) => s !== null);
  const perRound = sleeps.length === 0 ? null : sleeps.reduce((n, s) => n + /** @type {number} */ (s), 0);
  // 回数の決まらないループ(until 条件・while 条件)は、1 回の sleep が短い(5 秒未満)なら前景のまま
  // (サーバーの立ち上がりを 1 秒ずつ待つような、すぐ終わる待ちまで背景にしない)
  if (iterations === null || perRound === null) return { wait: true, estimateMs: null, background: perRound === null || perRound >= UNBOUNDED_MIN_SLEEP_S };
  const estimateMs = Math.round(iterations * perRound * 1000);
  return { wait: true, estimateMs, background: estimateMs > WAIT_BACKGROUND_MS };
}

/**
 * 待つループを背景へ回す書き換え。何もしなくてよければ out をそのまま返す。
 * 拒否する呼び出し・もう背景の呼び出しは触らない。他の書き換え(switchyard run で包む・時間切れを延ばす)の上に重ねる。
 * @param {Record<string, unknown>} ti @param {Record<string, unknown> | null} out @param {NodeJS.ProcessEnv} env
 * @returns {{ out: Record<string, unknown> | null, estimateMs: number | null, applied: boolean }}
 */
export function backgroundWaitLoop(ti, out, env) {
  const none = { out, estimateMs: null, applied: false };
  if (env.SWITCHYARD_WAIT_LOOPS === '0') return none;
  const h = out !== null && typeof out.hookSpecificOutput === 'object' && out.hookSpecificOutput !== null ? /** @type {Record<string, unknown>} */ (out.hookSpecificOutput) : null;
  if (h !== null && h.permissionDecision === 'deny') return none;
  const input = /** @type {Record<string, unknown>} */ (h !== null && typeof h.updatedInput === 'object' && h.updatedInput !== null ? h.updatedInput : ti);
  if (input.run_in_background === true) return none;
  const command = typeof input.command === 'string' ? input.command : '';
  const w = waitLoopOf(command);
  if (!w.wait || !w.background) return none;
  // 時間切れは背景では効かないので外す(延ばした timeout が残っても害は無いが、背景の走行には意味が無い)
  const { timeout: _t, ...rest } = input;
  return { out: { hookSpecificOutput: { ...(h ?? {}), hookEventName: 'PreToolUse', updatedInput: { ...rest, run_in_background: true } } }, estimateMs: w.estimateMs, applied: true };
}
