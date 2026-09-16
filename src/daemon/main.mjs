// @ts-check
// デーモンの起動: ロックファイル・容量の決定・シグナルでの停止。
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { commandLooksLikeSwitchyardd } from './control.mjs';
import { switchyardHome, pathsOf } from './paths.mjs';
import { startDaemon } from './server.mjs';
import { readJson } from './store.mjs';

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
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, String(pid));
      closeSync(fd);
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
    }
  }
  return false;
}

/** @param {NodeJS.ProcessEnv} [env] */
export async function main(env = process.env) {
  const home = switchyardHome(env);
  const p = pathsOf(home);
  mkdirSync(home, { recursive: true });
  if (!acquireLock(p.lock)) {
    let holder = '?';
    try {
      holder = readFileSync(p.lock, 'utf8').trim();
    } catch {
      // 読めなければ pid 不明のまま出す
    }
    process.stderr.write(`[switchyardd] 別の switchyardd(pid ${holder})が動いているので終わる\n`);
    return;
  }
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
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch (e) {
    unlinkSync(p.lock);
    throw e;
  }
}
