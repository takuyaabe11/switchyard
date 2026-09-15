// @ts-check
import { connect } from 'node:net';
import { createDecoder, encode } from '../src/protocol/ndjson.mjs';

/** @typedef {Record<string, unknown>} Msg */

/** テスト用の socket クライアント。届いたメッセージを溜め、条件に合うものを取り出す @param {string} sock */
export async function openClient(sock) {
  const conn = connect(sock);
  conn.setEncoding('utf8');
  /** @type {Msg[]} */
  const inbox = [];
  /** @type {Array<() => void>} */
  let waiters = [];
  const feed = createDecoder(
    (m) => {
      inbox.push(/** @type {Msg} */ (m));
      const ws = waiters;
      waiters = [];
      for (const w of ws) w();
    },
    () => {},
  );
  conn.on('data', (chunk) => feed(String(chunk)));
  await new Promise((resolve, reject) => {
    conn.once('connect', () => resolve(undefined));
    conn.once('error', reject);
  });
  return {
    conn,
    /** @param {unknown} msg */
    send: (msg) => conn.write(encode(msg)),
    /** @param {(m: Msg) => boolean} [pred] @param {number} [timeoutMs] @returns {Promise<Msg>} */
    next: (pred = () => true, timeoutMs = 2_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${timeoutMs}ms 待っても来ない。届いたもの: ${JSON.stringify(inbox)}`)), timeoutMs);
        const check = () => {
          const i = inbox.findIndex(pred);
          if (i < 0) {
            waiters.push(check);
            return;
          }
          clearTimeout(timer);
          resolve(inbox.splice(i, 1)[0]);
        };
        check();
      }),
    close: async () => {
      conn.destroy();
    },
  };
}
