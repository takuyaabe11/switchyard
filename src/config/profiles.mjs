// @ts-check
// コマンドの分類。プロジェクト設定 switchyard.json と組み込みの既定表(設計 §4.5 / §9.2)。
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/** @typedef {import('../core/types.mjs').JobClass} JobClass */
/** @typedef {import('../core/types.mjs').CpuRange} CpuRange */
/** @typedef {import('../core/types.mjs').Preempt} Preempt */

/**
 * @typedef {{
 *   match: string[],
 *   class: JobClass,
 *   cpus?: CpuRange,
 *   locks?: string[],
 *   env?: Record<string, string>,
 *   args?: string[],
 *   preempt?: Preempt
 * }} Profile
 */
/** @typedef {{ name: string, profile: Profile }} NamedProfile */

/**
 * 走らせずに調べるだけの旗。この旗を持つ部分は、どの profile にも当てない(改善 3)。
 * 値を取らない旗だけを置く — 値を取る旗をここに入れると、その後ろの語ごと見送られる。
 */
export const INSPECT_FLAGS = ['--version', '--help', '--list', '--dry-run'];
/**
 * 1 文字の短い旗は、他の意味で使われることがある(`pytest -n 4` は並列数、`make -n` は空走)。
 * 末尾に置かれたときだけ「調べるだけ」とみなす。値を取る形(`-n 4`)はここに当たらない。
 */
export const INSPECT_FLAGS_TRAILING = ['-V', '-h', '-n'];

/**
 * その部分が「走らせずに調べるだけ」か(`make --version`・`npx playwright test --list --reporter=json`)。
 * 当たれば分類しない = 包まないし、背景へも回さない。重くする方へは働かないので、
 * プロジェクトの設定より前に効いても、待たせるべきものを取り逃がさない。
 * @param {string} segment 空白で整えた単純コマンド @returns {boolean}
 */
export function isInspect(segment) {
  const words = segment.split(' ');
  if (words.some((w) => INSPECT_FLAGS.includes(w))) return true;
  return INSPECT_FLAGS_TRAILING.includes(words[words.length - 1]);
}

/**
 * 組み込みの既定表。プロジェクト設定の後ろに並ぶので、同じコマンドにはプロジェクト側が先に当たる。
 * measure(他の CPU ジョブを全部待たせる計測)は持たない。計測はプロジェクトの設定か --class measure だけが決める(改善 2・設計 §9.3)。
 * 以前の `*bench*` / `*measure*` はコマンドの全文に当たり、IRC の記録で measure の包み 1,383 件のうち本物の計測は約 160 件だった。
 *
 * 語の途中に当てない(改善 3): `make*` は `makeinfo` に、`pytest*` は `pytest-watch` に当たっていた。
 * 語そのものと「語 + 空白 + 何か」の 2 つに割る。`npm run build*` や `cargo build*` は、
 * `build:prod` / `build --release` のような続きに当てるのが狙いなので、そのまま残す。
 *
 * どの glob も語で始まる(`*` で始まらない)。shim の sh のふるい(shims/_shim.sh)が、
 * 先頭の語だけを見て「既定表には当たりえない」と判断できるのは、この性質に頼っている。
 * @type {NamedProfile[]}
 */
export const DEFAULT_PROFILES = [
  {
    name: 'default:batch',
    profile: {
      match: [
        'npm test', 'npm test *',
        'npm run build*',
        'npx vitest run*',
        'npx playwright test*',
        'cargo build*', 'cargo test*',
        'pytest', 'pytest *',
        'go test*',
        'make', 'make *',
      ],
      class: 'batch',
      cpus: { min: 2, max: 4 },
    },
  },
];

/** 既定表の glob が始まる語(shim の sh のふるいが使う)。@returns {string[]} */
export function defaultHeadWords() {
  /** @type {Set<string>} */
  const words = new Set();
  for (const np of DEFAULT_PROFILES) {
    for (const g of np.profile.match) {
      const head = g.split(' ')[0];
      const cut = head.search(/[*?]/);
      if (cut === 0) throw new Error(`既定表の glob が語で始まっていない: ${g}`);
      words.add(cut < 0 ? head : head.slice(0, cut));
    }
  }
  return [...words].sort();
}

/** node の、インラインのコードを値に取るオプション */
const NODE_INLINE = new Set(['-e', '--eval', '-p', '--print']);

/**
 * 分類に渡す文字列。語を空白でつなぐが、node の -e / --eval / -p / --print の値(インラインのコード)は除く(改善 2)。
 * コードの中身の単語(benchmarks・vitest run など)に glob が当たると、読むだけのその場のスクリプトが重い走行に分類されるため。
 * 除くのはスクリプトの前のオプションだけ(スクリプトの後ろの -e はスクリプトの引数)。
 * @param {string[]} words 先頭の語とその引数 @returns {string}
 */
export function classifiableCommand(words) {
  if (words.length === 0 || basename(words[0]) !== 'node') return words.join(' ');
  const out = [words[0]];
  let script = false;
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i];
    if (!script) {
      const eq = w.indexOf('=');
      if (w.startsWith('--') && eq > 0 && NODE_INLINE.has(w.slice(0, eq))) {
        out.push(w.slice(0, eq));
        continue;
      }
      if (NODE_INLINE.has(w)) {
        out.push(w);
        i += 1;
        continue;
      }
      if (!w.startsWith('-')) script = true;
    }
    out.push(w);
  }
  return out.join(' ');
}

const CLASSES = ['quick', 'batch', 'measure'];
const PREEMPTS = ['pause', 'throttle', 'never'];
/** @type {Record<JobClass, number>} */
const WEIGHT = { quick: 0, batch: 1, measure: 2 };

/**
 * `*` は任意の文字列、`?` は任意の 1 文字、それ以外は文字どおり。全体一致。
 * @param {string} glob @param {string} text @returns {boolean}
 */
export function globMatch(glob, text) {
  let g = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (g < glob.length && glob[g] === '*') {
      star = g;
      g += 1;
      mark = t;
    } else if (g < glob.length && (glob[g] === '?' || glob[g] === text[t])) {
      g += 1;
      t += 1;
    } else if (star !== -1) {
      g = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') g += 1;
  return g === glob.length;
}

/**
 * Bash のコマンドを `&&` / `||` / `;` / `|` で区切る。引用符の中も区切る(単純化)。
 * 各部分は前後の空白を除き、連続する空白を 1 つにする。
 * @param {string} command @returns {string[]}
 */
export function segments(command) {
  /** @type {string[]} */
  const out = [];
  let cur = '';
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    const n = command[i + 1];
    if ((c === '&' && n === '&') || (c === '|' && n === '|')) {
      out.push(cur);
      cur = '';
      i += 1;
    } else if (c === ';' || c === '|') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.split(' ').filter((w) => w !== '').join(' ')).filter((s) => s !== '');
}

/**
 * 部分ごとに、並び順で最初に当たった profile を採る(プロジェクト設定が既定表より先)。
 * 部分をまたいでは、measure > batch > quick の重い方を採る。同じ重さなら先の部分。
 * @param {string} command @param {NamedProfile[]} profiles @returns {NamedProfile | null}
 */
export function classify(command, profiles) {
  /** @type {NamedProfile | null} */
  let best = null;
  for (const seg of segments(command)) {
    // 走らせずに調べるだけの部分は、どの profile にも当てない(`make --version` を順番待ちに乗せない)
    if (isInspect(seg)) continue;
    const hit = profiles.find((np) => np.profile.match.some((g) => globMatch(g, seg)));
    if (hit === undefined) continue;
    if (best === null || WEIGHT[hit.profile.class] > WEIGHT[best.profile.class]) best = hit;
  }
  return best;
}

/**
 * @param {string} name @param {unknown} raw @returns {Profile}
 */
export function validateProfile(name, raw) {
  const fail = (/** @type {string} */ msg) => new Error(`profile ${name}: ${msg}`);
  if (typeof raw !== 'object' || raw === null) throw fail('オブジェクトではない');
  const p = /** @type {Record<string, unknown>} */ (raw);
  const isStrings = (/** @type {unknown} */ v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!isStrings(p.match) || /** @type {string[]} */ (p.match).length === 0) throw fail('match は 1 つ以上の文字列の配列');
  if (typeof p.class !== 'string' || !CLASSES.includes(p.class)) throw fail('class は quick / batch / measure');
  /** @type {Profile} */
  const out = { match: /** @type {string[]} */ (p.match), class: /** @type {JobClass} */ (p.class) };
  if (p.cpus !== undefined) {
    const c = /** @type {Record<string, unknown>} */ (p.cpus);
    const ok = typeof c === 'object' && c !== null && Number.isInteger(c.min) && Number.isInteger(c.max) && Number(c.min) >= 1 && Number(c.max) >= Number(c.min);
    if (!ok) throw fail('cpus は { min: 1 以上の整数, max: min 以上の整数 }');
    out.cpus = { min: Number(c.min), max: Number(c.max) };
  }
  if (p.locks !== undefined) {
    if (!isStrings(p.locks)) throw fail('locks は文字列の配列');
    out.locks = /** @type {string[]} */ (p.locks);
  }
  if (p.env !== undefined) {
    const e = p.env;
    if (typeof e !== 'object' || e === null || Array.isArray(e) || !Object.values(e).every((v) => typeof v === 'string')) throw fail('env は文字列の値を持つオブジェクト');
    out.env = /** @type {Record<string, string>} */ (e);
  }
  if (p.args !== undefined) {
    if (!isStrings(p.args)) throw fail('args は文字列の配列');
    out.args = /** @type {string[]} */ (p.args);
  }
  if (p.preempt !== undefined) {
    if (typeof p.preempt !== 'string' || !PREEMPTS.includes(p.preempt)) throw fail('preempt は pause / throttle / never');
    out.preempt = /** @type {Preempt} */ (p.preempt);
  }
  return out;
}

/** 改名の前の設定ファイルの名前(switchyard は conductor から改名した) */
export const LEGACY_CONFIG = 'conductor.json';

/**
 * repo 直下の switchyard.json を読み、プロジェクトの profile を既定表の前に並べる。
 * 読めない・形が違うときは既定表だけを返し、理由を error に入れる(黙って無視しない)。
 *
 * switchyard.json が無く、改名の前の conductor.json があれば、そちらを読んで notice を付ける。
 * 付けないと、改名の日から repo の設定が黙って効かなくなる — 実測: 10 個の profile を持つ repo が
 * 既定表だけで走り、e2e と計測の宣言が消えて機械が詰まった(2026-09-16)。
 * @param {string} repoRoot @returns {{ profiles: NamedProfile[], error: string | null, notice?: string }}
 */
export function loadProfiles(repoRoot) {
  const file = join(repoRoot, 'switchyard.json');
  if (existsSync(file)) return loadProfilesFile(file);
  const legacy = join(repoRoot, LEGACY_CONFIG);
  if (!existsSync(legacy)) return { profiles: DEFAULT_PROFILES, error: null };
  return { ...loadProfilesFile(legacy), notice: `${legacy} を読んだ(switchyard は conductor から改名した)。switchyard.json へ改名すると、この知らせは消える` };
}

/**
 * 設定ファイル 1 つを読む(switchyard replay の --config は repo の外のファイルも渡せる)。無ければ既定表だけ。
 * @param {string} file @returns {{ profiles: NamedProfile[], error: string | null }}
 */
export function loadProfilesFile(file) {
  if (!existsSync(file)) return { profiles: DEFAULT_PROFILES, error: null };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const table = typeof raw === 'object' && raw !== null ? raw.profiles ?? {} : {};
    const own = Object.entries(table).map(([name, p]) => ({ name, profile: validateProfile(name, p) }));
    return { profiles: [...own, ...DEFAULT_PROFILES], error: null };
  } catch (e) {
    return { profiles: DEFAULT_PROFILES, error: `switchyard.json を読めない: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * 雛形 `{cpus}` を割り振られたコア数に置き換える。
 * @param {Profile} profile @param {number} cpus @returns {{ env: Record<string, string>, args: string[] }}
 */
export function applyTemplate(profile, cpus) {
  const fill = (/** @type {string} */ s) => s.split('{cpus}').join(String(cpus));
  const env = Object.fromEntries(Object.entries(profile.env ?? {}).map(([k, v]) => [k, fill(v)]));
  return { env, args: (profile.args ?? []).map(fill) };
}
