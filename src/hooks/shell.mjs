// @ts-check
// Bash のコマンドの文字列を、単純コマンド(引用符を外した語の列)に分ける。PreToolUse の判定だけに使う近似(設計 §9.2)。
// 実行も展開もしない。見分けるのは次の形:
//   - 区切り: && || ; | & と改行。引用符('…' "…")と heredoc の本文の中では区切らない
//   - ( … )・$( … )・`…` の中は、別の単純コマンドとして取り出す(置き換わる語は空の語にする)
//   - リダイレクト(> out・2>&1・&> log・< in・<<< 語)は語にしない。語の頭の # からはコメント

/** @typedef {{ delim: string, tabs: boolean }} Heredoc */

/** heredoc の区切り語の終わりになる文字 */
const WORD_END = ' \t\n;&|<>()';

/**
 * @param {string} text @returns {string[][]}
 */
export function simpleCommands(text) {
  /** @type {string[][]} */
  const out = [];
  parse(text, 0, null, out);
  return out;
}

/**
 * コマンドを背景へ回す `&` が、いちばん外側に 1 つだけあり、それがコマンドの最後(後ろは空白とコメントだけ)なら、その位置を返す。
 * それ以外(`&` が無い・途中にある・2 つ以上ある)は -1。`&&`・`2>&1`・`&>`・引用符・heredoc の本文・( … ) の中の `&` は数えない。
 * @param {string} text @returns {number}
 */
export function trailingAmpersand(text) {
  /** @type {Array<{ op: string, at: number }>} */
  const ops = [];
  parse(text, 0, null, [], ops);
  // 最初の & の後ろが空白とコメントだけなら、& はそれ 1 つだけで最後にある(2 つ目があれば後ろが空にならない)
  const first = ops.find((o) => o.op === '&');
  if (first === undefined) return -1;
  const at = first.at;
  const rest = text.slice(at + 1).replace(/#[^\n]*/g, '');
  return rest.trim() === '' ? at : -1;
}

/**
 * start から end の文字(null なら文字列の終わり)までを読み、単純コマンドを out に足す。
 * ops を渡すと、この階層の区切り(; & && || |)を位置と一緒に足す(入れ子の中の区切りは足さない)。
 * @param {string} src @param {number} start @param {')' | '`' | null} end @param {string[][]} out
 * @param {Array<{ op: string, at: number }> | null} [ops]
 * @returns {number} 読み終えた位置(end の文字の次)
 */
function parse(src, start, end, out, ops = null) {
  let i = start;
  /** @type {string[]} */
  let words = [];
  let word = '';
  let inWord = false;
  /** 次に終わる語はリダイレクトの行き先なので捨てる */
  let dropNext = false;
  /** @type {Heredoc[]} この行で始まり、次の改行の後に本文が来る heredoc */
  const heredocs = [];

  const endWord = () => {
    if (inWord && !dropNext) words.push(word);
    if (inWord) dropNext = false;
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    dropNext = false;
    if (words.length > 0) out.push(words);
    words = [];
  };

  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === end) {
      endCommand();
      return i + 1;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i += 1;
    } else if (c === '\n') {
      endCommand();
      i = skipHeredocs(src, i + 1, heredocs);
      heredocs.length = 0;
    } else if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (c === '\\') {
      // 逆斜線と改行は行の継続。それ以外は次の 1 文字をそのまま語にする
      if (n !== undefined && n !== '\n') {
        word += n;
        inWord = true;
      }
      i += 2;
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      const stop = close < 0 ? src.length : close;
      word += src.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
    } else if (c === '"') {
      inWord = true;
      i += 1;
      while (i < src.length && src[i] !== '"') {
        const d = src[i];
        if (d === '\\' && i + 1 < src.length) {
          // "…" の中の逆斜線は、" \ $ ` の前でだけ次の文字を表す(改行の前なら行の継続)
          const e = src[i + 1];
          if (e !== '\n') word += '"\\$`'.includes(e) ? e : `\\${e}`;
          i += 2;
        } else if (d === '$' && src[i + 1] === '(') {
          i = parse(src, i + 2, ')', out);
        } else if (d === '`') {
          i = parse(src, i + 1, '`', out);
        } else {
          word += d;
          i += 1;
        }
      }
      i += 1;
    } else if (c === '$' && n === '(') {
      inWord = true;
      i = parse(src, i + 2, ')', out);
    } else if (c === '`') {
      inWord = true;
      i = parse(src, i + 1, '`', out);
    } else if (c === '(') {
      endCommand();
      i = parse(src, i + 1, ')', out);
    } else if (c === ')') {
      // 対応の無い閉じ括弧(case の型など)は区切りとして扱う
      endCommand();
      i += 1;
    } else if (c === '&' && n === '>') {
      // &> 行き先 / &>> 行き先
      endWord();
      i += src[i + 2] === '>' ? 3 : 2;
      dropNext = true;
    } else if (c === ';' || c === '|' || c === '&') {
      endCommand();
      // && と || は 1 つの区切り(2 文字を一度に読む。単純コマンドの分け方は変わらない)
      const op = (c === '&' || c === '|') && n === c ? c + c : c;
      ops?.push({ op, at: i });
      i += op.length;
    } else if (c === '<' && n === '<' && src[i + 2] !== '<') {
      endWord();
      const r = readHeredoc(src, i + 2);
      heredocs.push(r.heredoc);
      i = r.next;
    } else if (c === '<' || c === '>') {
      // リダイレクト。直前の fd の番号(2> の 2)は語にしない
      if (inWord && /^[0-9]+$/.test(word)) {
        word = '';
        inWord = false;
      } else {
        endWord();
      }
      i += 1;
      while (src[i] === '<' || src[i] === '>' || src[i] === '|') i += 1;
      if (src[i] === '&' && (src[i + 1] === '-' || /[0-9]/.test(src[i + 1] ?? ''))) {
        // 2>&1・>&- は行き先の語を持たない
        i += 2;
        while (/[0-9]/.test(src[i] ?? '')) i += 1;
      } else {
        if (src[i] === '&') i += 1;
        dropNext = true;
      }
    } else {
      word += c;
      inWord = true;
      i += 1;
    }
  }
  endCommand();
  return i;
}

/**
 * `<<` の後ろから、`-` と区切り語を読む(区切り語の引用符と逆斜線は外す)。
 * @param {string} src @param {number} start `<<` の次の位置 @returns {{ heredoc: Heredoc, next: number }}
 */
function readHeredoc(src, start) {
  let i = start;
  const tabs = src[i] === '-';
  if (tabs) i += 1;
  while (src[i] === ' ' || src[i] === '\t') i += 1;
  let delim = '';
  while (i < src.length && !WORD_END.includes(src[i])) {
    const d = src[i];
    if (d === "'" || d === '"') {
      const close = src.indexOf(d, i + 1);
      const stop = close < 0 ? src.length : close;
      delim += src.slice(i + 1, stop);
      i = stop + 1;
    } else if (d === '\\') {
      delim += src[i + 1] ?? '';
      i += 2;
    } else {
      delim += d;
      i += 1;
    }
  }
  return { heredoc: { delim, tabs }, next: i };
}

/**
 * 改行の次から、その行で始まった heredoc の本文を順に読み飛ばす(区切り語だけの行まで)。
 * @param {string} src @param {number} start @param {Heredoc[]} heredocs @returns {number} 本文の次の位置
 */
function skipHeredocs(src, start, heredocs) {
  let pos = start;
  for (const h of heredocs) {
    while (pos < src.length) {
      const nl = src.indexOf('\n', pos);
      const line = src.slice(pos, nl < 0 ? src.length : nl);
      pos = nl < 0 ? src.length : nl + 1;
      if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.delim) break;
    }
  }
  return pos;
}
