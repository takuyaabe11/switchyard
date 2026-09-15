// @ts-check
// conductor probe: コマンドを別グループで起動し、決めた秒数だけ子孫を見てから SIGTERM を送り、
// グループから抜けた子と、その後も生きている子を報告する。生き残りは最後に SIGKILL で片付ける。
import { signalGroup, spawnInOwnGroup, verifiedGroup, waitGroupGone } from './group.mjs';
import { createEscapeTracker } from './watch.mjs';

/** @typedef {import('./watch.mjs').EscapeReport} EscapeReport */

/**
 * @param {{ argv: string[], seconds: number, intervalMs?: number, graceMs?: number, cwd?: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<EscapeReport & { command: string, group: number }>}
 */
export async function probe({ argv, seconds, intervalMs = 200, graceMs = 2_000, cwd, env }) {
  const child = spawnInOwnGroup(argv, { stdio: 'ignore', cwd, env });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`起動できない: ${argv.join(' ')}`);
  const group = verifiedGroup(pid);
  if (group === null) {
    child.kill('SIGKILL');
    throw new Error('子のプロセスグループを確かめられない');
  }
  const tracker = createEscapeTracker({ rootPid: pid, pgid: group });
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    tracker.sample();
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  tracker.sample();
  signalGroup(group, 'SIGTERM');
  if (!(await waitGroupGone(group, graceMs))) signalGroup(group, 'SIGKILL');
  const report = tracker.report();
  for (const s of report.survivors) {
    try {
      process.kill(s.pid, 'SIGKILL');
    } catch {
      // 既に居ない
    }
  }
  return { command: argv.join(' '), group, ...report };
}
