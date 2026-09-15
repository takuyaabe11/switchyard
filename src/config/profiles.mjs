// @ts-check
// コマンドの分類。プロジェクト設定 conductor.json と組み込みの既定表(設計 §4.5 / §9.2)。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * 組み込みの既定表。プロジェクト設定の後ろに並ぶので、同じコマンドにはプロジェクト側が先に当たる。
 * @type {NamedProfile[]}
 */
export const DEFAULT_PROFILES = [
  { name: 'default:measure', profile: { match: ['*bench*', '*measure*'], class: 'measure', cpus: { min: 1, max: 1000 } } },
  {
    name: 'default:batch',
    profile: {
      match: ['npm test*', 'npm run build*', 'npx vitest run*', 'npx playwright test*', 'cargo build*', 'cargo test*', 'pytest*', 'go test*', 'make*'],
      class: 'batch',
      cpus: { min: 2, max: 4 },
    },
  },
];

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

/**
 * repo 直下の conductor.json を読み、プロジェクトの profile を既定表の前に並べる。
 * 読めない・形が違うときは既定表だけを返し、理由を error に入れる(黙って無視しない)。
 * @param {string} repoRoot @returns {{ profiles: NamedProfile[], error: string | null }}
 */
export function loadProfiles(repoRoot) {
  const file = join(repoRoot, 'conductor.json');
  if (!existsSync(file)) return { profiles: DEFAULT_PROFILES, error: null };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const table = typeof raw === 'object' && raw !== null ? raw.profiles ?? {} : {};
    const own = Object.entries(table).map(([name, p]) => ({ name, profile: validateProfile(name, p) }));
    return { profiles: [...own, ...DEFAULT_PROFILES], error: null };
  } catch (e) {
    return { profiles: DEFAULT_PROFILES, error: `conductor.json を読めない: ${e instanceof Error ? e.message : String(e)}` };
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
