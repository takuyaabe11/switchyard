// @ts-check
// SessionStart と Stop の hooks(設計 §9.2)。
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

/** 書いた行から shims のパスを取り出す(`export PATH='…/shims':"$PATH"`) */
const SHIMS_LINE = /^export PATH='(.*\/shims)':"\$PATH"$/;

/**
 * CLAUDE_ENV_FILE に書かれた shims の行のうち、指す先がもう無いもの。
 * plugin を置き換えたり改名したりすると古い行が残るが、PATH の壊れたエントリは黙って読み飛ばされるので、
 * 「shim が無い」のと見分けが付かない。実測(2026-09-16): 改名の前から続いていたセッションが、
 * 消えたディレクトリを PATH の先頭に置いたまま、重い走行を 1 時間まるごと管理の外で流した。
 * いま動いている plugin 自身の shims は除く(それが無いのは別の話で、ここで言っても直せない)。
 * @param {string} text env ファイルの中身 @param {string} [own] いまの plugin の shims のパス @returns {string[]} 生きていない shims のパス
 */
export function deadShimPaths(text, own = join(PLUGIN_ROOT, 'shims')) {
  /** @type {string[]} */
  const dead = [];
  for (const line of text.split('\n')) {
    const m = SHIMS_LINE.exec(line.trim());
    if (m !== null && m[1] !== own && !existsSync(m[1]) && !dead.includes(m[1])) dead.push(m[1]);
  }
  return dead;
}

/**
 * 指定した shims のパスを足す行だけを取り除く。他の行(他の plugin が足したものを含む)は 1 文字も変えない。
 * @param {string} text @param {string[]} paths @returns {string}
 */
export function pruneShimLines(text, paths) {
  const kept = text.split('\n').filter((l) => {
    const m = SHIMS_LINE.exec(l.trim());
    return m === null || !paths.includes(m[1]);
  });
  return kept.join('\n');
}

/** 一時ファイルに書いて rename で置き換える(書きかけの env ファイルを残さない) @param {string} file @param {string} text */
function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
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
    let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    // plugin を更新すると置き場のパスに版が入って変わるので、古い行が残り続ける。
    // 指す先が無い行は PATH の中で黙って読み飛ばされ、「shim が無い」のと区別が付かないので取り除く
    const dead = deadShimPaths(text, join(root, 'shims'));
    if (dead.length > 0) {
      text = pruneShimLines(text, dead);
      writeFileAtomic(envFile, text);
      lines.push(`[switchyard] PATH から、もう無い shims を指す行を外した: ${dead.join(' / ')}(plugin の更新か置き場の移動で残ったもの)`);
    }
    // resume / clear / compact でも呼ばれるので、同じ行を 2 度足さない
    if (!text.split('\n').includes(line)) appendFileSync(envFile, `${line}\n`);
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
      lines.push(`[switchyard] 走っているデーモンの版 ${snap.version ?? '0.1.0 以前'} と plugin の版 ${version} が違う。switchyard restart で入れ替わる`);
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
