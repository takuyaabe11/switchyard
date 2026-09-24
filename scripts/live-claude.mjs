#!/usr/bin/env node
// @ts-check
// 本物の Claude Code での通し(設計 §15)。費用が出るので SWITCHYARD_LIVE_CLAUDE=1 のときだけ走る。
// 使い捨ての作業場所と一時の SWITCHYARD_HOME で、この repo を --plugin-dir として haiku に 3 回走らせる:
//   1. 成功する npm test: shim が switchyard に通し(記録に default:batch)、空いているので前景のまま走り、子にジョブの id が渡り、文言は英語
//   2. 失敗する npm test: Stop が差し戻し(SWITCHYARD_STOP=block)、Claude が switchyard ack で確認済みにする
//   3. ./gradlew test: shim から見えないので PreToolUse が switchyard run -- で包む形に書き換え、拒否せずにそのまま走る
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsOf } from '../src/daemon/paths.mjs';
import { readRecords } from '../src/daemon/store.mjs';
import { commandLooksLikeSwitchyardd } from '../src/daemon/main.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * claude -p --output-format stream-json の標準出力から、確かめたいことを取り出す。
 * background: Bash の走行が背景に回った(task_started の is_backgrounded、または背景に回ったと告げる tool_result)。
 * foregroundOutput: 前景で走った Bash の tool_result に子の出力(LIVE_JOB=)が直に入っている。
 * @param {string} text
 * @returns {{ background: boolean, foregroundOutput: boolean, blockedStop: boolean, denied: boolean, toolText: string, result: string, costUsd: number | null }}
 */
export function analyzeStream(text) {
  let background = false;
  let foregroundOutput = false;
  let blockedStop = false;
  let denied = false;
  let toolText = '';
  let result = '';
  /** @type {number | null} */
  let costUsd = null;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    /** @type {any} */
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    const s = JSON.stringify(m);
    if (m.type === 'system' && m.subtype === 'task_started' && m.is_backgrounded === true) background = true;
    if (m.type === 'user' && Array.isArray(m.message?.content)) {
      for (const c of m.message.content) {
        if (c?.type !== 'tool_result') continue;
        const body = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
        toolText += `${body}\n`;
        if (/running in background/i.test(body)) background = true;
        else if (body.includes('LIVE_JOB=')) foregroundOutput = true;
        if (body.includes('[switchyard]') && /shims cannot see|shim から見えず/.test(body)) denied = true;
      }
    }
    if (s.includes('ended in a way nobody has looked at yet') || s.includes('まだ確認されていない終わり方がある')) blockedStop = true;
    if (m.type === 'result') {
      result = String(m.result ?? '');
      costUsd = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null;
    }
  }
  return { background, foregroundOutput, blockedStop, denied, toolText, result, costUsd };
}

/** @param {string} home */
export function stopDaemon(home) {
  const lock = pathsOf(home).lock;
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 1) return;
  // この通しが mkdtemp で作った一時の HOME で自動起動したデーモンだけを止める。送るのは lock の pid 1 つだけ(グループには送らない)で、
  // pid の再利用に備えて、デーモンの二重起動防止(acquireLock)と同じ判定で持ち主が switchyardd であることを確かめる
  /** @type {string} */
  let command;
  try {
    command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // lock の pid が既に居ない(ps が終了コード 1 で終わる): 止めるものが無い。投げると走行の結果を上書きする
    return;
  }
  if (!commandLooksLikeSwitchyardd(command)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 確かめた後に終わった
  }
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
  if (process.env.SWITCHYARD_LIVE_CLAUDE !== '1') {
    console.log('本物の Claude Code での通しは SWITCHYARD_LIVE_CLAUDE=1 のときだけ走る(費用が出るため)');
    process.exit(0);
  }
  const work = mkdtempSync(join(tmpdir(), 'clive-'));
  const home = mkdtempSync(join(tmpdir(), 'clh-'));
  execFileSync('git', ['init', '-q'], { cwd: work });
  const script = "console.log('LIVE_JOB=' + (process.env.SWITCHYARD_JOB_ID || 'none')); process.exit(Number(process.env.LIVE_FAIL || 0))";
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'switchyard-live', private: true, scripts: { test: `node -e "${script}"` } }, null, 2));
  // パスで呼ぶビルドの包みの代わり(shim を置けない形)
  writeFileSync(join(work, 'gradlew'), `#!/bin/sh\necho "GRADLE_JOB=\${SWITCHYARD_JOB_ID:-none} $*"\n`, { mode: 0o755 });
  /** @type {NodeJS.ProcessEnv} */
  const baseEnv = { ...process.env, SWITCHYARD_HOME: home, SWITCHYARD_UPDATE_CHECK: '0' };
  delete baseEnv.SWITCHYARD_IN_JOB;
  delete baseEnv.SWITCHYARD_HELD_LOCKS;
  delete baseEnv.SWITCHYARD_JOB_ID;
  // 既定の言語(英語)で確かめる
  delete baseEnv.SWITCHYARD_LANG;
  delete baseEnv.LANG;
  delete baseEnv.LC_ALL;
  delete baseEnv.LC_MESSAGES;

  /** @param {string} prompt @param {string[]} allowed @param {Record<string, string>} [extra] */
  const claude = (prompt, allowed, extra = {}) =>
    spawnSync(
      'claude',
      ['-p', prompt, '--plugin-dir', ROOT, '--setting-sources', 'project', '--model', 'claude-haiku-4-5', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', '0.5', '--no-session-persistence', '--allowedTools', ...allowed],
      { cwd: work, encoding: 'utf8', input: '', timeout: 300_000, env: { ...baseEnv, ...extra } },
    );

  try {
    const records = () => readRecords(pathsOf(home).events).records;
    const r1 = claude('Run the Bash command `npm test` exactly once. Wait until it has finished, then reply with the line of its output that starts with LIVE_JOB=.', ['Bash(npm test)']);
    const a1 = analyzeStream(r1.stdout ?? '');
    const managed = records().some((r) => r.kind === 'history' && r.profile === 'default:batch' && r.code === 0);

    const r2 = claude('Run the Bash command `npm test` exactly once; it is expected to fail. Before you stop, follow any instructions you receive.', ['Bash(npm test)', 'Bash(switchyard ack:*)', 'Bash(switchyard why:*)'], { LIVE_FAIL: '1', SWITCHYARD_STOP: 'block' });
    const a2 = analyzeStream(r2.stdout ?? '');
    const acked = records().some((r) => r.kind === 'event' && typeof r.event === 'object' && r.event !== null && /** @type {Record<string, unknown>} */ (r.event).type === 'ack');

    // 書き換えた後のコマンドで権限を確かめるので、包んだ形を許しておく
    const r3 = claude('Run the Bash command `./gradlew test` exactly once, then reply with the line of its output that starts with GRADLE_JOB=.', ['Bash(switchyard run:*)']);
    const a3 = analyzeStream(r3.stdout ?? '');
    const gradleManaged = records().some((r) => r.kind === 'event' && typeof r.event === 'object' && r.event !== null && JSON.stringify(r.event).includes('gradlew test') && /** @type {Record<string, unknown>} */ (r.event).type === 'request');

    const checks = {
      'shim が npm test を switchyard に通した(記録に default:batch の history)': managed,
      '空いているので前景のまま走った(tool_result に子の出力・背景に回っていない)': a1.foregroundOutput && !a1.background,
      '子にジョブの id が渡った(LIVE_JOB=j…)': /LIVE_JOB=j/.test(a1.toolText),
      '文言は英語(started)': a1.toolText.includes('[switchyard] started'),
      'Stop の差し戻しの後、Claude が switchyard ack した': a2.blockedStop && acked,
      './gradlew test を拒否せずに switchyard run で包んで走らせた(子にジョブの id)': !a3.denied && gradleManaged && /GRADLE_JOB=j/.test(a3.toolText),
    };
    console.log(JSON.stringify({ checks, costUsd: [a1.costUsd, a2.costUsd, a3.costUsd], result1: a1.result, result2: a2.result, result3: a3.result, work, home }, null, 2));
    process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
  } finally {
    stopDaemon(home);
  }
}
