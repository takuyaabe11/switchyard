// @ts-check
// 同じ状態での走り直しを数える(switchyard replay の一部)。重い走行を合流させたり結果を使い回したりする前に、
// それでどれだけの仕事が減るかを、利用者自身の記録で見積もる。
//
// 同じセッションの記録(1 ファイル)の中で、同じ cwd・同じコマンドの重い走行が、間にファイルを書き換えうる操作を挟まずに
// もう一度走ったら「走り直し」と数える。書き換えうる操作の見方を 2 通り持つ:
//   厳しめ: 書き換えのツール(Edit・Write など)と、読むだけと言い切れない Bash(python・sed -i・> への書き出しなど)
//   緩め:   書き換えのツールだけ(Bash での書き換えは見ない。上限の目安)
// 間に挟まった重い走行(別のテスト・ビルド)はソースを書き換えないとみなす。
import { basename } from 'node:path';
import { simpleCommands } from '../hooks/shell.mjs';
import { PORT_IN_USE } from '../hooks/ports.mjs';

/** ファイルを書き換えるツール */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** 読むだけのコマンドの先頭の語(引数によらず、ファイルを書き換えない) */
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'egrep', 'fgrep', 'find', 'fd', 'wc', 'echo', 'printf', 'pwd', 'which', 'type',
  'file', 'stat', 'du', 'df', 'ps', 'tree', 'less', 'more', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'date', 'sleep',
  'true', 'false', 'env', 'printenv', 'jq', 'realpath', 'dirname', 'basename', 'test', '[', 'cd', 'nproc', 'uname', 'id', 'whoami',
]);

/** 読むだけの git のサブコマンド */
const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'reflog']);

/** 読むだけの switchyard のサブコマンド */
const SWITCHYARD_READ_ONLY = new Set(['top', 'why', 'report', 'replay']);

/**
 * このコマンドがファイルを書き換えないと言い切れるか。単純コマンドがすべて読むだけの語で、ファイルへの書き出し(>)が無いときだけ真。
 * @param {string} command @returns {boolean}
 */
export function isReadOnly(command) {
  // 2>&1・>/dev/null・2>/dev/null は書き出しではない
  const rest = command.replace(/[0-9]*>&[0-9]+/g, '').replace(/[0-9]*>>?\s*\/dev\/null/g, '');
  if (rest.includes('>')) return false;
  for (const words of simpleCommands(command)) {
    const [head = '', ...args] = words;
    const base = basename(head);
    if (base === 'git') {
      const sub = args.find((a) => !a.startsWith('-'));
      if (sub === undefined || !GIT_READ_ONLY.has(sub)) return false;
      continue;
    }
    if (base === 'switchyard' || base === 'switchyard.mjs') {
      if (!SWITCHYARD_READ_ONLY.has(args[0] ?? '')) return false;
      continue;
    }
    if (base === 'sed' || base === 'awk') {
      if (args.some((a) => a === '-i' || a.startsWith('-i') || a === 'inplace')) return false;
      continue;
    }
    if (!READ_ONLY.has(base)) return false;
  }
  return true;
}

/** Bash ツールの時間切れの結果(Claude Code の実物: `Exit code 143\nCommand timed out after 2s`・is_error) */
export const TIMED_OUT = /(^|\n)Command timed out after /;

/** ポートが既に使われていて起動できなかった(PostToolUseFailure の知らせと同じ文言) */
export { PORT_IN_USE } from '../hooks/ports.mjs';

/** tool_result の中身の文字列(文字列か、text の塊の並び) @param {unknown} content @returns {string} */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c !== null && typeof c === 'object' && typeof c.text === 'string' ? c.text : '')).join('\n');
}

/**
 * 記録の 1 行から、並べて見るための出来事を取り出す。
 * @typedef {{ kind: 'bash', id: string, command: string, cwd: string, at: number, background: boolean, timeoutMs: number | null }
 *   | { kind: 'edit', at: number }
 *   | { kind: 'result', id: string, at: number, isError: boolean, timedOut: boolean, portInUse: boolean }} Step
 * @param {string} line @returns {Step[]}
 */
export function stepsOf(line) {
  if (!line.includes('tool_use') && !line.includes('tool_result')) return [];
  /** @type {any} */
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  const content = o?.message?.content;
  if (!Array.isArray(content)) return [];
  const at = Date.parse(typeof o.timestamp === 'string' ? o.timestamp : '');
  /** @type {Step[]} */
  const out = [];
  for (const b of content) {
    if (o.type === 'assistant' && b?.type === 'tool_use') {
      if (b.name === 'Bash' && typeof b.input?.command === 'string') {
        const timeoutMs = typeof b.input.timeout === 'number' && b.input.timeout > 0 ? b.input.timeout : null;
        out.push({ kind: 'bash', id: String(b.id ?? ''), command: b.input.command, cwd: typeof o.cwd === 'string' ? o.cwd : '', at, background: b.input.run_in_background === true, timeoutMs });
      } else if (EDIT_TOOLS.has(b.name)) {
        out.push({ kind: 'edit', at });
      }
    } else if (o.type === 'user' && b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      const isError = b.is_error === true;
      const text = isError ? resultText(b.content) : '';
      // 時間切れは is_error の結果にだけ出る。ポートの失敗は、失敗した結果(終了コードが 0 でない)の中だけを見る
      out.push({ kind: 'result', id: b.tool_use_id, at, isError, timedOut: isError && TIMED_OUT.test(text), portInUse: isError && PORT_IN_USE.test(text) });
    }
  }
  return out;
}

/**
 * @typedef {{ runs: number, strict: { count: number, ms: number }, loose: { count: number, ms: number }, afterFailure: number,
 *   top: Array<{ command: string, count: number, ms: number }> }} Reruns
 */

/** 空の集計 @returns {Reruns} */
export const emptyReruns = () => ({ runs: 0, strict: { count: 0, ms: 0 }, loose: { count: 0, ms: 0 }, afterFailure: 0, top: [] });

/**
 * 1 つのセッションの出来事を順に見て、走り直しを数える(集計は acc に足す)。
 * @param {Step[]} steps 記録の順
 * @param {(call: { command: string, cwd: string }) => boolean} isHeavy 重い走行か
 * @param {Reruns} acc
 * @param {Map<string, { count: number, ms: number }>} byCommand 厳しめの走り直しのコマンドごとの集計
 */
export function countSession(steps, isHeavy, acc, byCommand) {
  /** @type {Map<string, { at: number, isError: boolean | null, id: string }>} 前の重い走行(厳しめ: 書き換えうる操作で消える) */
  const strictLast = new Map();
  /** @type {Map<string, { at: number }>} 緩め: 書き換えのツールでだけ消える */
  const looseLast = new Map();
  /** @type {Map<string, { key: string, at: number, background: boolean }>} 結果を待っている重い走行 */
  const pending = new Map();
  /** @type {Map<string, boolean>} 走り直しの id と、厳しめに数えたか(所要が分かったら足す) */
  const rerunIds = new Map();

  for (const s of steps) {
    if (s.kind === 'edit') {
      strictLast.clear();
      looseLast.clear();
      continue;
    }
    if (s.kind === 'result') {
      const p = pending.get(s.id);
      if (p === undefined) continue;
      pending.delete(s.id);
      const ms = p.background || !Number.isFinite(s.at - p.at) ? 0 : Math.max(0, s.at - p.at);
      const strict = rerunIds.get(s.id);
      if (strict !== undefined) {
        acc.loose.ms += ms;
        if (strict) {
          acc.strict.ms += ms;
          const c = byCommand.get(p.key);
          if (c !== undefined) c.ms += ms;
        }
      }
      const last = strictLast.get(p.key);
      if (last !== undefined && last.id === s.id) last.isError = s.isError;
      continue;
    }
    const key = `${s.cwd}\u0000${s.command.replace(/\s+/g, ' ').trim()}`;
    if (!isHeavy({ command: s.command, cwd: s.cwd })) {
      if (!isReadOnly(s.command)) strictLast.clear();
      continue;
    }
    acc.runs += 1;
    const prevStrict = strictLast.get(key);
    if (looseLast.has(key)) {
      acc.loose.count += 1;
      rerunIds.set(s.id, prevStrict !== undefined);
    }
    if (prevStrict !== undefined) {
      acc.strict.count += 1;
      if (prevStrict.isError === true) acc.afterFailure += 1;
      const c = byCommand.get(key) ?? { count: 0, ms: 0 };
      c.count += 1;
      byCommand.set(key, c);
    }
    strictLast.set(key, { at: s.at, isError: null, id: s.id });
    looseLast.set(key, { at: s.at });
    pending.set(s.id, { key, at: s.at, background: s.background });
  }
}

/**
 * 前景で結果を待った重い走行の時間の区間(始まり = Bash の呼び出し、終わり = その結果)。背景の走行は結果がすぐ返り終わりが分からないので数だけ。
 * @typedef {{ start: number, end: number, session: number }} Interval
 * @param {Step[]} steps @param {(call: { command: string, cwd: string }) => boolean} isHeavy @param {number} session 記録の番号
 * @returns {{ intervals: Interval[], background: number }}
 */
export function intervalsOf(steps, isHeavy, session) {
  /** @type {Map<string, number>} */
  const open = new Map();
  /** @type {Interval[]} */
  const intervals = [];
  let background = 0;
  for (const s of steps) {
    if (s.kind === 'bash') {
      if (!isHeavy({ command: s.command, cwd: s.cwd })) continue;
      if (s.background) background += 1;
      else if (Number.isFinite(s.at)) open.set(s.id, s.at);
    } else if (s.kind === 'result') {
      const start = open.get(s.id);
      if (start === undefined) continue;
      open.delete(s.id);
      if (Number.isFinite(s.at) && s.at >= start) intervals.push({ start, end: s.at, session });
    }
  }
  return { intervals, background };
}

/**
 * @typedef {{ runs: number, background: number, totalMs: number, medianMs: number, p90Ms: number, under10s: number, under60s: number,
 *   overlappedRuns: number, overlapMs: number, maxConcurrent: number }} Timing
 */

/**
 * 重い走行の所要の分布と、セッションをまたいだ重なり(2 本以上が同時に走っていた時間・他と重なった走行・同時に走った最大の本数)。
 * 同じ記録(セッション)の前景の走行同士は重ならないので、重なりはセッションをまたいだものになる。
 * @param {Interval[]} intervals @param {number} background @returns {Timing}
 */
export function timingOf(intervals, background) {
  const durations = intervals.map((i) => i.end - i.start).sort((a, b) => a - b);
  const at = (/** @type {number} */ q) => (durations.length === 0 ? 0 : durations[Math.min(durations.length - 1, Math.floor(q * (durations.length - 1)))]);
  // 走査: 始まりと終わりを時刻順に並べ(同じ時刻なら終わりが先。つながっているだけの 2 本は重ならない)、同時に走っている本数を数える
  /** @type {Array<{ t: number, d: 1 | -1, i: number }>} */
  const edges = [];
  intervals.forEach((iv, i) => {
    if (iv.end > iv.start) edges.push({ t: iv.start, d: 1, i }, { t: iv.end, d: -1, i });
  });
  edges.sort((a, b) => a.t - b.t || a.d - b.d);
  /** @type {Set<number>} */
  const active = new Set();
  /** @type {Set<number>} */
  const overlapped = new Set();
  let overlapMs = 0;
  let maxConcurrent = 0;
  let last = 0;
  for (const e of edges) {
    if (active.size >= 2) overlapMs += e.t - last;
    last = e.t;
    if (e.d === 1) {
      if (active.size > 0) {
        overlapped.add(e.i);
        for (const j of active) overlapped.add(j);
      }
      active.add(e.i);
      maxConcurrent = Math.max(maxConcurrent, active.size);
    } else {
      active.delete(e.i);
    }
  }
  return {
    runs: intervals.length,
    background,
    totalMs: durations.reduce((n, d) => n + d, 0),
    medianMs: at(0.5),
    p90Ms: at(0.9),
    under10s: durations.filter((d) => d < 10_000).length,
    under60s: durations.filter((d) => d < 60_000).length,
    overlappedRuns: overlapped.size,
    overlapMs,
    maxConcurrent,
  };
}

/**
 * 1 本のセッションでも起きる事故: Bash の時間切れと、ポートが使用中で落ちた走行。
 * @typedef {{ command: string, count: number, ms: number, kind?: TimeoutKind }} MishapCommand
 * @typedef {{
 *   timeouts: { count: number, heavy: number, atDefault: number, ms: number, rerun: number, rerunBackground: number, top: MishapCommand[],
 *     kinds: Record<TimeoutKind, { count: number, ms: number }> },
 *   portInUse: { count: number, heavy: number, top: MishapCommand[] },
 * }} Mishaps
 */

/**
 * 時間切れで切られた呼び出しの種類。
 * - wait: 何かが終わるのを前景で待っていた(sleep を含む until / while / for のループ・sleep だけ・tail -f・watch・gh run watch)
 * - heavy: 重い走行(テスト・ビルド)
 * - other: それ以外
 * 待つループの中に重いコマンドがあっても、待つ形を先に見る(切られたのは待っていたから)。
 * @typedef {'wait' | 'heavy' | 'other'} TimeoutKind
 */

/** 前景で待つ形 */
const WAIT_LOOP = /\b(?:until|while|for)\b[\s\S]*\bdo\b[\s\S]*\bsleep\b/;
const WAIT_ALONE = /^\s*sleep\s+\d+(?:\.\d+)?\s*$|\btail\b[^;&|\n]*\s(?:-[a-zA-Z]*[fF][a-zA-Z]*|--follow)\b|(?:^|[;&|]\s*)watch\s|\bgh\s+run\s+watch\b/;

/**
 * @param {string} command @param {boolean} heavy @returns {TimeoutKind}
 */
export function timeoutKind(command, heavy) {
  if (WAIT_LOOP.test(command) || WAIT_ALONE.test(command)) return 'wait';
  return heavy ? 'heavy' : 'other';
}

/** 空の集計 @returns {Mishaps} */
export const emptyMishaps = () => ({
  timeouts: { count: 0, heavy: 0, atDefault: 0, ms: 0, rerun: 0, rerunBackground: 0, top: [], kinds: { wait: { count: 0, ms: 0 }, heavy: { count: 0, ms: 0 }, other: { count: 0, ms: 0 } } },
  portInUse: { count: 0, heavy: 0, top: [] },
});

/**
 * 1 つのセッションの出来事を順に見て、時間切れとポートの失敗を数える(集計は acc に足す)。
 * 時間切れの後に、同じ場所で同じコマンドがもう一度走ったら、走り直しと数える(背景へ回したかも数える)。
 * @param {Step[]} steps 記録の順
 * @param {(call: { command: string, cwd: string }) => boolean} isHeavy
 * @param {Mishaps} acc
 * @param {{ timeouts: Map<string, { count: number, ms: number }>, portInUse: Map<string, { count: number, ms: number }> }} byCommand
 */
export function countMishaps(steps, isHeavy, acc, byCommand) {
  /** @type {Map<string, { key: string, command: string, cwd: string, at: number, background: boolean, timeoutMs: number | null }>} */
  const calls = new Map();
  /** @type {Set<string>} 時間切れで終わり、まだ走り直していないコマンド */
  const timedOut = new Set();
  /** @param {Map<string, { count: number, ms: number }>} m @param {string} key @param {number} ms */
  const bump = (m, key, ms) => {
    const c = m.get(key) ?? { count: 0, ms: 0 };
    c.count += 1;
    c.ms += ms;
    m.set(key, c);
  };
  for (const s of steps) {
    if (s.kind === 'bash') {
      const key = `${s.cwd}\u0000${s.command.replace(/\s+/g, ' ').trim()}`;
      if (timedOut.has(key)) {
        timedOut.delete(key);
        acc.timeouts.rerun += 1;
        if (s.background) acc.timeouts.rerunBackground += 1;
      }
      calls.set(s.id, { key, command: s.command, cwd: s.cwd, at: s.at, background: s.background, timeoutMs: s.timeoutMs });
      continue;
    }
    if (s.kind !== 'result') continue;
    const c = calls.get(s.id);
    if (c === undefined) continue;
    calls.delete(s.id);
    const ms = c.background || !Number.isFinite(s.at - c.at) ? 0 : Math.max(0, s.at - c.at);
    const heavy = (s.timedOut || s.portInUse) && isHeavy({ command: c.command, cwd: c.cwd });
    if (s.timedOut) {
      acc.timeouts.count += 1;
      acc.timeouts.ms += ms;
      if (heavy) acc.timeouts.heavy += 1;
      if (c.timeoutMs === null) acc.timeouts.atDefault += 1;
      const k = timeoutKind(c.command, heavy);
      acc.timeouts.kinds[k].count += 1;
      acc.timeouts.kinds[k].ms += ms;
      timedOut.add(c.key);
      // 種類ごとに上位を出すので、種類を鍵の頭に付ける
      bump(byCommand.timeouts, `${k}\u0001${c.key}`, ms);
    }
    if (s.portInUse) {
      acc.portInUse.count += 1;
      if (heavy) acc.portInUse.heavy += 1;
      bump(byCommand.portInUse, c.key, ms);
    }
  }
}
