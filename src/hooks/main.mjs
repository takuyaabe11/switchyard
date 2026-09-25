// @ts-check
// hook の入口(設計 §9.2): 標準入力の JSON を読み、イベントごとの判定を呼び、結果を標準出力へ書く。
// 判断の記録(§4.2 の hooks.jsonl)もここで行う — 判定そのもの(preToolUse)は書かない純粋な関数に保つ。
// switchyard replay の空回しや、テストでの試算が、実際の記録を汚さないようにするため。
import { switchyardHome, pathsOf } from '../daemon/paths.mjs';
import { appendRecord } from '../daemon/store.mjs';
import { ask, connectDaemon } from '../client/connect.mjs';
import { repoFamily, repoRoot } from '../config/context.mjs';
import { preToolUse, waitExpected } from './pretooluse.mjs';
import { foregroundAmpersand } from './ampersand.mjs';
import { postToolUseFailure } from './failure.mjs';
import { guardTimeout, neededTime, normalized, readTimedOut } from './timeouts.mjs';
import { backgroundWaitLoop } from './waitloop.mjs';
import { usageKey } from '../core/usage.mjs';
import { sessionStart, stop } from './session.mjs';
import { t } from '../i18n.mjs';
import { loggedCommand } from '../redact.mjs';

/** @typedef {import('../config/profiles.mjs').NamedProfile} NamedProfile */

/**
 * PreToolUse の判断を hooks.jsonl へ 1 行残す。何もしなかった分(out が null)は書かない。
 * 書けなくても hook の判断はそのまま返す(記録は補助で、失敗で作業を止めない)。
 * @param {Record<string, unknown>} input @param {Record<string, unknown> | null} out @param {NodeJS.ProcessEnv} env
 * @param {boolean} [observe] 観察だけのモードの判断(実際にはしていない)
 */
function recordPreToolUse(input, out, env, observe = false) {
  if (out === null) return;
  const h = /** @type {Record<string, unknown>} */ (typeof out.hookSpecificOutput === 'object' && out.hookSpecificOutput !== null ? out.hookSpecificOutput : {});
  const ti = /** @type {Record<string, unknown>} */ (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {});
  const updated = /** @type {Record<string, unknown> | undefined} */ (h.updatedInput);
  // wrap: switchyard run で包むよう書き換えた(背景へ回したかは問わない)
  // ask: switchyard run の中身が重い走行の形ではないので承認を求めた
  const decision = h.permissionDecision === 'deny' || h.permissionDecision === 'ask' ? h.permissionDecision : updated !== undefined && updated.command !== ti.command ? 'wrap' : 'background';
  try {
    appendRecord(pathsOf(switchyardHome(env)).hooks, {
      at: Date.now(),
      kind: 'hook',
      decision,
      session: typeof input.session_id === 'string' ? input.session_id : '',
      cwd: typeof input.cwd === 'string' ? input.cwd : '',
      cmd: typeof ti.command === 'string' ? loggedCommand(ti.command, env) : '',
      ...(observe ? { observe: true } : {}),
    });
  } catch {
    /* 記録できないときは黙って進む */
  }
}

/** @param {Record<string, unknown> | null} out */
const isAsk = (out) => out !== null && typeof out.hookSpecificOutput === 'object' && out.hookSpecificOutput !== null && /** @type {Record<string, unknown>} */ (out.hookSpecificOutput).permissionDecision === 'ask';

/** @param {Record<string, unknown> | null} out */
const isBackground = (out) => out !== null && typeof out.hookSpecificOutput === 'object' && out.hookSpecificOutput !== null && 'updatedInput' in out.hookSpecificOutput;

/**
 * 背景へ回す方針(SWITCHYARD_BACKGROUND)。auto(既定)は待ちが見込まれるときだけ、always は重ければ必ず、never は回さない。
 * @param {NodeJS.ProcessEnv} env @returns {'auto' | 'always' | 'never'}
 */
export function backgroundMode(env) {
  const v = env.SWITCHYARD_BACKGROUND;
  return v === 'always' || v === 'never' ? v : 'auto';
}

/**
 * デーモンの盤面。居なければ null(起動しない。居ないなら次の要求で空のデーモンが立ち、待たずに入場する)。
 * @param {NodeJS.ProcessEnv} env @returns {Promise<import('../protocol/messages.mjs').Snapshot | null>}
 */
async function snapshot(env) {
  try {
    const conn = await connectDaemon({ home: switchyardHome(env), env, autoStart: false });
    const m = await ask(conn, { t: 'status' }, (x) => x.t === 'status', 1_000);
    return /** @type {import('../protocol/messages.mjs').Snapshot} */ (m.snapshot);
  } catch {
    return null;
  }
}

/**
 * hook の判断を hooks.jsonl へ残す(書けなくても黙って進む)。
 * @param {Record<string, unknown>} input @param {NodeJS.ProcessEnv} env @param {Record<string, unknown>} fields
 */
function recordHook(input, env, fields) {
  const ti = /** @type {Record<string, unknown>} */ (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {});
  try {
    appendRecord(pathsOf(switchyardHome(env)).hooks, {
      at: Date.now(),
      kind: 'hook',
      session: typeof input.session_id === 'string' ? input.session_id : '',
      cwd: typeof input.cwd === 'string' ? input.cwd : '',
      cmd: typeof ti.command === 'string' ? loggedCommand(ti.command, env) : '',
      ...fields,
    });
  } catch {
    /* 記録できないときは黙って進む */
  }
}

/**
 * Bash の時間切れで切られないよう、時間切れを延ばす / 背景へ回す(SWITCHYARD_TIMEOUT_GUARD=0 で止める)。
 * 前に同じ場所で同じコマンドが切られていれば、その倍。デーモンが学んだ、自分で終わった走行の最長の所要があれば、その 1.5 倍。
 * @param {Record<string, unknown>} input @param {Record<string, unknown> | null} out @param {NodeJS.ProcessEnv} env
 * @param {{ heavy: import('./pretooluse.mjs').Heavy[], snap: import('../protocol/messages.mjs').Snapshot | null, learn: string | null }} ctx
 * @returns {Record<string, unknown> | null}
 */
function withTimeoutGuard(input, out, env, { heavy, snap, learn }) {
  if (env.SWITCHYARD_TIMEOUT_GUARD === '0') return out;
  const ti = /** @type {Record<string, unknown>} */ (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {});
  const command = typeof ti.command === 'string' ? ti.command : '';
  if (command === '' || ti.run_in_background === true) return out;
  const root = repoRoot(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const key = normalized(command);
  const remembered = readTimedOut(env).find((e) => e.root === root && e.command === key) ?? null;
  // 重い部分が並んで走る(&& で続く)なら、所要は足し合わせる。学んでいない部分が 1 つでもあれば、学んだ所要からは出さない
  let longestMs = /** @type {number | null} */ (null);
  if (snap !== null && learn !== null && heavy.length > 0 && heavy.every((h) => h.profile !== undefined && snap.longest?.[usageKey(learn, h.profile)] !== undefined)) {
    longestMs = heavy.reduce((n, h) => n + Number(snap.longest?.[usageKey(learn, String(h.profile))]), 0);
  }
  const need = neededTime({ remembered, longestMs });
  if (need === null) return out;
  const g = guardTimeout(ti, out, need, env);
  if (g.action !== null) recordHook(input, env, { decision: g.action === 'extend' ? 'extend' : 'background', timeoutMs: g.timeoutMs, reason: remembered !== null ? 'timed-out-before' : 'learned' });
  return g.out;
}

/**
 * @param {string} event pre-tool-use / post-tool-use-failure / session-start / stop
 * @param {string} raw 標準入力
 * @param {{ write?: (s: string) => void, env?: NodeJS.ProcessEnv, profilesFor?: (cwd: string) => NamedProfile[] }} [opts]
 * @returns {Promise<void>}
 */
export async function runHook(event, raw, { write = (s) => process.stdout.write(s), env = process.env, profilesFor } = {}) {
  const input = raw.trim() === '' ? {} : JSON.parse(raw);
  switch (event) {
    case 'pre-tool-use': {
      const base = { env, ...(profilesFor === undefined ? {} : { profilesFor }) };
      if (env.SWITCHYARD_OBSERVE === '1') {
        // 観察だけのモード: 判断を記録するだけで、拒否も背景化もしない(重い走行はすべて「背景の候補」として数える)。
        // switchyard run の中身への承認の求め(ask)だけは返す。順番待ちではなく、許可の設定が広がるのを防ぐためのもの
        const observed = preToolUse(input, base);
        recordPreToolUse(input, observed, env, true);
        if (isAsk(observed)) {
          const { updatedInput: _, ...h } = /** @type {Record<string, unknown>} */ (observed?.hookSpecificOutput);
          write(JSON.stringify({ hookSpecificOutput: h }));
        }
        return;
      }
      /** @type {import('./pretooluse.mjs').Heavy[]} 重い部分(背景へ回すかを決める関数に渡るもの) */
      let heavy = [];
      let out = preToolUse(input, {
        ...base,
        shouldBackground: (h) => {
          heavy = h;
          return true;
        },
      });
      /** @type {import('../protocol/messages.mjs').Snapshot | null} */
      let snap = null;
      // 盤面の縮めた取り分(sized)と学んだ所要(longest)は、学習の鍵(worktree の一族)で引く
      const learn = heavy.length > 0 ? repoFamily(repoRoot(typeof input.cwd === 'string' ? input.cwd : process.cwd())) : null;
      // 重い部分があるときだけ、デーモンの盤面を見る。普段の Bash の呼び出しにはデーモンへの問い合わせを足さない
      if (heavy.length > 0 && (backgroundMode(env) === 'auto' || env.SWITCHYARD_TIMEOUT_GUARD !== '0')) snap = await snapshot(env);
      if (isBackground(out) && backgroundMode(env) === 'auto') {
        // 待ちが見込まれなければ前景のまま走らせる
        const s = snap;
        out = preToolUse(input, { ...base, shouldBackground: (h) => s !== null && waitExpected(s, h, learn ?? undefined) });
      } else if (isBackground(out) && backgroundMode(env) === 'never') {
        // 背景へは回さない。switchyard run で包む書き換えだけは残す
        out = preToolUse(input, { ...base, shouldBackground: () => false });
      }
      recordPreToolUse(input, out, env);
      out = withTimeoutGuard(input, out, env, { heavy, snap, learn });
      // 前景で待つループ(sleep を含む until / while / for)は背景へ回す。時間切れで切られず、終われば Claude に知らせが届く
      const ti = /** @type {Record<string, unknown>} */ (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {});
      // 重い走行を最後の & で裏に回す呼び出しは、& を外して背景実行にする(終われば Claude に知らせが届く)
      const amp = foregroundAmpersand(ti, out, env, heavy.length > 0);
      if (amp.applied) recordHook(input, env, { decision: 'amp-background' });
      out = amp.out;
      const w = backgroundWaitLoop(ti, out, env);
      if (w.applied) recordHook(input, env, { decision: 'wait-background', estimateMs: w.estimateMs });
      out = w.out;
      if (out !== null) write(JSON.stringify(out));
      return;
    }
    case 'post-tool-use-failure': {
      // 観察だけのモードでは、起きたことを記録するだけ(Claude には何も伝えず、時間切れも覚えない)
      const observe = env.SWITCHYARD_OBSERVE === '1';
      const r = postToolUseFailure(input, env, observe ? { remember: () => {}, holders: () => [] } : {});
      for (const rec of r.records) recordHook(input, env, { ...rec, ...(observe ? { observe: true } : {}) });
      if (r.out !== null && !observe) write(JSON.stringify(r.out));
      return;
    }
    case 'session-start': {
      const lines = await sessionStart(input);
      if (lines.length > 0) write(`${lines.join('\n')}\n`);
      return;
    }
    case 'stop': {
      // 観察だけのモードでは差し戻さない(走行はデーモンを通っていないので、確認待ちも無い)
      if (env.SWITCHYARD_OBSERVE === '1') return;
      const out = await stop(input);
      if (out !== null) write(JSON.stringify(out));
      return;
    }
    default:
      throw new Error(t(`知らない hook: ${event}`, `unknown hook: ${event}`));
  }
}
