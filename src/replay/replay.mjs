// @ts-check
// switchyard replay: 過去の Claude Code のセッション記録の Bash の呼び出しを、PreToolUse(設計 §9.2)と shim の分類器(§9.1)の実物に流して数える。
// 記録は読むだけで、何も書き出さない。判定のロジックは写さず、hook と分類器をそのまま呼ぶ。
// 近似: shim の欄は、記録のコマンドを区切った単純コマンドのうち shim の語で始まるものだけを数える
//       (パスで呼んだ node のスクリプトが中で通る node の shim と、bash -c の引用の中は数えない)。
import { createReadStream, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { headWord, preToolUse, SHIM_WORDS } from '../hooks/pretooluse.mjs';
import { simpleCommands } from '../hooks/shell.mjs';
import { decideShim } from '../shim/decide.mjs';
import { maskSecrets } from '../redact.mjs';
import { t } from '../i18n.mjs';
import { duration } from '../cli/render.mjs';
import { countMishaps, countSession, emptyMishaps, emptyReruns, intervalsOf, stepsOf, timingOf } from './reruns.mjs';

/** @typedef {import('../config/profiles.mjs').NamedProfile} NamedProfile */
/** @typedef {{ id: string, command: string, runInBackground: boolean, cwd: string, timestamp: string }} BashCall */
/** @typedef {'deny' | 'ask' | 'wrap' | 'background' | 'already-background' | 'none'} HookVerdict */
/** @typedef {{ hook: HookVerdict, shims: Array<{ word: string, answer: string }> }} Judgement */
/** trigger は、判定を起こした部分(単純コマンド 1 つ)。コマンド全体と同じなら省く */
/** @typedef {{ timestamp: string, cwd: string, command: string, trigger?: string }} Example */
/**
 * @typedef {{
 *   files: number,
 *   calls: number,
 *   first: string | null,
 *   last: string | null,
 *   hook: { deny: number, ask: number, wrap: number, background: number, alreadyBackground: number, none: number },
 *   shim: { run: Record<string, number>, lock: number, pass: number },
 *   examples: { deny: Example[], wrap: Example[], background: Example[] },
 *   reruns: import('./reruns.mjs').Reruns,
 *   timing: import('./reruns.mjs').Timing,
 *   mishaps: import('./reruns.mjs').Mishaps
 * }} Report
 */

/**
 * 判定に使う環境。走らせている側の印(考える層・入れ子)を持ち込まない。git の鍵を取るか(SWITCHYARD_GIT)だけは利用者の設定に合わせる
 * @param {boolean} git @returns {NodeJS.ProcessEnv}
 */
const cleanEnv = (git) => (git ? { SWITCHYARD_GIT: '1' } : {});

/** 分類器が git-dir を読む代わり。記録の cwd で git を叩かない(鍵の名前は数えないので実パスは要らない) */
const NO_GIT = () => '<git-dir>';

/** 例に出すコマンドの長さの上限 */
const EXAMPLE_WIDTH = 120;

/**
 * セッション記録の 1 行から、assistant が Bash を呼んだ tool_use を取り出す。読めない行・他の行は空。
 * @param {string} line @returns {BashCall[]}
 */
export function bashCallsOf(line) {
  // 大きな記録を速く読むため、Bash の名前を含まない行は JSON として読まない
  if (!line.includes('"Bash"')) return [];
  /** @type {any} */
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof o !== 'object' || o === null || o.type !== 'assistant' || !Array.isArray(o.message?.content)) return [];
  const cwd = typeof o.cwd === 'string' ? o.cwd : '';
  const timestamp = typeof o.timestamp === 'string' ? o.timestamp : '';
  /** @type {BashCall[]} */
  const out = [];
  for (const b of o.message.content) {
    if (b?.type !== 'tool_use' || b.name !== 'Bash' || typeof b.input?.command !== 'string') continue;
    out.push({ id: typeof b.id === 'string' ? b.id : '', command: b.input.command, runInBackground: b.input.run_in_background === true, cwd, timestamp });
  }
  return out;
}

/** @param {Record<string, unknown> | null} out @returns {boolean} */
function denied(out) {
  const h = out === null ? undefined : /** @type {Record<string, unknown> | undefined} */ (out.hookSpecificOutput);
  return h?.permissionDecision === 'deny';
}

/** @param {Record<string, unknown> | null} out @returns {boolean} */
function asked(out) {
  const h = out === null ? undefined : /** @type {Record<string, unknown> | undefined} */ (out.hookSpecificOutput);
  return h?.permissionDecision === 'ask';
}

/** switchyard run -- で包む書き換えか @param {Record<string, unknown> | null} out @param {string} command @returns {boolean} */
function wrapped(out, command) {
  const h = out === null ? undefined : /** @type {{ updatedInput?: { command?: unknown } } | undefined} */ (out.hookSpecificOutput);
  return typeof h?.updatedInput?.command === 'string' && h.updatedInput.command !== command;
}

/**
 * 1 件を、PreToolUse と shim の分類器の実物で判定する。
 * @param {BashCall} call @param {{ profilesFor: (cwd: string) => NamedProfile[], git?: boolean }} opts @returns {Judgement}
 */
export function judgeCall(call, { profilesFor, git = false }) {
  const foreground = { tool_name: 'Bash', tool_input: { command: call.command }, cwd: call.cwd };
  const recorded = call.runInBackground ? { ...foreground, tool_input: { command: call.command, run_in_background: true } } : foreground;
  const opts = { env: cleanEnv(git), profilesFor };
  const out = preToolUse(recorded, opts);
  /** @type {HookVerdict} */
  let hook = 'none';
  if (denied(out)) hook = 'deny';
  else if (asked(out)) hook = 'ask';
  else if (wrapped(out, call.command)) hook = 'wrap';
  else if (out !== null) hook = 'background';
  else if (call.runInBackground) {
    // 既に背景なら hook は何も返さない。前景だったら書き換えたかで、重い走行かを見分ける
    const asForeground = preToolUse(foreground, opts);
    if (asForeground !== null && !denied(asForeground) && !asked(asForeground)) hook = 'already-background';
  }

  /** @type {Judgement['shims']} */
  const shims = [];
  for (const words of simpleCommands(call.command)) {
    const { head, rest } = headWord(words.join(' '));
    if (!SHIM_WORDS.includes(head)) continue;
    const a = decideShim({ word: head, args: rest, cwd: call.cwd, env: cleanEnv(git), gitDir: NO_GIT, profilesFor });
    shims.push({ word: head, answer: a.kind === 'run' ? `run ${a.profile}` : a.kind });
  }
  return { hook, shims };
}

/**
 * 記録の根の下の *.jsonl(メインのセッションとサブエージェント)を読み、判定を数える。
 * @param {{ dir: string, cwdPrefix: string | null, since: number | null, profilesFor: (cwd: string) => NamedProfile[], examples: number, git?: boolean }} opts
 * @returns {Promise<Report>}
 */
export async function replay({ dir, cwdPrefix, since, profilesFor, examples, git = false }) {
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.jsonl'))
    .sort()
    .map((p) => join(dir, p));
  /** @type {Report} */
  const report = {
    files: files.length,
    calls: 0,
    first: null,
    last: null,
    hook: { deny: 0, ask: 0, wrap: 0, background: 0, alreadyBackground: 0, none: 0 },
    shim: { run: {}, lock: 0, pass: 0 },
    examples: { deny: [], wrap: [], background: [] },
    reruns: emptyReruns(),
    timing: timingOf([], 0),
    mishaps: emptyMishaps(),
  };
  const mishapByCommand = { timeouts: new Map(), portInUse: new Map() };
  /** @type {import('./reruns.mjs').Interval[]} */
  const intervals = [];
  let backgroundRuns = 0;
  /** @type {Map<string, boolean>} 重い走行かの判定(同じコマンドを何度も判定しない) */
  const heavyCache = new Map();
  /** @param {{ command: string, cwd: string }} call */
  const isHeavy = (call) => {
    if (cwdPrefix !== null && !call.cwd.startsWith(cwdPrefix)) return false;
    const key = `${call.cwd}\u0000${call.command}`;
    let v = heavyCache.get(key);
    if (v === undefined) {
      // git の鍵だけのジョブは走り直しの対象にしない(CPU を持たない)
      const h = judgeCall({ id: '', command: call.command, runInBackground: false, cwd: call.cwd, timestamp: '' }, { profilesFor, git: false }).hook;
      v = h === 'background' || h === 'wrap' || h === 'deny';
      heavyCache.set(key, v);
    }
    return v;
  };
  /** @type {Map<string, { count: number, ms: number }>} */
  const rerunByCommand = new Map();
  /** @type {Set<string>} 走り直しの数え方で見た tool_use の id(再開したセッションが持ち越した行を 2 度数えない) */
  const stepSeen = new Set();
  /** @type {{ deny: Example[], wrap: Example[], background: Example[] }} */
  const all = { deny: [], wrap: [], background: [] };
  // 再開したセッションは前の行を持ち越すことがあるので、同じ tool_use の id は 1 回だけ数える
  /** @type {Set<string>} */
  const seen = new Set();

  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    /** @type {import('./reruns.mjs').Step[]} */
    const steps = [];
    /** @type {Set<string>} この記録で落とした(前の記録で見た)tool_use の id */
    const dropped = new Set();
    for await (const line of lines) {
      for (const st of stepsOf(line)) {
        if (st.kind === 'bash') {
          if (since !== null && !(st.at >= since)) continue;
          if (st.id !== '' && stepSeen.has(st.id)) {
            dropped.add(st.id);
            continue;
          }
          if (st.id !== '') stepSeen.add(st.id);
        } else if (st.kind === 'result' && dropped.has(st.id)) {
          continue;
        }
        steps.push(st);
      }
      for (const c of bashCallsOf(line)) {
        if (c.id !== '') {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
        }
        if (cwdPrefix !== null && !c.cwd.startsWith(cwdPrefix)) continue;
        if (since !== null && !(Date.parse(c.timestamp) >= since)) continue;

        const j = judgeCall(c, { profilesFor, git });
        report.calls += 1;
        if (report.first === null || c.timestamp < report.first) report.first = c.timestamp;
        if (report.last === null || c.timestamp > report.last) report.last = c.timestamp;
        /** @type {Example} */
        const example = { timestamp: c.timestamp, cwd: c.cwd, command: c.command };
        if (j.hook === 'deny' || j.hook === 'wrap' || j.hook === 'background') {
          // 長いコマンド(ヒアドキュメントで書いてから走らせる形など)は、先頭だけ見ても何が重いのか分からない。判定を起こした部分を添える
          const trigger = triggerOf(c, { profilesFor, git });
          if (trigger !== null && trigger !== c.command.trim()) example.trigger = trigger;
        }
        if (j.hook === 'deny') {
          report.hook.deny += 1;
          all.deny.push(example);
        } else if (j.hook === 'ask') {
          report.hook.ask += 1;
        } else if (j.hook === 'wrap') {
          report.hook.wrap += 1;
          all.wrap.push(example);
        } else if (j.hook === 'background') {
          report.hook.background += 1;
          all.background.push(example);
        } else if (j.hook === 'already-background') {
          report.hook.alreadyBackground += 1;
        } else {
          report.hook.none += 1;
        }
        for (const s of j.shims) {
          if (s.answer.startsWith('run ')) {
            const profile = s.answer.slice('run '.length);
            report.shim.run[profile] = (report.shim.run[profile] ?? 0) + 1;
          } else if (s.answer === 'lock') {
            report.shim.lock += 1;
          } else {
            report.shim.pass += 1;
          }
        }
      }
    }
    countSession(steps, isHeavy, report.reruns, rerunByCommand);
    // 時間切れ・ポートの失敗は、重い走行に限らずすべての Bash を見る(cwd の絞り込みだけは効かせる)
    countMishaps(cwdPrefix === null ? steps : steps.filter((st) => st.kind !== 'bash' || st.cwd.startsWith(cwdPrefix)), isHeavy, report.mishaps, mishapByCommand);
    const got = intervalsOf(steps, isHeavy, files.indexOf(file));
    for (const iv of got.intervals) intervals.push(iv);
    backgroundRuns += got.background;
  }
  report.timing = timingOf(intervals, backgroundRuns);
  report.reruns.top = [...rerunByCommand]
    .map(([key, v]) => ({ command: key.slice(key.indexOf('\u0000') + 1), count: v.count, ms: v.ms }))
    .sort((a, b) => b.count - a.count || b.ms - a.ms)
    .slice(0, examples);

  const topOf = (/** @type {Map<string, { count: number, ms: number }>} */ m) =>
    [...m]
      .map(([key, v]) => ({ command: key.slice(key.indexOf('\u0000') + 1), count: v.count, ms: v.ms }))
      .sort((a, b) => b.count - a.count || b.ms - a.ms)
      .slice(0, examples);
  report.mishaps.timeouts.top = topOf(mishapByCommand.timeouts);
  report.mishaps.portInUse.top = topOf(mishapByCommand.portInUse);

  const newest = (/** @type {Example[]} */ xs) => [...xs].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0)).slice(0, examples);
  report.examples = { deny: newest(all.deny), wrap: newest(all.wrap), background: newest(all.background) };
  return report;
}

/** 例に出すコマンド: 空白の並び(改行を含む)を 1 つにまとめ、長ければ切る @param {string} command @returns {string} */
/**
 * 判定を起こした部分: 単純コマンドを 1 つずつ判定し、最初に何かをする(拒否・背景)ものを返す。
 * @param {BashCall} call @param {{ profilesFor: (cwd: string) => NamedProfile[], git: boolean }} opts @returns {string | null}
 */
function triggerOf(call, opts) {
  for (const words of simpleCommands(call.command)) {
    const part = words.join(' ');
    if (judgeCall({ ...call, command: part, runInBackground: false }, opts).hook !== 'none') return part;
  }
  return null;
}

/** @param {string} command */
function oneLine(command) {
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat.length > EXAMPLE_WIDTH ? `${flat.slice(0, EXAMPLE_WIDTH)}…` : flat;
}

/**
 * 端末に出す文面。
 * @param {Report} r @param {{ cwdPrefix: string | null, sinceDays: number | null, examples: number }} filters @returns {string}
 */
export function formatReport(r, { cwdPrefix, sinceDays, examples }) {
  const sep = t('・', ', ');
  /** @type {string[]} */
  const lines = [];
  if (r.calls === 0 || r.first === null || r.last === null) {
    lines.push(t(`対象: 記録 ${r.files} 本・Bash の呼び出しは 0 件`, `Scope: ${r.files} logs, no Bash calls`));
  } else {
    const span = `${r.first.slice(0, 10)} 〜 ${r.last.slice(0, 10)}`;
    lines.push(t(`対象: 記録 ${r.files} 本・Bash の呼び出し ${r.calls} 件(${span})`, `Scope: ${r.files} logs, ${r.calls} Bash calls (${span})`));
  }
  /** @type {string[]} */
  const filtersText = [];
  if (cwdPrefix !== null) filtersText.push(t(`cwd が ${cwdPrefix} で始まる`, `cwd starts with ${cwdPrefix}`));
  if (sinceDays !== null) filtersText.push(t(`直近 ${sinceDays} 日`, `last ${sinceDays} days`));
  if (filtersText.length > 0) lines.push(t(`絞り込み: ${filtersText.join(sep)}`, `Filters: ${filtersText.join(sep)}`));

  if (r.calls > 0) {
    const pct = (/** @type {number} */ n) => ((n / r.calls) * 100).toFixed(1);
    const share = (/** @type {number} */ n) => t(`${n} 件(${pct(n)}%)`, `${n} (${pct(n)}%)`);
    lines.push('PreToolUse');
    lines.push(t(`  拒否: ${share(r.hook.deny)}`, `  refused: ${share(r.hook.deny)}`));
    lines.push(t(`  switchyard run の中身に承認を求める: ${share(r.hook.ask)}`, `  asked to approve what switchyard run wraps: ${share(r.hook.ask)}`));
    lines.push(t(`  switchyard run で包む: ${share(r.hook.wrap)}`, `  wrapped in switchyard run: ${share(r.hook.wrap)}`));
    lines.push(t(`  背景へ書き換え: ${share(r.hook.background)}`, `  sent to background: ${share(r.hook.background)}`));
    lines.push(t(`  既に背景の重い走行: ${share(r.hook.alreadyBackground)}`, `  heavy and already in background: ${share(r.hook.alreadyBackground)}`));
    lines.push(t(`  何もしない: ${share(r.hook.none)}`, `  nothing to do: ${share(r.hook.none)}`));

    const runs = Object.entries(r.shim.run).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const runTotal = runs.reduce((n, [, k]) => n + k, 0);
    const byProfile = runs.length > 0 ? t(`(${runs.map(([p, k]) => `${p} ${k}`).join('・')})`, ` (${runs.map(([p, k]) => `${p} ${k}`).join(', ')})`) : '';
    const words = runTotal + r.shim.lock + r.shim.pass;
    lines.push(t(`shim(shim の語で始まる単純コマンド ${words} 件)`, `shim (${words} simple commands starting with a shimmed word)`));
    lines.push(t(`  包む: ${runTotal} 件${byProfile}`, `  wrapped: ${runTotal}${byProfile}`));
    lines.push(t(`  鍵だけ: ${r.shim.lock} 件`, `  locks only: ${r.shim.lock}`));
    lines.push(t(`  素通し: ${r.shim.pass} 件`, `  passed through: ${r.shim.pass}`));
    const rr = r.reruns;
    if (rr.runs > 0) {
      const rp = (/** @type {number} */ n) => ((n / rr.runs) * 100).toFixed(1);
      lines.push(t(`同じ状態での走り直し(重い走行 ${rr.runs} 件のうち。間にファイルを書き換えずに、同じ場所で同じコマンドをもう一度)`, `Re-runs with nothing changed (of ${rr.runs} heavy runs: the same command in the same place again, with no file edits in between)`));
      lines.push(t(`  厳しめ: ${rr.strict.count} 件(${rp(rr.strict.count)}%)・前景の所要の合計 ${duration(rr.strict.ms)}`, `  strict: ${rr.strict.count} (${rp(rr.strict.count)}%), ${duration(rr.strict.ms)} in the foreground`));
      lines.push(t(`  緩め(Bash での書き換えは見ない): ${rr.loose.count} 件(${rp(rr.loose.count)}%)・${duration(rr.loose.ms)}`, `  loose (ignoring edits made through Bash): ${rr.loose.count} (${rp(rr.loose.count)}%), ${duration(rr.loose.ms)}`));
      lines.push(t(`  うち失敗の直後の走り直し: ${rr.afterFailure} 件`, `  of which right after a failure: ${rr.afterFailure}`));
      for (const x of rr.top) lines.push(t(`    ${x.count} 回・${duration(x.ms)}  ${oneLine(maskSecrets(x.command))}`, `    ${x.count}x, ${duration(x.ms)}  ${oneLine(maskSecrets(x.command))}`));
    }
    const tm = r.timing;
    if (tm.runs > 0) {
      const tp = (/** @type {number} */ n) => ((n / tm.runs) * 100).toFixed(1);
      const mp = (/** @type {number} */ n) => (tm.totalMs === 0 ? '0.0' : ((n / tm.totalMs) * 100).toFixed(1));
      lines.push(t(`重い走行の時間(前景で結果を待った ${tm.runs} 本。背景の ${tm.background} 本は終わりが分からないので除く)`, `Heavy-run time (${tm.runs} runs whose result was waited for in the foreground; ${tm.background} background runs left out, their end is unknown)`));
      lines.push(t(`  1 本の所要: 中央 ${duration(tm.medianMs)}・90% は ${duration(tm.p90Ms)} 以下・10 秒未満 ${tp(tm.under10s)}%・1 分未満 ${tp(tm.under60s)}%`, `  per run: median ${duration(tm.medianMs)}, 90% within ${duration(tm.p90Ms)}, under 10 s ${tp(tm.under10s)}%, under 1 min ${tp(tm.under60s)}%`));
      lines.push(t(`  Claude が結果を待った時間の合計: ${duration(tm.totalMs)}`, `  total time Claude waited for results: ${duration(tm.totalMs)}`));
      lines.push(t(`  セッションをまたいだ重なり: 他と重なった走行 ${tm.overlappedRuns} 本(${tp(tm.overlappedRuns)}%)・2 本以上が同時に走っていた時間 ${duration(tm.overlapMs)}(待った時間の合計の ${mp(tm.overlapMs)}%)・最大同時 ${tm.maxConcurrent} 本`, `  overlap across sessions: ${tm.overlappedRuns} runs overlapped another (${tp(tm.overlappedRuns)}%); 2 or more ran at once for ${duration(tm.overlapMs)} (${mp(tm.overlapMs)}% of the total wait); at most ${tm.maxConcurrent} at once`));
    }
    const mt = r.mishaps.timeouts;
    lines.push(
      t(
        `Bash の時間切れ: ${mt.count} 件(うち重い走行 ${mt.heavy} 件・既定の時間切れ ${mt.atDefault} 件)・切れるまで待った時間の合計 ${duration(mt.ms)}`,
        `Bash timeouts: ${mt.count} (${mt.heavy} heavy runs, ${mt.atDefault} at the default limit), ${duration(mt.ms)} waited before the cut`,
      ),
    );
    if (mt.count > 0) {
      lines.push(t(`  その後に同じコマンドを走り直した: ${mt.rerun} 件(うち背景で ${mt.rerunBackground} 件)`, `  the same command was run again afterwards: ${mt.rerun} (${mt.rerunBackground} in the background)`));
      for (const x of mt.top) lines.push(t(`    ${x.count} 回・${duration(x.ms)}  ${oneLine(maskSecrets(x.command))}`, `    ${x.count}x, ${duration(x.ms)}  ${oneLine(maskSecrets(x.command))}`));
    }
    const mp2 = r.mishaps.portInUse;
    lines.push(t(`ポートが使用中で落ちた Bash: ${mp2.count} 件(うち重い走行 ${mp2.heavy} 件)`, `Bash calls that failed on a port already in use: ${mp2.count} (${mp2.heavy} heavy runs)`));
    for (const x of mp2.top) lines.push(t(`    ${x.count} 回  ${oneLine(maskSecrets(x.command))}`, `    ${x.count}x  ${oneLine(maskSecrets(x.command))}`));

    for (const [label, xs] of /** @type {Array<[string, Example[]]>} */ ([
      [t('拒否', 'Refused'), r.examples.deny],
      [t('switchyard run で包む', 'Wrapped in switchyard run'), r.examples.wrap],
      [t('背景へ書き換え', 'Sent to background'), r.examples.background],
    ])) {
      if (xs.length === 0) continue;
      lines.push(t(`${label}の例(新しい順に最大 ${examples} 件)`, `${label}: examples (newest first, up to ${examples})`));
      for (const x of xs) {
        lines.push(`  ${x.timestamp.slice(0, 16).replace('T', ' ')}  ${x.cwd}  ${oneLine(maskSecrets(x.command))}`);
        if (x.trigger !== undefined) lines.push(t(`      → 判定した部分: ${oneLine(maskSecrets(x.trigger))}`, `      → the part that triggered it: ${oneLine(maskSecrets(x.trigger))}`));
      }
    }
  }
  lines.push(
    t(
      '注: 時刻は記録のまま(UTC)。shim の欄は、パスで呼んだ node のスクリプトと bash -c の引用の中を数えない近似',
      'Note: times are as logged (UTC). The shim counts are approximate: node scripts called by path and the inside of bash -c quotes are not counted',
    ),
  );
  return `${lines.join('\n')}\n`;
}
