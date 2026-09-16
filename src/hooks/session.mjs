// @ts-check
// SessionStart と Stop の hooks(設計 §9.2)。
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, connectDaemon, DaemonUnavailableError } from '../client/connect.mjs';
import { switchyardHome, pathsOf } from '../daemon/paths.mjs';
import { VERSION } from '../version.mjs';

/** @typedef {import('../protocol/messages.mjs').Snapshot} Snapshot */
/** @typedef {import('../core/types.mjs').Unacked} Unacked */
/** @typedef {import('../core/types.mjs').UnackedKind} UnackedKind */

/** plugin の根(この repo の根) */
export const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** sh の単一引用符で囲む @param {string} s */
const shQuote = (s) => `'${s.split("'").join("'\\''")}'`;

/** CLAUDE_ENV_FILE に書く 1 行(shims を PATH の先頭へ足す。設計 §9.1) @param {string} root */
export function pathExportLine(root) {
  return `export PATH=${shQuote(join(root, 'shims'))}:"$PATH"`;
}

/**
 * SessionStart: shims を PATH の先頭へ足し、知らせることがあれば行で返す(Claude の文脈に入る)。
 * @param {Record<string, unknown>} _input
 * @param {{ env?: NodeJS.ProcessEnv, connect?: typeof connectDaemon, root?: string, version?: string }} [opts]
 * @returns {Promise<string[]>}
 */
export async function sessionStart(_input, { env = process.env, connect = connectDaemon, root = PLUGIN_ROOT, version = VERSION } = {}) {
  if (env.SWITCHYARD_THINKER === '1') return [];
  /** @type {string[]} */
  const lines = [];
  const envFile = env.CLAUDE_ENV_FILE;
  if (envFile === undefined || envFile === '') {
    lines.push('[switchyard] shim を PATH に足せない(CLAUDE_ENV_FILE が無い)ので、このセッションの重い走行は switchyard に管理されない');
  } else {
    const line = pathExportLine(root);
    // resume / clear / compact でも呼ばれるので、同じ行を 2 度足さない
    if (!(existsSync(envFile) ? readFileSync(envFile, 'utf8') : '').split('\n').includes(line)) appendFileSync(envFile, `${line}\n`);
  }
  try {
    // 届かなければ自動起動を 1 回試みる(connectDaemon の既定)
    const conn = await connect({ home: switchyardHome(env), env });
    const m = await ask(conn, { t: 'status' }, (x) => x.t === 'status');
    const snap = /** @type {Snapshot} */ (m.snapshot);
    const measure = snap.leases.find((l) => l.class === 'measure');
    if (measure !== undefined) lines.push(`[switchyard] 計測 ${measure.id}(${measure.cmd})が走っている。重い走行は計測が終わるまで待ちになる`);
    if (snap.version !== version) {
      // 版を snapshot に載せ始めたのは 0.2.0 なので、名乗らないデーモンは 0.1.0 以前
      lines.push(`[switchyard] 走っているデーモンの版 ${snap.version ?? '0.1.0 以前'} と plugin の版 ${version} が違う。デーモン(~/.switchyard/daemon.lock の pid)を止めると、次の要求で新しい版が起動する`);
    }
  } catch (e) {
    lines.push(`[switchyard] デーモンに届かない(${e instanceof Error ? e.message : String(e)})。このセッションの重い走行は管理なしで走る`);
  }
  return lines;
}

/** @type {Record<UnackedKind, string>} */
const KIND = { failed: '失敗', killed: '呼び出し元の信号で終了', orphan: '包みを失った(子は走行中)', lost: '包みを見失った' };

/**
 * Stop: 自分のセッションに ack されていないジョブがあれば、停止を差し戻す(設計 §9.2・§9.4)。
 * @param {Record<string, unknown>} input
 * @param {{ env?: NodeJS.ProcessEnv, connect?: typeof connectDaemon }} [opts]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function stop(input, { env = process.env, connect = connectDaemon } = {}) {
  if (env.SWITCHYARD_THINKER === '1' || input.stop_hook_active === true) return null;
  const session = typeof input.session_id === 'string' ? input.session_id.slice(0, 8) : '';
  if (session === '') return null;
  const home = switchyardHome(env);
  /** @type {Unacked[]} */
  let jobs;
  try {
    const conn = await connect({ home, env, autoStart: false });
    const m = await ask(conn, { t: 'unacked', session }, (x) => x.t === 'unacked');
    jobs = /** @type {Unacked[]} */ (m.jobs);
  } catch (e) {
    if (e instanceof DaemonUnavailableError) return null;
    throw e;
  }
  if (jobs.length === 0) return null;
  const list = jobs.map((j) => `- ${j.jobId} ${KIND[j.kind]}(終了コード ${j.code ?? 'なし'}): ${j.cmd}`).join('\n');
  return {
    decision: 'block',
    reason:
      `[switchyard] このセッションのジョブに、まだ確認されていない終わり方がある:\n${list}\n` +
      `記録: ${pathsOf(home).events}(switchyard why <job> でも読める)。中身を確かめて直すか、直さないと決めたら switchyard ack <job> で確認済みにする。`,
  };
}
