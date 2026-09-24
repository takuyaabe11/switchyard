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

/**
 * 記録の 1 行から、並べて見るための出来事を取り出す。
 * @typedef {{ kind: 'bash', id: string, command: string, cwd: string, at: number, background: boolean }
 *   | { kind: 'edit', at: number }
 *   | { kind: 'result', id: string, at: number, isError: boolean }} Step
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
        out.push({ kind: 'bash', id: String(b.id ?? ''), command: b.input.command, cwd: typeof o.cwd === 'string' ? o.cwd : '', at, background: b.input.run_in_background === true });
      } else if (EDIT_TOOLS.has(b.name)) {
        out.push({ kind: 'edit', at });
      }
    } else if (o.type === 'user' && b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      out.push({ kind: 'result', id: b.tool_use_id, at, isError: b.is_error === true });
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
