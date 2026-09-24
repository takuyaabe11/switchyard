// @ts-check
// SessionStart と Stop の hooks(設計 §9.2)。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ask, connectDaemon, DaemonUnavailableError } from '../client/connect.mjs';
import { ensurePrivateDir, switchyardHome, pathsOf } from '../daemon/paths.mjs';
import { VERSION } from '../version.mjs';
import { t } from '../i18n.mjs';
import { isOff } from './off.mjs';
import { fromBashPath, IS_WINDOWS, toBashPath } from '../platform.mjs';

/** @typedef {import('../protocol/messages.mjs').Snapshot} Snapshot */
/** @typedef {import('../core/types.mjs').Unacked} Unacked */
/** @typedef {import('../core/types.mjs').UnackedKind} UnackedKind */

/** plugin の根(この repo の根) */
export const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** sh の単一引用符で囲む @param {string} s */
const shQuote = (s) => `'${s.split("'").join("'\\''")}'`;

/**
 * CLAUDE_ENV_FILE に書く 1 行(shims を PATH の先頭へ足す。設計 §9.1)。
 * Windows では Bash ツールの Git Bash が読むので、/c/… の形で書く(C:\… のままだと : で PATH が切れる)。
 * @param {string} root @param {boolean} [windows]
 */
export function pathExportLine(root, windows = IS_WINDOWS) {
  const shims = join(root, 'shims');
  return `export PATH=${shQuote(windows ? toBashPath(shims) : shims)}:"$PATH"`;
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
    if (m !== null && m[1] !== own && m[1] !== toBashPath(own) && !existsSync(IS_WINDOWS ? fromBashPath(m[1]) : m[1]) && !dead.includes(m[1])) dead.push(m[1]);
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
 * 確認待ちの 1 行。環境のせいかもしれない失敗には、その手がかりを添える。
 * @param {Unacked} j @param {Record<UnackedKind, string>} kind @returns {string}
 */
function unackedLine(j, kind) {
  const hint = j.hint !== undefined && j.hint.length > 0 ? t(`(環境のせいかもしれない: ${j.hint.join('・')})`, ` (may not be the code: ${j.hint.join('; ')})`) : '';
  return t(`- ${j.jobId} ${kind[j.kind]}(終了コード ${j.code ?? 'なし'}): ${j.cmd}${hint}`, `- ${j.jobId} ${kind[j.kind]} (exit code ${j.code ?? 'none'}): ${j.cmd}${hint}`);
}

/**
 * Stop で知らせたジョブを覚え、まだ知らせていないものだけを返す(同じ失敗を毎回のターンの終わりに出さない)。
 * 覚えられなくても知らせる(記録は補助)。セッションごとに直近 200 件まで。
 * @param {string} home @param {string} session @param {string[]} jobIds @returns {string[]}
 */
export function notifyOnce(home, session, jobIds) {
  const file = join(home, 'stop-notified.json');
  /** @type {Record<string, string[]>} */
  let seen = {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof raw === 'object' && raw !== null) seen = raw;
  } catch {
    // 無い・読めない
  }
  const before = Array.isArray(seen[session]) ? seen[session] : [];
  const fresh = jobIds.filter((id) => !before.includes(id));
  if (fresh.length === 0) return [];
  seen[session] = [...before, ...fresh].slice(-200);
  try {
    ensurePrivateDir(home);
    writeFileAtomic(file, JSON.stringify(seen));
  } catch {
    // 覚えられなくても知らせる
  }
  return fresh;
}

/** 最新の版を問う先(公開の repo の plugin.json) */
export const LATEST_URL = 'https://raw.githubusercontent.com/takuyaabe11/switchyard/main/.claude-plugin/plugin.json';
/** 最新の版を問い直すまでの間(1 日) */
const UPDATE_CHECK_TTL_MS = 86_400_000;

/** `1.2.3` の形の版を比べる。a が新しければ正 @param {string} a @param {string} b @returns {number} */
export function compareVersions(a, b) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 新しい版が出ていれば、知らせる 1 行。SWITCHYARD_UPDATE_CHECK=1 のときだけ、1 日に 1 回まで外へ問う(既定は問わない。
 * 会社の機械で、断りなく外へ通信するものを嫌う声が多かった)。
 * 問えなければ何も言わない(セッションの始まりを止めない)。
 * @param {{ env: NodeJS.ProcessEnv, version: string, fetchLatest?: () => Promise<string | null>, now?: () => number }} opts
 * @returns {Promise<string | null>}
 */
export async function updateNotice({ env, version, fetchLatest = defaultFetchLatest, now = Date.now }) {
  if (env.SWITCHYARD_UPDATE_CHECK !== '1') return null;
  const cache = join(switchyardHome(env), 'update-check.json');
  /** @type {string | null} */
  let latest = null;
  try {
    const c = JSON.parse(readFileSync(cache, 'utf8'));
    if (typeof c.latest === 'string' && typeof c.checkedAt === 'number' && now() - c.checkedAt < UPDATE_CHECK_TTL_MS) latest = c.latest;
  } catch {
    // 控えが無い・読めない: 問い直す
  }
  if (latest === null) {
    latest = await fetchLatest().catch(() => null);
    if (latest === null) return null;
    try {
      ensurePrivateDir(switchyardHome(env));
      writeFileAtomic(cache, JSON.stringify({ latest, checkedAt: now() }));
    } catch {
      // 控えられなくても知らせる
    }
  }
  if (compareVersions(latest, version) <= 0) return null;
  return t(
    `[switchyard] 新しい版 ${latest} が出ている(いまは ${version})。/plugin marketplace update switchyard の後に /reload-plugins、その後 switchyard restart で入れ替わる`,
    `[switchyard] version ${latest} is available (this is ${version}). Run /plugin marketplace update switchyard, then /reload-plugins, then switchyard restart`,
  );
}

/** @returns {Promise<string | null>} */
async function defaultFetchLatest() {
  const res = await fetch(LATEST_URL, { signal: AbortSignal.timeout(1_500) });
  if (!res.ok) return null;
  const body = /** @type {Record<string, unknown>} */ (await res.json());
  return typeof body.version === 'string' ? body.version : null;
}

/**
 * SessionStart: shims を PATH の先頭へ足し、知らせることがあれば行で返す(Claude の文脈に入る)。
 * @param {Record<string, unknown>} _input
 * @param {{ env?: NodeJS.ProcessEnv, connect?: typeof connectDaemon, root?: string, version?: string, fetchLatest?: () => Promise<string | null> }} [opts]
 * @returns {Promise<string[]>}
 */
export async function sessionStart(_input, { env = process.env, connect = connectDaemon, root = PLUGIN_ROOT, version = VERSION, fetchLatest } = {}) {
  if (isOff(env)) return [];
  /** @type {string[]} */
  const lines = [];
  const envFile = env.CLAUDE_ENV_FILE;
  if (envFile === undefined || envFile === '') {
    lines.push(
      t(
        '[switchyard] shim を PATH に足せない(CLAUDE_ENV_FILE が無い)ので、このセッションの重い走行は switchyard に管理されない',
        '[switchyard] cannot put the shims on PATH (no CLAUDE_ENV_FILE), so heavy runs in this session are not managed by switchyard',
      ),
    );
  } else {
    const line = pathExportLine(root);
    let text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    // plugin を更新すると置き場のパスに版が入って変わるので、古い行が残り続ける。
    // 指す先が無い行は PATH の中で黙って読み飛ばされ、「shim が無い」のと区別が付かないので取り除く
    const dead = deadShimPaths(text, join(root, 'shims'));
    if (dead.length > 0) {
      text = pruneShimLines(text, dead);
      writeFileAtomic(envFile, text);
      lines.push(
        t(
          `[switchyard] PATH から、もう無い shims を指す行を外した: ${dead.join(' / ')}(plugin の更新か置き場の移動で残ったもの)`,
          `[switchyard] removed PATH lines pointing at shims that no longer exist: ${dead.join(' / ')} (left over from a plugin update or move)`,
        ),
      );
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
    if (measure !== undefined) {
      lines.push(
        t(
          `[switchyard] 計測 ${measure.id}(${measure.cmd})が走っている。重い走行は計測が終わるまで待ちになる`,
          `[switchyard] measurement ${measure.id} (${measure.cmd}) is running; heavy runs wait until it ends`,
        ),
      );
    }
    if (snap.version !== version) {
      // 版を snapshot に載せ始めたのは 0.2.0 なので、名乗らないデーモンは 0.1.0 以前
      lines.push(
        t(
          `[switchyard] 走っているデーモンの版 ${snap.version ?? '0.1.0 以前'} と plugin の版 ${version} が違う。switchyard restart で入れ替わる`,
          `[switchyard] the running daemon is ${snap.version ?? '0.1.0 or older'} but the plugin is ${version}; switchyard restart replaces it`,
        ),
      );
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    lines.push(t(`[switchyard] デーモンに届かない(${why})。このセッションの重い走行は管理なしで走る`, `[switchyard] cannot reach the daemon (${why}); heavy runs in this session run unmanaged`));
  }
  const update = await updateNotice({ env, version, ...(fetchLatest === undefined ? {} : { fetchLatest }) });
  if (update !== null) lines.push(update);
  return lines;
}

/** @type {() => Record<UnackedKind, string>} */
const KIND = () => ({
  failed: t('失敗', 'failed'),
  killed: t('呼び出し元の信号で終了', 'ended by the caller\'s signal'),
  orphan: t('包みを失った(子は走行中)', 'lost its wrapper (child still running)'),
  lost: t('包みを見失った', 'wrapper lost'),
});

/**
 * Stop: 自分のセッションに ack されていないジョブがあれば、停止を差し戻す(設計 §9.2・§9.4)。
 * @param {Record<string, unknown>} input
 * @param {{ env?: NodeJS.ProcessEnv, connect?: typeof connectDaemon }} [opts]
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function stop(input, { env = process.env, connect = connectDaemon } = {}) {
  if (isOff(env) || input.stop_hook_active === true) return null;
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
  const kind = KIND();
  if (env.SWITCHYARD_STOP !== 'block') {
    // 既定: 差し戻さず、人に知らせるだけ(Claude に確認を強いない)。同じジョブは 1 回だけ知らせる
    const fresh = notifyOnce(home, session, jobs.map((j) => j.jobId));
    if (fresh.length === 0) return null;
    const lines = jobs
      .filter((j) => fresh.includes(j.jobId))
      .map((j) => unackedLine(j, kind))
      .join('\n');
    return {
      systemMessage: t(
        `[switchyard] このセッションで、まだ誰も確かめていない終わり方の走行がある:\n${lines}\n` +
          'switchyard why <job> で理由を読み、確かめたら switchyard ack <job>。止まる前に Claude に確かめさせたいときは SWITCHYARD_STOP=block。',
        `[switchyard] runs in this session ended in a way nobody has looked at yet:\n${lines}\n` +
          'Read why with switchyard why <job>, and mark it with switchyard ack <job>. To have Claude check before it stops, set SWITCHYARD_STOP=block.',
      ),
    };
  }
  const list = jobs
    .map((j) => unackedLine(j, kind))
    .join('\n');
  return {
    decision: 'block',
    reason:
      t(
        `[switchyard] このセッションのジョブに、まだ確認されていない終わり方がある:\n${list}\n` +
          `記録: ${pathsOf(home).events}(switchyard why <job> でも読める)。中身を確かめて直すか、直さないと決めたら switchyard ack <job> で確認済みにする。` +
          '同じコマンドを直して走らせ直し、成功すれば自動で確認済みになる。',
        `[switchyard] jobs in this session ended in a way nobody has looked at yet:\n${list}\n` +
          `Log: ${pathsOf(home).events} (also readable with switchyard why <job>). Look at it and fix it, or decide not to and mark it with switchyard ack <job>. ` +
          'Re-running the same command successfully after a fix clears it automatically.',
      ),
  };
}
