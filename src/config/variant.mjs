// @ts-check
// 既定の表の走行を学ぶ単位。既定の表(default:batch など)は、npm test・npm run build・cargo test・pytest tests/one.py のような
// 所要も使い方も違う走行を 1 つの profile に集めるので、profile の名前だけで学ぶと、見込み(所要・CPU・メモリ・重なりの遅れ)が混ざる。
// そこで、道具とサブコマンド(最大 3 語)と、対象を絞っているか(ファイル・テストの名前・絞り込みのオプション)で分ける。
// switchyard.json の profile は、書いた人が単位を決めているので分けない。
import { basename } from 'node:path';
import { maskSecrets } from '../redact.mjs';

/** 既定の表の profile の名前の頭 */
const DEFAULT_PREFIX = 'default:';

/** 道具とサブコマンドとして数える語(英字で始まり、英数字・_・-・: だけ。build:prod は数え、Rust のテストのパス a::b は数えない) */
const NAME = /^[A-Za-z](?:[\w-]|:(?!:))*$/;

/**
 * 走らせるテストを絞るオプション(値を = で付けた形も含む)。道具によって意味の違う短いオプション(-p・-m など)は入れない
 * (tsc -p は設定ファイル、cargo -p はパッケージ)。
 */
const FILTER_OPTIONS = new Set(['-k', '-t', '-g', '-run', '-Dtest', '--grep', '--testNamePattern', '--testPathPattern', '--filter', '--tests', '--test', '--spec']);

/** 全体を指す位置引数(go test ./...・mvn .) */
const WHOLE = new Set(['.', './...', '...']);

/**
 * 走行の単位(道具とサブコマンド。対象を絞っていれば後ろに「 …」)。
 * 例: `npm test` → `npm test`、`npm test -- -t login` → `npm test …`、`pytest tests/a.py -x` → `pytest …`、
 * `npm run build:prod` → `npm run build:prod`、`/usr/bin/cargo test -p core` → `cargo test`(-p は絞り込みに数えない)。
 * @param {string} command 分類にかけた形(classifiableCommand) @returns {string}
 */
export function variantOf(command) {
  const words = command.split(' ').filter((w) => w !== '');
  if (words.length === 0) return '';
  const base = [basename(words[0])];
  let partial = false;
  let optionSeen = false;
  // python -m <モジュール> は、モジュールまでを道具とみなす(python3 -m pytest → python3 -m pytest)
  let moduleNext = false;
  for (const w of words.slice(1)) {
    if (moduleNext) {
      moduleNext = false;
      base.push(w);
      continue;
    }
    if (w === '--') continue;
    if (w === '-m' && base.length === 1 && /^python[\d.]*$/.test(base[0])) {
      base.push(w);
      moduleNext = true;
      continue;
    }
    if (w.startsWith('-')) {
      optionSeen = true;
      if (FILTER_OPTIONS.has(w.split('=')[0])) partial = true;
      continue;
    }
    // オプションより前の名前の語だけを、道具とサブコマンドとして数える(オプションの値を取り違えない)
    if (!optionSeen && !partial && base.length < 3 && NAME.test(w)) {
      base.push(w);
      continue;
    }
    // パス・ファイル・テストの id(a/b・x.py・a::b)は対象を絞っている
    if (!WHOLE.has(w) && (w.includes('/') || w.includes('::') || /\.\w+$/.test(w))) partial = true;
  }
  return `${base.join(' ')}${partial ? ' …' : ''}`;
}

/**
 * 学ぶ単位にした profile の名前。既定の表の profile なら、名前の後ろに走行の単位を付ける(`default:batch npm test`)。
 * それ以外(switchyard.json の profile・cmd:…)はそのまま。
 * @param {string} name profile の名前 @param {string} command 分類にかけた形 @returns {string}
 */
export function learnedName(name, command) {
  if (!name.startsWith(DEFAULT_PREFIX) || name.includes(' ')) return name;
  // 名前は記録と盤面に残るので、秘密らしい値は隠してから単位を取る(PreToolUse と switchyard run で同じ計算)
  const v = variantOf(maskSecrets(command));
  return v === '' ? name : `${name} ${v}`;
}

/** 学ぶ単位の名前から、profile の名前(表で引ける名前)を取る @param {string} name @returns {string} */
export const profileNameOf = (name) => (name.startsWith(DEFAULT_PREFIX) ? name.split(' ')[0] : name);
