// @ts-check
// 改行区切り JSON。1 行 1 メッセージ。

/** @param {unknown} msg @returns {string} */
export function encode(msg) {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * 文字列の断片を受け取り、行がそろうたびに onMessage を呼ぶ。JSON でない行は onBadLine へ渡す。
 * socket には setEncoding('utf8') をかけてから渡すこと(多バイト文字が断片の境目で割れないように)。
 * @param {(msg: unknown) => void} onMessage
 * @param {(line: string) => void} onBadLine
 * @returns {(chunk: string) => void}
 */
export function createDecoder(onMessage, onBadLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() !== '') {
        /** @type {unknown} */
        let msg;
        let ok = true;
        try {
          msg = JSON.parse(line);
        } catch {
          ok = false;
        }
        // onMessage の中で投げた例外を「壊れた行」と取り違えないよう、呼び出しは try の外
        if (ok) onMessage(msg);
        else onBadLine(line);
      }
      i = buf.indexOf('\n');
    }
  };
}
