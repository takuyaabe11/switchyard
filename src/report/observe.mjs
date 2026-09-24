// @ts-check
// 観察だけのモード(SWITCHYARD_OBSERVE=1)の記録の集計。
// 観察中の switchyard は何も止めず・並べず・拒否しない。重い走行の始まりと終わり(observed.jsonl)と、
// PreToolUse が何をしていたか(hooks.jsonl の observe つきの行)だけを残す。ここではそれを読んで、
// 「入れていれば何が起きたか」を数える: 重い走行同士の重なり、重なりの横で走った計測、同じ git の index を書き換える走行の重なり。
import { duration } from '../cli/render.mjs';
import { t } from '../i18n.mjs';

/**
 * @typedef {{ start: number, end: number, repo: string, cls: string, locks: string[], session: string }} Run
 * @typedef {{
 *   runs: number,
 *   heavy: number,
 *   overlapped: number,
 *   overlapMs: number,
 *   sessions: number,
 *   measureDisturbed: number,
 *   lockClashes: number,
 *   hook: { background: number, deny: number }
 * }} ObservedSummary
 */

/** @param {Record<string, unknown>} r @param {string} k */
const num = (r, k) => (typeof r[k] === 'number' ? /** @type {number} */ (r[k]) : null);
/** @param {Record<string, unknown>} r @param {string} k */
const str = (r, k) => (typeof r[k] === 'string' ? /** @type {string} */ (r[k]) : '');

/** 区間の和の長さ @param {Array<[number, number]>} spans */
function unionLength(spans) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [s, e] of sorted) {
    if (cur === null || s > cur[1]) {
      if (cur !== null) total += cur[1] - cur[0];
      cur = [s, e];
    } else cur[1] = Math.max(cur[1], e);
  }
  if (cur !== null) total += cur[1] - cur[0];
  return total;
}

/**
 * @param {{ observed: Record<string, unknown>[], hooks?: Record<string, unknown>[], repoPrefix?: string | null, since?: number | null }} input
 * @returns {ObservedSummary}
 */
export function summarizeObserved({ observed, hooks = [], repoPrefix = null, since = null }) {
  const inScope = (/** @type {string} */ repo, /** @type {number | null} */ at) =>
    (repoPrefix === null || repo.startsWith(repoPrefix)) && (since === null || (at !== null && at >= since));
  /** @type {Run[]} */
  const runs = [];
  for (const r of observed) {
    const start = num(r, 'start');
    const end = num(r, 'end');
    if (str(r, 'kind') !== 'observed' || start === null || end === null || end < start || !inScope(str(r, 'repo'), start)) continue;
    runs.push({ start, end, repo: str(r, 'repo'), cls: str(r, 'class'), locks: Array.isArray(r.locks) ? r.locks.map(String) : [], session: str(r, 'session') });
  }
  const heavy = runs.filter((r) => r.cls === 'batch' || r.cls === 'measure');
  const overlaps = (/** @type {Run} */ a, /** @type {Run} */ b) => a !== b && a.start < b.end && b.start < a.end;
  let overlapped = 0;
  let overlapMs = 0;
  let measureDisturbed = 0;
  for (const r of heavy) {
    const others = heavy.filter((o) => overlaps(r, o));
    if (others.length === 0) continue;
    overlapped += 1;
    overlapMs += unionLength(others.map((o) => /** @type {[number, number]} */ ([Math.max(r.start, o.start), Math.min(r.end, o.end)])));
    if (r.cls === 'measure') measureDisturbed += 1;
  }
  // 同じ鍵(git の index・ポートなど)を持つ走行の重なり。1 組を 1 回と数える
  let lockClashes = 0;
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      if (overlaps(runs[i], runs[j]) && runs[i].locks.some((k) => runs[j].locks.includes(k))) lockClashes += 1;
    }
  }
  const hook = { background: 0, deny: 0 };
  for (const r of hooks) {
    if (r.observe !== true || str(r, 'kind') !== 'hook' || !inScope(str(r, 'cwd'), num(r, 'at'))) continue;
    if (r.decision === 'background') hook.background += 1;
    else if (r.decision === 'deny') hook.deny += 1;
  }
  return { runs: runs.length, heavy: heavy.length, overlapped, overlapMs, sessions: new Set(heavy.map((r) => r.session)).size, measureDisturbed, lockClashes, hook };
}

/** @param {ObservedSummary} s @returns {string} */
export function formatObserved(s) {
  const lines = [
    t('観察だけのモードの記録(switchyard は何も止めず、並べていない):', 'Observe-only records (switchyard held nothing back and queued nothing):'),
    t(
      `  重い走行 ${s.heavy} 本(${s.sessions} セッション)のうち、他の重い走行と重なった ${s.overlapped} 本・重なっていた時間の合計 ${duration(s.overlapMs)}`,
      `  ${s.overlapped} of ${s.heavy} heavy runs (from ${s.sessions} sessions) overlapped another heavy run, for ${duration(s.overlapMs)} in total`,
    ),
    t(`  他の重い走行の横で走った計測: ${s.measureDisturbed} 本`, `  Measurements that ran beside another heavy run: ${s.measureDisturbed}`),
    t(`  同じ鍵(git の index・ポートなど)を持つ走行の重なり: ${s.lockClashes} 回`, `  Overlaps of runs holding the same lock (git index, a port, ...): ${s.lockClashes}`),
    t(
      `  PreToolUse が入れていれば: 拒否 ${s.hook.deny} 件・重い走行として背景の候補 ${s.hook.background} 件`,
      `  PreToolUse would have: refused ${s.hook.deny}, flagged ${s.hook.background} as heavy runs to send to the background when they had to wait`,
    ),
  ];
  if (s.heavy > 0 && s.overlapped === 0 && s.lockClashes === 0) {
    lines.push(t('  → 重なりは無かった。この使い方では switchyard を入れても得るものはほとんど無い', '  → Nothing overlapped. With this way of working, switchyard would change very little'));
  }
  return `${lines.join('\n')}\n`;
}
