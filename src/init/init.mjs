// @ts-check
// switchyard init: 過去の Claude Code のセッション記録から、この repo で繰り返し走っていて長いのに、
// まだどの profile にも当たらないコマンドを見つけ、switchyard.json の profile として提案する。
// 所要は、Bash の tool_use の時刻から、その tool_result の時刻まで(前景で走ったものだけ。背景へ回したものは結果がすぐ返るので数えない)。
// 記録は読むだけ。書くのは --write のときの switchyard.json だけで、既にある profile は変えない。
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { classifiableCommand, classify } from '../config/profiles.mjs';
import { headWord, SHIM_WORDS } from '../hooks/pretooluse.mjs';
import { simpleCommands } from '../hooks/shell.mjs';
import { t } from '../i18n.mjs';
import { duration } from '../cli/render.mjs';

/** @typedef {import('../config/profiles.mjs').NamedProfile} NamedProfile */
/** @typedef {import('../config/profiles.mjs').Profile} Profile */
/**
 * @typedef {{
 *   pattern: string,
 *   name: string,
 *   count: number,
 *   medianMs: number,
 *   shimmed: boolean,
 *   example: string
 * }} Suggestion
 */

/**
 * 所要を測るのに数えない語。前置き(cd x && …)、出力を絞る軽い道具(… | tail -50)、シェルの構文(for / done など)。
 * これらを除いて重い単純コマンドが 1 つだけ残る呼び出しの所要を、そのコマンドのものとみなす。
 */
const NOISE = new Set([
  'cd', 'pushd', 'popd', 'export', 'source', '.', 'set', 'unset', 'echo', 'printf', 'true', 'false', 'sleep', 'wait', 'mktemp', 'seq', 'date',
  'tail', 'head', 'grep', 'egrep', 'rg', 'tee', 'cat', 'sort', 'uniq', 'wc', 'sed', 'awk', 'cut', 'tr', 'paste', 'less', 'more', 'xargs', 'jq', 'column',
  'ls', 'pwd', 'which', 'command', 'type',
  'for', 'while', 'until', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'case', 'esac', 'in', '{', '}', 'break', 'continue', 'exit', 'return',
]);

/**
 * 単純コマンドから、profile の glob の元になる形を取る。先頭の語と、その後ろのサブコマンドらしい語(最大 3 語まで)。
 * `-m モジュール` は 1 組として取る(python -m pytest)。パス・旗・値はそこで止める。
 * @param {string[]} words @returns {string | null}
 */
export function patternOf(words) {
  const { head, rest } = headWord(words.join(' '));
  if (head === '' || NOISE.has(head)) return null;
  const out = [head];
  for (let i = 0; i < rest.length && out.length < 3; i += 1) {
    const w = rest[i];
    if (w === '-m' && rest[i + 1] !== undefined) {
      out.push(w, rest[i + 1]);
      i += 1;
      continue;
    }
    if (!/^[A-Za-z][\w:.@-]*$/.test(w)) break;
    out.push(w);
  }
  return out.join(' ');
}

/** 提案する profile の名前(glob の形から) @param {string} pattern @returns {string} */
const nameOf = (pattern) =>
  pattern
    .replace(/^\.\//, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'cmd';

/** @param {number[]} xs */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor((s.length - 1) / 2)];
}

/**
 * 記録の根の下の *.jsonl を読み、repo の中で走った前景の Bash の呼び出しを、所要とともに取り出す。
 * @param {{ dir: string, repo: string, since: number | null }} opts
 * @returns {Promise<Array<{ command: string, cwd: string, ms: number }>>}
 */
export async function foregroundCalls({ dir, repo, since }) {
  const files = existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((p) => p.endsWith('.jsonl'))
        .map((p) => join(dir, p))
    : [];
  /** @type {Map<string, { command: string, cwd: string, at: number }>} */
  const started = new Map();
  /** @type {Array<{ command: string, cwd: string, ms: number }>} */
  const out = [];
  /** @type {Set<string>} */
  const done = new Set();
  const inRepo = (/** @type {string} */ cwd) => cwd === repo || cwd.startsWith(`${repo}/`);
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('tool_use') && !line.includes('tool_result')) continue;
      /** @type {any} */
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(o?.timestamp ?? '');
      if (!Number.isFinite(at) || !Array.isArray(o?.message?.content)) continue;
      for (const b of o.message.content) {
        if (o.type === 'assistant' && b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string' && typeof b.id === 'string') {
          const cwd = typeof o.cwd === 'string' ? o.cwd : '';
          if (b.input.run_in_background === true || !inRepo(cwd) || (since !== null && at < since)) continue;
          started.set(b.id, { command: b.input.command, cwd, at });
        } else if (o.type === 'user' && b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const s = started.get(b.tool_use_id);
          if (s === undefined || done.has(b.tool_use_id)) continue;
          done.add(b.tool_use_id);
          out.push({ command: s.command, cwd: s.cwd, ms: Math.max(0, at - s.at) });
        }
      }
    }
  }
  return out;
}

/**
 * 前景の呼び出しから提案を作る。前置き(cd など)を除いて単純コマンドが 1 つだけの呼び出しを、形ごとにまとめる。
 * 既に profile に当たる形・回数が足りない形・中央値が短い形は出さない。
 * @param {{ calls: Array<{ command: string, ms: number }>, profiles: NamedProfile[], minCount?: number, minMs?: number }} input
 * @returns {Suggestion[]}
 */
export function suggest({ calls, profiles, minCount = 2, minMs = 20_000 }) {
  /** @type {Map<string, { durations: number[], example: string, shimmed: boolean }>} */
  const groups = new Map();
  for (const c of calls) {
    const parts = simpleCommands(c.command).filter((w) => patternOf(w) !== null);
    if (parts.length !== 1) continue;
    const words = parts[0];
    const pattern = patternOf(words);
    if (pattern === null) continue;
    const { head, rest } = headWord(words.join(' '));
    if (classify(classifiableCommand([head, ...rest]), profiles) !== null) continue;
    const g = groups.get(pattern) ?? { durations: [], example: c.command, shimmed: SHIM_WORDS.includes(head) || /(^|\/)node_modules\/\.bin\//.test(head) };
    g.durations.push(c.ms);
    groups.set(pattern, g);
  }
  /** @type {Suggestion[]} */
  const out = [];
  const names = new Set(profiles.map((p) => p.name));
  for (const [pattern, g] of groups) {
    const medianMs = median(g.durations);
    if (g.durations.length < minCount || medianMs < minMs) continue;
    let name = nameOf(pattern);
    while (names.has(name)) name = `${name}-2`;
    names.add(name);
    out.push({ pattern, name, count: g.durations.length, medianMs, shimmed: g.shimmed, example: g.example });
  }
  return out.sort((a, b) => b.count * b.medianMs - a.count * a.medianMs);
}

/** 提案を profile にする @param {Suggestion} s @returns {Profile} */
export const profileOf = (s) => ({ match: [s.pattern, `${s.pattern} *`], class: 'batch', cpus: { min: 2, max: 4 } });

/**
 * 既にある switchyard.json に、提案の profile を足す(既にある profile は変えない)。
 * @param {string} file @param {Suggestion[]} suggestions @returns {Record<string, unknown>}
 */
export function merged(file, suggestions) {
  /** @type {Record<string, unknown>} */
  let raw = {};
  if (existsSync(file)) raw = JSON.parse(readFileSync(file, 'utf8'));
  const profiles = /** @type {Record<string, unknown>} */ (typeof raw.profiles === 'object' && raw.profiles !== null ? raw.profiles : {});
  for (const s of suggestions) if (!(s.name in profiles)) profiles[s.name] = profileOf(s);
  return { ...raw, profiles };
}

/**
 * @param {{ repo: string, suggestions: Suggestion[], calls: number, write: boolean, file: string }} r @returns {string}
 */
export function formatInit({ repo, suggestions, calls, write, file }) {
  /** @type {string[]} */
  const lines = [t(`対象: ${repo} で前景で走った Bash の呼び出し ${calls} 件`, `Scope: ${calls} foreground Bash calls in ${repo}`)];
  if (suggestions.length === 0) {
    lines.push(t('提案なし: 繰り返し走っていて長いのに、どの profile にも当たらないコマンドは見つからなかった', 'Nothing to suggest: no repeated, long-running command that no profile covers'));
    return `${lines.join('\n')}\n`;
  }
  lines.push(t('提案(回数 × 中央値の大きい順):', 'Suggestions (largest count × median first):'));
  for (const s of suggestions) {
    const note = s.shimmed ? '' : t('  ※ shim から見えないので `switchyard run -- …` で呼ぶ', '  (not seen by a shim: call it as `switchyard run -- …`)');
    lines.push(t(`  ${s.name}: "${s.pattern}"  ${s.count} 回・中央 ${duration(s.medianMs)}${note}`, `  ${s.name}: "${s.pattern}"  ${s.count} runs, median ${duration(s.medianMs)}${note}`));
  }
  lines.push(
    write
      ? t(`${file} に書き足した(既にある profile は変えていない)`, `added to ${file} (existing profiles left as they are)`)
      : t(`書き足すには switchyard init --write。class や cpus は ${file} で直せる`, `Run switchyard init --write to add them; adjust class and cpus in ${file}`),
  );
  return `${lines.join('\n')}\n`;
}

/** @param {string} file @param {Record<string, unknown>} value */
export function writeConfig(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
