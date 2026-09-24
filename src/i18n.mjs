// @ts-check
// 利用者に見せる文言の言語。英語を既定にし、日本語の環境(LANG などが ja で始まる)か SWITCHYARD_LANG=ja で日本語にする。
// 文言は呼ぶ場所に日本語と英語を並べて置く(t(日本語, 英語))。表を別に持つと、片方だけ直す事故が見えにくい。

/** @typedef {'en' | 'ja'} Lang */

/**
 * 環境から言語を決める。SWITCHYARD_LANG(en / ja)が最優先、次に LC_ALL → LC_MESSAGES → LANG が ja で始まるか。
 * @param {NodeJS.ProcessEnv} [env] @returns {Lang}
 */
export function langOf(env = process.env) {
  const forced = env.SWITCHYARD_LANG;
  if (forced === 'ja' || forced === 'en') return forced;
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return locale.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** @type {Lang} */
let current = langOf();

/** テストと、環境を渡された入口が言語を切り替える @param {Lang} lang */
export function setLang(lang) {
  current = lang;
}

/** @returns {Lang} */
export function lang() {
  return current;
}

/**
 * いまの言語の文言を選ぶ。
 * @param {string} ja @param {string} en @returns {string}
 */
export function t(ja, en) {
  return current === 'ja' ? ja : en;
}
