// @ts-check
// 学ぶ単位ごとの所要のばらつき(switchyard replay)。既定の表の走行を profile の名前だけで学ぶと所要が混ざるか、
// 道具とサブコマンドで分けると混ざりが減るか・学べる回数に届かない単位が増えるかを、利用者の記録で数える。
import { classifiableCommand, classify } from '../config/profiles.mjs';
import { learnedName } from '../config/variant.mjs';
import { basename } from 'node:path';
import { headWord, SHIM_WORDS } from '../hooks/pretooluse.mjs';
import { simpleCommands } from '../hooks/shell.mjs';

/** 見込みを出すのに要る回数(src/core/estimate.mjs の ESTIMATE_MIN_SAMPLES と同じ) */
export const LEARNABLE = 3;
/** 測り方が粗い短い走行は数えない(ms) */
const MIN_MS = 1_000;

/**
 * コマンドの重い部分(shim の語で始まり、quick でない profile に当たる単純コマンド)ごとの、profile の名前と学ぶ単位の名前。
 * PreToolUse と同じく、shim の語で始まる部分だけを分類する(sed や python の引数の中の文字を拾わない)。
 * @param {string} command @param {import('../config/profiles.mjs').NamedProfile[]} profiles
 * @returns {Array<{ profile: string, learned: string }>}
 */
export function unitsOf(command, profiles) {
  /** @type {Array<{ profile: string, learned: string }>} */
  const out = [];
  for (const words of simpleCommands(command)) {
    const { head, rest } = headWord(words.join(' '));
    if (!SHIM_WORDS.includes(basename(head))) continue;
    const cc = classifiableCommand([basename(head), ...rest]);
    const np = classify(cc, profiles);
    if (np === null || np.profile.class === 'quick') continue;
    out.push({ profile: np.name, learned: learnedName(np.name, cc) });
  }
  return out;
}

/** @param {number[]} xs @returns {number} */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @typedef {{ units: number, runs: number, learnableRuns: number, typicalFactor: number, over2x: number }} Spread
 *   units: 単位の数。runs: 数えた走行。learnableRuns: 3 本以上たまった単位の走行(見込みを出せる)。
 *   typicalFactor: その走行の所要が、単位の中央値から典型でどれだけずれるか(倍率。ずれの対数の中央値)。
 *   over2x: 単位の中央値から 2 倍以上ずれた走行
 */

/**
 * 単位ごとに、所要が中央値からどれだけずれるか。
 * @param {Array<{ unit: string, ms: number }>} runs @returns {Spread}
 */
export function spreadOf(runs) {
  /** @type {Map<string, number[]>} */
  const byUnit = new Map();
  for (const r of runs) {
    if (!(r.ms >= MIN_MS)) continue;
    const list = byUnit.get(r.unit) ?? [];
    list.push(r.ms);
    byUnit.set(r.unit, list);
  }
  /** @type {number[]} */
  const devs = [];
  let counted = 0;
  for (const list of byUnit.values()) {
    counted += list.length;
    if (list.length < LEARNABLE) continue;
    const m = median(list);
    for (const ms of list) devs.push(Math.abs(Math.log(ms / m)));
  }
  return {
    units: byUnit.size,
    runs: counted,
    learnableRuns: devs.length,
    typicalFactor: devs.length === 0 ? 1 : Math.round(Math.exp(median(devs)) * 100) / 100,
    over2x: devs.filter((d) => d >= Math.log(2)).length,
  };
}

/**
 * 既定の表に当たる前景の重い走行(重い部分が 1 つだけの Bash の呼び出し)について、profile の名前だけの単位と、道具とサブコマンドの単位を比べる。
 * @param {Array<{ command: string, cwd: string, ms: number }>} runs
 * @param {(cwd: string) => import('../config/profiles.mjs').NamedProfile[]} profilesFor
 * @returns {{ byProfile: Spread, byVariant: Spread }}
 */
export function compareUnits(runs, profilesFor) {
  /** @type {Array<{ unit: string, ms: number }>} */
  const byProfile = [];
  /** @type {Array<{ unit: string, ms: number }>} */
  const byVariant = [];
  for (const r of runs) {
    // 重い部分が 1 つだけの呼び出しに限る(2 つ以上なら、呼び出しの所要は 1 本の走行の所要ではない)
    const us = unitsOf(r.command, profilesFor(r.cwd));
    if (us.length !== 1 || us[0].profile === us[0].learned) continue;
    const u = us[0];
    byProfile.push({ unit: `${r.cwd}\u0000${u.profile}`, ms: r.ms });
    byVariant.push({ unit: `${r.cwd}\u0000${u.learned}`, ms: r.ms });
  }
  return { byProfile: spreadOf(byProfile), byVariant: spreadOf(byVariant) };
}
