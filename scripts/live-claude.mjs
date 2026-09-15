#!/usr/bin/env node
// @ts-check
// 本物の Claude Code での通し(設計 §15)。費用が出るので CONDUCTOR_LIVE_CLAUDE=1 のときだけ走る。
// 使い捨ての作業場所と一時の CONDUCTOR_HOME で、この repo を --plugin-dir として haiku に 2 回走らせる:
//   1. 成功する npm test: shim が conductor に通し(記録に default:batch)、PreToolUse が背景に回し、子にジョブの id が渡る
//   2. 失敗する npm test: Stop が差し戻し、Claude が conductor ack で確認済みにする
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsOf } from '../src/daemon/paths.mjs';
import { readRecords } from '../src/daemon/store.mjs';
import { commandLooksLikeConductord } from '../src/daemon/main.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * claude -p --output-format stream-json の標準出力から、確かめたいことを取り出す。
 * @param {string} text
 * @returns {{ background: boolean, blockedStop: boolean, result: string, costUsd: number | null }}
 */
export function analyzeStream(text) {
  let background = false;
  let blockedStop = false;
  let result = '';
  /** @type {number | null} */
  let costUsd = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    /** @type {Record<string, unknown>} */
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const s = JSON.stringify(m);
    if (/running in background/i.test(s)) background = true;
    if (s.includes('まだ確認されていない終わり方がある')) blockedStop = true;
    if (m.type === 'result') {
      result = String(m.result ?? '');
      costUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null;
    }
  }
  return { background, blockedStop, result, costUsd };
}

/** @param {string} home */
function stopDaemon(home) {
  const lock = pathsOf(home).lock;
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 1) return;
  // この通しが mkdtemp で作った一時の HOME で自動起動したデーモンだけを止める。送るのは lock の pid 1 つだけ(グループには送らない)で、
  // pid の再利用に備えて、デーモンの二重起動防止(acquireLock)と同じ判定で持ち主が conductord であることを確かめる
  const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  if (commandLooksLikeConductord(command)) process.kill(pid, 'SIGTERM');
}

// 直接実行されたときだけ走る。import されたときは何もしない(argv[1] が実在しない起動でも投げない)
const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  if (process.env.CONDUCTOR_LIVE_CLAUDE !== '1') {
    console.log('本物の Claude Code での通しは CONDUCTOR_LIVE_CLAUDE=1 のときだけ走る(費用が出るため)');
    process.exit(0);
  }
  const work = mkdtempSync(join(tmpdir(), 'clive-'));
  const home = mkdtempSync(join(tmpdir(), 'clh-'));
  execFileSync('git', ['init', '-q'], { cwd: work });
  const script = "console.log('LIVE_JOB=' + (process.env.CONDUCTOR_JOB_ID || 'none')); process.exit(Number(process.env.LIVE_FAIL || 0))";
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'conductor-live', private: true, scripts: { test: `node -e "${script}"` } }, null, 2));
  /** @type {NodeJS.ProcessEnv} */
  const baseEnv = { ...process.env, CONDUCTOR_HOME: home };
  delete baseEnv.CONDUCTOR_IN_JOB;
  delete baseEnv.CONDUCTOR_HELD_LOCKS;
  delete baseEnv.CONDUCTOR_JOB_ID;

  /** @param {string} prompt @param {string[]} allowed @param {Record<string, string>} [extra] */
  const claude = (prompt, allowed, extra = {}) =>
    spawnSync(
      'claude',
      ['-p', prompt, '--plugin-dir', ROOT, '--setting-sources', 'project', '--model', 'claude-haiku-4-5', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', '0.5', '--no-session-persistence', '--allowedTools', ...allowed],
      { cwd: work, encoding: 'utf8', input: '', timeout: 300_000, env: { ...baseEnv, ...extra } },
    );

  try {
    const r1 = claude('Run the Bash command `npm test` exactly once. Wait until it has finished, then reply with the line of its output that starts with LIVE_JOB=.', ['Bash(npm test)']);
    const a1 = analyzeStream(r1.stdout ?? '');
    const records = () => readRecords(pathsOf(home).events).records;
    const managed = records().some((r) => r.kind === 'history' && r.profile === 'default:batch' && r.code === 0);

    const r2 = claude('Run the Bash command `npm test` exactly once; it is expected to fail. Before you stop, follow any instructions you receive.', ['Bash(npm test)', 'Bash(conductor ack:*)', 'Bash(conductor why:*)'], { LIVE_FAIL: '1' });
    const a2 = analyzeStream(r2.stdout ?? '');
    const acked = records().some((r) => r.kind === 'event' && typeof r.event === 'object' && r.event !== null && /** @type {Record<string, unknown>} */ (r.event).type === 'ack');

    const checks = {
      'shim が npm test を conductor に通した(記録に default:batch の history)': managed,
      'PreToolUse が背景に回した': a1.background,
      '子にジョブの id が渡った(LIVE_JOB=j…)': /LIVE_JOB=j/.test(a1.result),
      'Stop の差し戻しの後、Claude が conductor ack した': acked,
    };
    console.log(JSON.stringify({ checks, stopReasonSeenInStream: a2.blockedStop, costUsd: [a1.costUsd, a2.costUsd], result1: a1.result, result2: a2.result, work, home }, null, 2));
    process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
  } finally {
    stopDaemon(home);
  }
}
