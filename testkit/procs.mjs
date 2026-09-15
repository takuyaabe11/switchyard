// @ts-check
import { execFileSync } from 'node:child_process';

/** プロセスグループに今いる pid の一覧 @param {number} pgid @returns {number[]} */
export function pidsInGroup(pgid) {
  return execFileSync('ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(' ').filter((x) => x !== '').map(Number))
    .filter(([, g]) => g === pgid)
    .map(([p]) => p);
}

/** テストの後始末: グループに残ったプロセスを SIGKILL で消す @param {number} pgid */
export function killGroupLeftovers(pgid) {
  for (const pid of pidsInGroup(pgid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 既に居ない
    }
  }
}
