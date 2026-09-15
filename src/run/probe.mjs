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
  try {
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      tracker.sample();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    tracker.sample();
    signalGroup(group, 'SIGTERM');
    if (!(await waitGroupGone(group, graceMs))) signalGroup(group, 'SIGKILL');
    const report = tracker.report();
    // SIGKILL の対象は生き残り(survivors)だけ。report() 側で開始時刻を照合済みなので、使い回された pid を巻き込まない(I2)
    for (const s of report.survivors) {
      try {
        process.kill(s.pid, 'SIGKILL');
      } catch {
        // 既に居ない
      }
    }
    return { command: argv.join(' '), group, ...report };
  } finally {
    // どの経路で抜けても、起動したグループの片付けを試みる。
    // 既に空なら signalGroup は ESRCH を投げずに false を返すだけなので、ここでの失敗は握りつぶしてよい
    // (グループが既に消えている・既に SIGKILL 済みなど、報告や制御フローを乱す理由にならないため)
    try {
      signalGroup(group, 'SIGKILL');
    } catch {
      // 無視する(上記の理由)
    }
  }
}
