// @ts-check
// デーモンの起動: ロックファイル・容量の決定・シグナルでの停止。
import { execFileSync } from 'node:child_process';
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { commandLooksLikeSwitchyardd } from './control.mjs';
import { ensurePrivateDir, PRIVATE_FILE_MODE, switchyardHome, pathsOf } from './paths.mjs';
import { startDaemon } from './server.mjs';
import { readJson } from './store.mjs';
import { t } from '../i18n.mjs';

/** 予約コアの初期値(設計 §5.1) @param {number} cores @returns {number} */
export function defaultReserve(cores) {
  return Math.ceil(cores * 0.2);
}

/** @param {string | undefined} v @returns {number | undefined} */
function positiveInt(v) {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * 容量 = 論理コア数 − 予約。SWITCHYARD_CAPACITY があればそれを使う(テスト用)。
 * @param {NodeJS.ProcessEnv} env @param {number} cores @param {unknown} config @returns {number}
 */
export function capacityFrom(env, cores, config) {
  const forced = positiveInt(env.SWITCHYARD_CAPACITY);
  if (forced !== undefined) return forced;
  const c = /** @type {Record<string, unknown> | null} */ (typeof config === 'object' ? config : null);
  const reserve = c !== null && typeof c.reserve === 'number' && c.reserve >= 0 ? c.reserve : defaultReserve(cores);
  return Math.max(1, cores - reserve);
}

/** @param {unknown} config @returns {Record<string, number>} */
export function lockCapsFrom(config) {
  const c = /** @type {Record<string, unknown> | null} */ (typeof config === 'object' ? config : null);
  const raw = c !== null && typeof c.lockCaps === 'object' && c.lockCaps !== null ? /** @type {Record<string, unknown>} */ (c.lockCaps) : {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) if (Number.isInteger(v) && Number(v) >= 1) out[k] = Number(v);
  return out;
}

// 既存の呼び出し元とテストのために、ここからも読めるようにしておく
export { commandLooksLikeSwitchyardd };

/** @param {number} pid */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * 持ち主の pid が、いま switchyardd として走っているか(pid の使い回しに備える。I1)。
 * @param {number} pid @returns {boolean}
 */
function isSwitchyarddProcess(pid) {
  try {
    return commandLooksLikeSwitchyardd(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

/**
 * ロックファイルを排他作成して二重起動を防ぐ。持ち主が死んでいるか、生きていても switchyardd でなければ
 * (pid の使い回し。I1)、1 回だけ取り直す。
 * @param {string} file @param {number} [pid] @param {(pid: number) => boolean} [isAlive] @param {(pid: number) => boolean} [isSwitchyardd] @returns {boolean}
 */
export function acquireLock(file, pid = process.pid, isAlive = pidAlive, isSwitchyardd = isSwitchyarddProcess) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // pid を書き終えた一時ファイルを link でロックの名前に付ける(link は名前が既にあれば EEXIST で失敗する)。
    // openSync(file, 'wx') で作ってから書くと、書き終える前の空のロックを、同時に起動したもう 1 本が
    // 「持ち主が読めない古いロック」とみなして消し、2 本が互いに自分が持ち主だと思って走る(CI の macOS で実測)
    const tmp = `${file}.${pid}.${process.hrtime.bigint()}.tmp`;
    const fd = openSync(tmp, 'wx', PRIVATE_FILE_MODE);
    try {
      writeSync(fd, String(pid));
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(tmp, file);
      return true;
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
      let holder = NaN;
      try {
        holder = Number(readFileSync(file, 'utf8').trim());
      } catch {
        // 読む前に消えた: 取り直す
      }
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder) && isSwitchyardd(holder)) return false;
      try {
        unlinkSync(file);
      } catch {
        // 他のプロセスが先に消した
      }
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // 既に無い
      }
    }
  }
  return false;
}

/** @param {NodeJS.ProcessEnv} [env] */
export async function main(env = process.env) {
  const home = switchyardHome(env);
  const p = pathsOf(home);
  ensurePrivateDir(home);
  if (!acquireLock(p.lock)) {
    let holder = '?';
    try {
      holder = readFileSync(p.lock, 'utf8').trim();
    } catch {
      // 読めなければ pid 不明のまま出す
    }
    process.stderr.write(t(`[switchyardd] 別の switchyardd(pid ${holder})が動いているので終わる\n`, `[switchyardd] another switchyardd (pid ${holder}) is running; exiting\n`));
    return;
  }
  // 起動が終わるまでに SIGTERM / SIGINT を受けても、ロックを残さずに終わる
  // (既定の動作で死ぬとロックが残る。次の起動は持ち主が死んだロックを取り直せるが、止める側はロックが消えるのを待ち続ける)
  // ハンドラは付け替えずに 1 つのまま、中の処理だけを差し替える。最後のリスナーを外すと Node は信号の監視を閉じ、
  // その間に届いて配られる前だった信号を捨てる(実測: 起動の直後に送った SIGTERM が 40 回に 1 回失われた)
  /** @type {() => void} */
  let onSignal = () => {
    try {
      unlinkSync(p.lock);
    } catch {
      // 既に無い
    }
    process.exit(0);
  };
  const handler = () => onSignal();
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  const config = readJson(join(home, 'config.json'));
  /** @type {(() => Promise<void>) | null} 起動が終わるまでは呼べない */
  let shutdown = null;
  try {
    const d = await startDaemon({
      home,
      capacity: capacityFrom(env, availableParallelism(), config),
      lockCaps: lockCapsFrom(config),
      tickMs: positiveInt(env.SWITCHYARD_TICK_MS),
      heartbeatTimeoutMs: positiveInt(env.SWITCHYARD_HEARTBEAT_TIMEOUT_MS),
      recoveryGraceMs: positiveInt(env.SWITCHYARD_RECOVERY_GRACE_MS),
      idleExitMs: env.SWITCHYARD_IDLE_EXIT_MS === '0' ? null : positiveInt(env.SWITCHYARD_IDLE_EXIT_MS),
      // 実測の CPU の使い方で要求を小さくする(既定で有効。0 で宣言どおりに並べる)
      adaptive: env.SWITCHYARD_ADAPTIVE !== '0',
      // 予約はされたが使われていないコアに、待っている batch を 1 本ずつ詰め込む(既定で有効。0 で宣言の空きだけで入場させる)
      overcommit: env.SWITCHYARD_OVERCOMMIT !== '0',
      // 走行のピークのメモリを学び、重ねると空きメモリが下限(既定は全体の 10%)を割る走行を待たせる(0 で止める)
      memory: env.SWITCHYARD_MEMORY !== '0',
      ...(positiveInt(env.SWITCHYARD_MEM_FLOOR_MB) === undefined ? {} : { memFloorMb: positiveInt(env.SWITCHYARD_MEM_FLOOR_MB) }),
      // 一度も仕事をしないまま静かなら、自分で終わる(次の要求で自動起動する)
      onIdleExit: () => {
        void shutdown?.();
      },
    });
    const stop = async () => {
      await d.close();
      try {
        unlinkSync(p.lock);
      } catch {
        // 既に無い
      }
      process.exit(0);
    };
    shutdown = stop;
    onSignal = () => {
      void stop();
    };
  } catch (e) {
    unlinkSync(p.lock);
    throw e;
  }
}
