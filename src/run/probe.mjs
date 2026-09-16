// @ts-check
// switchyard probe: コマンドを別グループで起動し、決めた秒数だけ子孫を見てから SIGTERM を送り、
// グループから抜けた子と、その後も生きている子を報告する。生き残りは最後に SIGKILL で片付ける。
import { readPgid, signalGroup, spawnInOwnGroup, verifiedGroup, waitGroupGone } from './group.mjs';
import { createEscapeTracker } from './watch.mjs';

/** @typedef {import('./watch.mjs').EscapeReport} EscapeReport */

/**
 * @param {{ argv: string[], seconds: number, intervalMs?: number, graceMs?: number, cwd?: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Promise<EscapeReport & { command: string, group: number }>}
 */
export async function probe({ argv, seconds, intervalMs = 200, graceMs = 2_000, cwd, env }) {
  // 自分の pgid はここで 1 回だけ読み、以後の signalGroup へ渡す(呼ぶたびに ps を起動しない。
  // ps が失敗し続ける環境でも、確かめた値を使い回せる)
  const ownPgid = readPgid(process.pid);
  const child = spawnInOwnGroup(argv, { stdio: 'ignore', cwd, env });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`起動できない: ${argv.join(' ')}`);
  const group = verifiedGroup(pid, ownPgid);
  if (group === null) {
    child.kill('SIGKILL');
    // 自分の pgid を確かめられないときは、そもそもどのプロセスグループにも信号を送っていない
    // (確かめていない番号へは送らない)。理由を区別して伝える
    if (ownPgid === null) throw new Error('自分のプロセスグループ(pgid)を確かめられないので、子へ信号を送れない');
    throw new Error('子のプロセスグループを確かめられない');
  }
  const tracker = createEscapeTracker({ rootPid: pid, pgid: group });
  // グループへの後始末(SIGTERM → 待つ → 必要なら SIGKILL)が、通常の経路で最後まで終わったか。
  // 終わっていれば finally はもう何もしない(既に確かめた・片付けた番号へ送り直さない)
  let cleaned = false;
  try {
    const until = Date.now() + seconds * 1000;
    while (Date.now() < until) {
      tracker.sample();
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    tracker.sample();
    signalGroup(group, 'SIGTERM', ownPgid);
    if (!(await waitGroupGone(group, graceMs))) signalGroup(group, 'SIGKILL', ownPgid);
    cleaned = true;
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
    // 通常の経路で片付けが終わっていれば何もしない。例外で抜けたときだけ最後の SIGKILL を試みる。
    // ここでの失敗は「グループが既に消えている(ESRCH)」だけでなく「ps が自分の pgid を読めない」でも
    // 起こりうるが、どちらであっても再試行で状況は変わらず、報告や制御フローを乱す理由にもならないので握りつぶす
    if (!cleaned) {
      try {
        signalGroup(group, 'SIGKILL', ownPgid);
      } catch {
        // 無視する(上記の理由)
      }
    }
  }
}
