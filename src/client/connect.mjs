// @ts-check
// デーモンへの接続。届かなければデーモンを切り離して起動し、接続を試し直す(設計 §4.2)。
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsOf } from '../daemon/paths.mjs';
import { createDecoder, encode } from '../protocol/ndjson.mjs';

/** @typedef {import('node:net').Socket} Socket */
/** @typedef {Record<string, unknown>} Msg */

export const DAEMON_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'conductord.mjs');

export class DaemonUnavailableError extends Error {}

/** @param {string} sock @returns {Promise<Socket>} */
function tryConnect(sock) {
  return new Promise((resolve, reject) => {
    const c = connect(sock);
    const onError = (/** @type {Error} */ e) => reject(e);
    c.once('error', onError);
    c.once('connect', () => {
      c.off('error', onError);
      c.on('error', () => {});
      resolve(c);
    });
  });
}

/**
 * @param {{ home: string, autoStart?: boolean, timeoutMs?: number, env?: NodeJS.ProcessEnv, daemonEntry?: string }} opts
 * @returns {Promise<Socket>}
 */
export async function connectDaemon({ home, autoStart = true, timeoutMs = 2_000, env = process.env, daemonEntry = DAEMON_ENTRY }) {
  const p = pathsOf(home);
  try {
    return await tryConnect(p.sock);
  } catch (e) {
    if (!autoStart) throw new DaemonUnavailableError(`デーモンに届かない: ${e instanceof Error ? e.message : String(e)}`);
  }
  mkdirSync(home, { recursive: true });
  const log = openSync(p.log, 'a');
  const child = spawn(process.execPath, [daemonEntry], { detached: true, stdio: ['ignore', log, log], env: { ...env, CONDUCTOR_HOME: home } });
  child.unref();
  closeSync(log);
  const until = Date.now() + timeoutMs;
  /** @type {unknown} */
  let last = null;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      return await tryConnect(p.sock);
    } catch (e) {
      last = e;
    }
  }
  throw new DaemonUnavailableError(`デーモンを起動したが ${timeoutMs}ms 以内に接続できない(ログ: ${p.log}): ${String(last)}`);
}

/**
 * 接続の上に、メッセージの受け渡しを載せる。
 * @param {Socket} conn
 */
export function channel(conn) {
  conn.setEncoding('utf8');
  /** @type {Array<(m: Msg) => void>} */
  const listeners = [];
  const feed = createDecoder(
    (m) => {
      for (const l of [...listeners]) l(/** @type {Msg} */ (m));
    },
    () => {},
  );
  conn.on('data', (chunk) => feed(String(chunk)));
  conn.on('error', () => {});
  return {
    /** @param {unknown} msg */
    send: (msg) => {
      if (!conn.destroyed) conn.write(encode(msg));
    },
    /** @param {(m: Msg) => void} fn */
    onMessage: (fn) => {
      listeners.push(fn);
    },
    /** @param {() => void} fn */
    onClose: (fn) => {
      conn.once('close', fn);
    },
    close: () => {
      conn.destroy();
    },
    isClosed: () => conn.destroyed,
  };
}

/**
 * 1 往復だけの問い合わせ(CLI 用)。error が返れば投げる。
 * @param {Socket} conn @param {unknown} msg @param {(m: Msg) => boolean} pred @param {number} [timeoutMs] @returns {Promise<Msg>}
 */
export function ask(conn, msg, pred, timeoutMs = 2_000) {
  const ch = channel(conn);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ch.close();
      reject(new Error(`デーモンの応答が ${timeoutMs}ms 無い`));
    }, timeoutMs);
    ch.onMessage((m) => {
      if (m.t === 'error') {
        clearTimeout(timer);
        ch.close();
        reject(new Error(String(m.message)));
      } else if (pred(m)) {
        clearTimeout(timer);
        ch.close();
        resolve(m);
      }
    });
    ch.send(msg);
  });
}
