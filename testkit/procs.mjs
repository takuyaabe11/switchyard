// @ts-check
import { execFileSync } from 'node:child_process';

/** プロセスグループに今いる pid の一覧 @param {number} pgid @returns {number[]} */
export function pidsInGroup(pgid) {
  // ゾンビ(終わって回収を待つだけ。init が回収しないコンテナで残る)は数えない
  return execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(' ').filter((x) => x !== ''))
    .filter(([, g, st]) => Number(g) === pgid && !String(st).startsWith('Z'))
    .map(([p]) => Number(p));
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
