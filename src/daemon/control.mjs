// @ts-check
// 走っているデーモンを外から止める(switchyard stop / restart)。
// server.mjs を読み込まずに済むよう、ここには socket とロックファイルの扱いだけを置く。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { pathsOf } from './paths.mjs';

/** @typedef {{ stopped: boolean, pid: number | null, reason: string }} StopResult */

/**
 * ps の command 文字列が、いま switchyardd を走らせているプロセスを指しているか。
 * package.json の bin(`switchyardd` という名前の symlink)から起動すると、command は
 * `/usr/bin/env node …/switchyardd` になり `switchyardd.mjs` を含まない(実測)。
 * 空白で区切った語のどれかの basename が `switchyardd` か `switchyardd.mjs` であれば、そうとみなす。
 * @param {string} command @returns {boolean}
 */
export function commandLooksLikeSwitchyardd(command) {
  return command
    .trim()
    .split(/\s+/)
    .some((word) => {
      const base = word.split('/').pop() ?? word;
      return base === 'switchyardd' || base === 'switchyardd.mjs';
    });
}

/** socket に誰かが応答するか(応答すればデーモンが生きている) @param {string} sock @returns {Promise<boolean>} */
export function answers(sock) {
  if (!existsSync(sock)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const c = connect(sock);
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
}

/** ロックファイルの持ち主の pid。読めない・数でないときは null @param {string} lock @returns {number | null} */
export function lockPid(lock) {
  try {
    const n = Number(readFileSync(lock, 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** その pid が今 switchyardd として走っているか(pid の使い回しに備える。I1) @param {number} pid @returns {boolean} */
export function isSwitchyarddPid(pid) {
  try {
    return commandLooksLikeSwitchyardd(execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }));
  } catch {
    return false;
  }
}

/**
 * 走っているデーモンへ SIGTERM を送り、socket が応答しなくなるまで待つ。
 * 走行中のジョブの包みは死なない — 次のデーモンへ resume でリースを取り戻す(設計 §4.2)。
 * @param {{ home: string, timeoutMs?: number, stepMs?: number, signal?: (pid: number) => void, isDaemon?: (pid: number) => boolean }} opts
 * @returns {Promise<StopResult>}
 */
export async function stopDaemon({
  home,
  timeoutMs = 5_000,
  stepMs = 50,
  signal = (pid) => process.kill(pid, 'SIGTERM'),
  isDaemon = isSwitchyarddPid,
}) {
  const p = pathsOf(home);
  if (!(await answers(p.sock))) return { stopped: false, pid: null, reason: 'デーモンは動いていない' };
  const pid = lockPid(p.lock);
  if (pid === null) return { stopped: false, pid: null, reason: `応答しているが、持ち主の pid を ${p.lock} から読めない` };
  if (!isDaemon(pid)) return { stopped: false, pid, reason: `pid ${pid} は switchyardd ではない(ロックが古い)` };
  try {
    signal(pid);
  } catch (e) {
    return { stopped: false, pid, reason: `SIGTERM を送れない: ${e instanceof Error ? e.message : String(e)}` };
  }
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!(await answers(p.sock))) return { stopped: true, pid, reason: `pid ${pid} を止めた` };
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return { stopped: false, pid, reason: `SIGTERM を送ったが ${timeoutMs}ms 以内に止まらない(pid ${pid})` };
}
