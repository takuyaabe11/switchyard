// @ts-check
// コマンドの分類。プロジェクト設定 switchyard.json と組み込みの既定表(設計 §4.5 / §9.2)。
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { t } from '../i18n.mjs';

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
 * cpus の max に書ける「容量いっぱい」(switchyard.json では "all")。デーモンが容量に切り詰める。
 * 割り当てたコア数を並列度として道具に渡すので(src/config/threads.mjs)、上限を小さく決め打つと、
 * 他に誰も走っていない大きな機械でも、その数のスレッドに縛られる。
 */
export const ALL_CPUS = 65_536;

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
 * 終わらずに見張り続ける旗(watch モード)。この旗を持つ部分は分類しない。
 * 包むと、終わらない走行が CPU の取り分を握り続け、他のセッションの走行が永久に待つ。
 */
export const WATCH_FLAGS = ['--watch', '--watchAll'];

/**
 * その部分が見張り続ける(watch モードの)走行か。`tsc -w` は tsc のときだけ(`make -w` は別の意味)。
 * @param {string} segment 空白で整えた単純コマンド @returns {boolean}
 */
export function isWatch(segment) {
  const words = segment.split(' ');
  if (words.some((w) => WATCH_FLAGS.includes(w) || w.startsWith('--watch='))) return true;
  return words.includes('-w') && (words[0] === 'tsc' || (words[0] === 'npx' && words[1] === 'tsc'));
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
        'npm test', 'npm test *', 'npm t', 'npm t *', 'npm run test*',
        'npm run build*',
        'npx vitest run*',
        'npx jest*',
        'npx playwright test*',
        'yarn test*', 'yarn run test*', 'yarn build*', 'yarn run build*',
        'pnpm test*', 'pnpm run test*', 'pnpm build*', 'pnpm run build*',
        'bun test*', 'bun run test*', 'bun run build*',
        'cargo build*', 'cargo test*', 'cargo nextest*', 'cargo clippy*', 'cargo check*',
        'pytest', 'pytest *',
        'python -m pytest*', 'python3 -m pytest*', 'uv run pytest*', 'uv run python -m pytest*', 'poetry run pytest*',
        'go test*', 'go build*',
        'mvn test*', 'mvn verify*', 'mvn package*', 'mvn install*', 'mvn clean test*', 'mvn clean verify*', 'mvn clean package*', 'mvn clean install*',
        'gradle test*', 'gradle build*', 'gradle check*',
        'dotnet test*', 'dotnet build*',
        'bundle exec rspec*', 'rspec', 'rspec *',
        'deno test*',
        'npx tsc', 'npx tsc *',
        'make', 'make *',
        // Xcode: 動作(test・build など)は引数の後ろに来ることが多い
        'xcodebuild test', 'xcodebuild test *', 'xcodebuild * test', 'xcodebuild * test *',
        'xcodebuild build', 'xcodebuild build *', 'xcodebuild * build', 'xcodebuild * build *',
        'xcodebuild test-without-building*', 'xcodebuild * test-without-building*',
        'xcodebuild build-for-testing*', 'xcodebuild * build-for-testing*',
        'bazel test*', 'bazel build*', 'bazel coverage*', 'bazelisk test*', 'bazelisk build*', 'bazelisk coverage*',
        // monorepo のタスク実行器(serve・dev のような見張り続ける形は当てない)
        'nx test*', 'nx build*', 'nx run-many*', 'nx affected*', 'nx run *:test*', 'nx run *:build*',
        'npx nx test*', 'npx nx build*', 'npx nx run-many*', 'npx nx affected*',
        'pnpm nx test*', 'pnpm nx build*', 'pnpm nx run-many*', 'pnpm nx affected*',
        'yarn nx test*', 'yarn nx build*', 'yarn nx run-many*', 'yarn nx affected*',
        'turbo run test*', 'turbo run build*', 'turbo test*', 'turbo build*',
        'npx turbo run test*', 'npx turbo run build*', 'npx turbo test*', 'npx turbo build*',
        'pnpm turbo run test*', 'pnpm turbo run build*', 'pnpm turbo test*', 'pnpm turbo build*',
        // PHP: vendor/bin の実行ファイル(vendor/bin/phpunit・php vendor/bin/pest)は、呼んだ道具の名前の形で分類する(classifiableCommand)
        'php artisan test', 'php artisan test *',
        'phpunit', 'phpunit *', 'pest', 'pest *', 'paratest', 'paratest *',
        'composer test', 'composer test *', 'composer run test*', 'composer run-script test*',
      ],
      class: 'batch',
      cpus: { min: 2, max: ALL_CPUS },
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

/** node_modules/.bin の下の実行ファイルのパスか(語そのものではなくパスで呼んだ形だけ) @param {string} w */
const isLocalBin = (w) => /(^|\/)node_modules\/\.bin\/[^/]+$/.test(w);

/** composer が入れた vendor/bin の下の実行ファイルのパスか @param {string} w */
const isVendorBin = (w) => /(^|\/)vendor\/bin\/[^/]+$/.test(w);

/** php の、値を次の語に取るオプション(-d memory_limit=-1・-c php.ini・-z ext) */
const PHP_VALUE_OPTIONS = new Set(['-d', '-c', '-z']);

/**
 * php が走らせるスクリプトの位置(`-f` の値か、オプションの後の最初の語)。インラインのコード(-r・-B・-R・-E)なら -1。
 * @param {string[]} words @returns {number}
 */
function phpScriptAt(words) {
  for (let i = 1; i < words.length; i += 1) {
    const w = words[i];
    if (w === '-f') return i + 1 < words.length ? i + 1 : -1;
    if (PHP_VALUE_OPTIONS.has(w)) {
      i += 1;
      continue;
    }
    if (w === '--') return i + 1 < words.length ? i + 1 : -1;
    if (/^-[rBRE]/.test(w)) return -1;
    if (!w.startsWith('-')) return i;
  }
  return -1;
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
  if (words.length === 0) return '';
  // node_modules/.bin の実行ファイルを直に呼ぶ形(./node_modules/.bin/vitest run)は npx と同じ走行なので、npx の形で分類する
  if (isLocalBin(words[0])) return ['npx', basename(words[0]), ...words.slice(1)].join(' ');
  // vendor/bin の実行ファイル(vendor/bin/phpunit)は道具の名前の形(phpunit …)。
  // `#!/usr/bin/env php` の shebang で起動した形(php vendor/bin/phpunit …)も、オプションを読み飛ばして同じ形にする
  if (isVendorBin(words[0])) return [basename(words[0]), ...words.slice(1)].join(' ');
  if (basename(words[0]) === 'php') {
    const script = phpScriptAt(words);
    if (script > 0 && isVendorBin(words[script])) return [basename(words[script]), ...words.slice(script + 1)].join(' ');
  }
  if (basename(words[0]) !== 'node') return words.join(' ');
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
      if (!w.startsWith('-')) {
        script = true;
        // `#!/usr/bin/env node` の shebang で起動した node_modules/.bin のスクリプト(node …/.bin/vitest run)も npx の形にする
        if (isLocalBin(w)) return ['npx', basename(w), ...words.slice(i + 1)].join(' ');
      }
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
    // 見張り続ける走行も当てない(終わらないまま CPU の取り分を握り続ける)
    if (isWatch(seg)) continue;
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
  if (typeof raw !== 'object' || raw === null) throw fail(t('オブジェクトではない', 'is not an object'));
  const p = /** @type {Record<string, unknown>} */ (raw);
  const isStrings = (/** @type {unknown} */ v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!isStrings(p.match) || /** @type {string[]} */ (p.match).length === 0) throw fail(t('match は 1 つ以上の文字列の配列', 'match must be an array of one or more strings'));
  if (typeof p.class !== 'string' || !CLASSES.includes(p.class)) throw fail(t('class は quick / batch / measure', 'class must be quick / batch / measure'));
  /** @type {Profile} */
  const out = { match: /** @type {string[]} */ (p.match), class: /** @type {JobClass} */ (p.class) };
  if (p.cpus !== undefined) {
    const c = /** @type {Record<string, unknown>} */ (p.cpus);
    const max = typeof c === 'object' && c !== null && c.max === 'all' ? ALL_CPUS : c?.max;
    const ok = typeof c === 'object' && c !== null && Number.isInteger(c.min) && Number.isInteger(max) && Number(c.min) >= 1 && Number(max) >= Number(c.min);
    if (!ok) throw fail(t('cpus は { min: 1 以上の整数, max: min 以上の整数か "all" }', 'cpus must be { min: integer >= 1, max: integer >= min or "all" }'));
    out.cpus = { min: Number(c.min), max: Number(max) };
  }
  if (p.locks !== undefined) {
    if (!isStrings(p.locks)) throw fail(t('locks は文字列の配列', 'locks must be an array of strings'));
    out.locks = /** @type {string[]} */ (p.locks);
  }
  if (p.env !== undefined) {
    const e = p.env;
    if (typeof e !== 'object' || e === null || Array.isArray(e) || !Object.values(e).every((v) => typeof v === 'string')) throw fail(t('env は文字列の値を持つオブジェクト', 'env must be an object with string values'));
    out.env = /** @type {Record<string, string>} */ (e);
  }
  if (p.args !== undefined) {
    if (!isStrings(p.args)) throw fail(t('args は文字列の配列', 'args must be an array of strings'));
    out.args = /** @type {string[]} */ (p.args);
  }
  if (p.preempt !== undefined) {
    if (typeof p.preempt !== 'string' || !PREEMPTS.includes(p.preempt)) throw fail(t('preempt は pause / throttle / never', 'preempt must be pause / throttle / never'));
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
  return { ...loadProfilesFile(legacy), notice: t(
      `${legacy} を読んだ(switchyard は conductor から改名した)。switchyard.json へ改名すると、この知らせは消える`,
      `read ${legacy} (switchyard was renamed from conductor); rename it to switchyard.json to silence this notice`,
    ),
  };
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
    return { profiles: DEFAULT_PROFILES, error: t(`switchyard.json を読めない: ${e instanceof Error ? e.message : String(e)}`, `cannot read switchyard.json: ${e instanceof Error ? e.message : String(e)}`) };
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
