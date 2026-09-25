#!/usr/bin/env node
// @ts-check
// 本物の Claude Code での通し(設計 §15)。費用が出るので SWITCHYARD_LIVE_CLAUDE=1 のときだけ走る。
// 使い捨ての作業場所と一時の SWITCHYARD_HOME で、この repo を --plugin-dir として haiku に 3 回走らせる:
//   1. 成功する npm test: shim が switchyard に通し(記録に default:batch)、空いているので前景のまま走り、子にジョブの id が渡り、文言は英語
//   2. 失敗する npm test: Stop が差し戻し(SWITCHYARD_STOP=block)、Claude が switchyard ack で確認済みにする
//   3. ./gradlew test: shim から見えないので PreToolUse が switchyard run -- で包む形に書き換え、拒否せずにそのまま走る
//      (許すのは包んだ形 1 つだけ: Bash(switchyard run -- ./gradlew test))
//   4. Bash(switchyard run:*) と広く許していても、中身が重い走行の形でない switchyard run は承認を求められ、-p では走らない
//   5. 1 本のセッションでも起きる事故: ポートが使用中で落ちたら握っているプロセスを Claude に伝え(PostToolUseFailure)、
//      Bash の時間切れで切られたコマンドは覚えて、次に同じコマンドが走るとき時間切れを延ばす(PreToolUse)
//   6. 前景で待つループ(sleep を含む for)は背景へ回り、Bash の時間切れ(30 秒)で切られずに最後まで走る
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
 * commands: Claude が Bash に渡したコマンド(hook が書き換える前)。
 * @returns {{ background: boolean, foregroundOutput: boolean, blockedStop: boolean, denied: boolean, commands: string[], toolText: string, result: string, costUsd: number | null }}
 */
export function analyzeStream(text) {
  let background = false;
  let foregroundOutput = false;
  let blockedStop = false;
  let denied = false;
  /** @type {string[]} */
  const commands = [];
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
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const c of m.message.content) if (c?.type === 'tool_use' && c.name === 'Bash' && typeof c.input?.command === 'string') commands.push(c.input.command);
    }
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
  return { background, foregroundOutput, blockedStop, denied, commands, toolText, result, costUsd };
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

  /** @param {string} prompt @param {string[]} allowed @param {Record<string, string>} [extra] @param {string[]} [args] */
  const claude = (prompt, allowed, extra = {}, args = []) =>
    spawnSync(
      'claude',
      ['-p', prompt, '--plugin-dir', ROOT, '--setting-sources', 'project', '--model', 'claude-haiku-4-5', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', '0.5', '--no-session-persistence', ...args, '--allowedTools', ...allowed],
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

    // 書き換えた後のコマンドで権限を確かめるので、包んだ形を許しておく(広い switchyard run:* ではなく、その形だけ)
    const r3 = claude('Run the Bash command `./gradlew test` exactly once, then reply with the line of its output that starts with GRADLE_JOB=.', ['Bash(switchyard run -- ./gradlew test)']);
    const a3 = analyzeStream(r3.stdout ?? '');
    const gradleManaged = records().some((r) => r.kind === 'event' && typeof r.event === 'object' && r.event !== null && JSON.stringify(r.event).includes('gradlew test') && /** @type {Record<string, unknown>} */ (r.event).type === 'request');

    const marker = join(work, 'unvetted.txt');
    const r4 = claude("Run the Bash command `switchyard run -- touch unvetted.txt` exactly once. Do not run anything else. Then reply DONE.", ['Bash(switchyard run:*)']);
    const a4 = analyzeStream(r4.stdout ?? '');
    const unvettedRan = existsSync(marker);

    // ポートを握るサーバーを先に立てておく(この作業で前に起動したものの残りの代わり)
    const holder = spawn(process.execPath, ['-e', "const s=require('http').createServer().listen(0,()=>console.log(s.address().port)); setTimeout(()=>{}, 300000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    const port = await new Promise((resolve) => holder.stdout?.once('data', (d) => resolve(Number(String(d).trim()))));
    /** @type {ReturnType<typeof analyzeStream>} */
    let a5;
    try {
      const r5 = claude(
        `Run exactly these Bash commands one at a time, each as its own Bash tool call. Do not retry, fix or investigate anything. (1) node -e "require('http').createServer().listen(${port})"  (2) sleep 5 -- with the Bash tool timeout parameter set to 3000  (3) sleep 5 -- again with the timeout parameter set to 3000. After all three, quote verbatim every line starting with [switchyard] that you saw, then write DONE.`,
        ['Bash(node:*)', 'Bash(sleep 5)'],
      );
      a5 = analyzeStream(r5.stdout ?? '');
    } finally {
      holder.kill('SIGKILL');
    }
    const hooks = existsSync(pathsOf(home).hooks) ? readRecords(pathsOf(home).hooks).records : [];
    const portTraced = hooks.some((r) => r.decision === 'port' && r.port === port && Number(r.holders) >= 1) && a5.result.includes(`pid ${holder.pid}`);
    const extended = hooks.some((r) => r.decision === 'timeout') && hooks.some((r) => r.decision === 'extend' && r.timeoutMs === 6000);
    const lastFinished = (a5.toolText.match(/Command timed out after/g) ?? []).length === 1;

    const r6 = claude(
      'Run this exact Bash command once in the foreground (do not set run_in_background yourself), with the Bash tool timeout parameter set to 30000: for i in $(seq 1 13); do sleep 5; done; echo WAITED_DONE  -- Do not change the command. If it ends up running in the background, use the tool that reads a background task\'s output and block until the task has finished (do not end your turn before that). Then reply with its last output line.',
      // Claude Code は複合コマンドを単純コマンドごとに許可を確かめるので、中の seq・sleep・echo を許す
      ['Bash(seq:*)', 'Bash(sleep:*)', 'Bash(echo:*)', 'BashOutput', 'TaskOutput'],
    );
    const a6 = analyzeStream(r6.stdout ?? '');
    const hooks6 = existsSync(pathsOf(home).hooks) ? readRecords(pathsOf(home).hooks).records : [];
    const waitBackgrounded = hooks6.some((r) => r.decision === 'wait-background' && r.estimateMs === 65_000) && a6.background && !/Command timed out after/.test(a6.toolText) && a6.result.includes('WAITED_DONE');

    const r7 = claude(
      'Run this exact Bash command once, as given: npm test > live.log 2>&1 &  -- Do not change the command and do not set run_in_background yourself. When it has finished, read live.log and reply with its line that starts with LIVE_JOB=.',
      ['Bash(npm test:*)', 'Bash(cat:*)', 'Read', 'BashOutput', 'TaskOutput'],
      {},
      // > live.log はファイルへの書き込みなので承認を求められる(& を外す前の形でも同じ)。作業場所への書き込みだけ許す
      ['--permission-mode', 'acceptEdits'],
    );
    const a7 = analyzeStream(r7.stdout ?? '');
    const hooks7 = existsSync(pathsOf(home).hooks) ? readRecords(pathsOf(home).hooks).records : [];
    const ampBackgrounded = hooks7.some((r) => r.decision === 'amp-background') && a7.background && /LIVE_JOB=j/.test(a7.result);

    const checks = {
      'shim が npm test を switchyard に通した(記録に default:batch の history)': managed,
      '空いているので前景のまま走った(tool_result に子の出力・背景に回っていない)': a1.foregroundOutput && !a1.background,
      '子にジョブの id が渡った(LIVE_JOB=j…)': /LIVE_JOB=j/.test(a1.toolText),
      '文言は英語(started)': a1.toolText.includes('[switchyard] started'),
      'Stop の差し戻しの後、Claude が switchyard ack した': a2.blockedStop && acked,
      './gradlew test を拒否せずに switchyard run で包んで走らせた(子にジョブの id)': !a3.denied && gradleManaged && /GRADLE_JOB=j/.test(a3.toolText),
      'switchyard run:* を許していても、中身が重い走行でない包みは走らなかった(Claude は実際に試した)': a4.commands.some((c) => c.includes('switchyard run -- touch unvetted.txt')) && !unvettedRan,
      'ポートが使用中で落ちたら、握っているプロセス(pid)が Claude に届いた': portTraced,
      '時間切れで切られたコマンドを覚え、次は時間切れを倍に延ばして走り切った': extended && lastFinished,
      '前景で待つループは背景へ回り、時間切れで切られずに最後まで走った': waitBackgrounded,
      '最後の & で裏に回した npm test は、& を外して背景実行になり、switchyard を通って終わった': ampBackgrounded,
    };
    console.log(JSON.stringify({ checks, costUsd: [a1.costUsd, a2.costUsd, a3.costUsd, a4.costUsd, a5.costUsd, a6.costUsd, a7.costUsd], result7: a7.result, commands7: a7.commands, result6: a6.result, result1: a1.result, result2: a2.result, result3: a3.result, result4: a4.result, result5: a5.result, work, home }, null, 2));
    process.exitCode = Object.values(checks).every(Boolean) ? 0 : 1;
  } finally {
    stopDaemon(home);
  }
}
