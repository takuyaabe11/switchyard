// @ts-check
// 前景で待つループを背景へ回す(src/hooks/waitloop.mjs・hook の入口・PreToolUse の sh のふるい・replay)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROFILES } from '../../src/config/profiles.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { runHook } from '../../src/hooks/main.mjs';
import { backgroundWaitLoop, loopIterations, sleepSeconds, waitLoopOf } from '../../src/hooks/waitloop.mjs';
import { formatReport, replay } from '../../src/replay/replay.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('waitLoopOf(前景で待つ形と、どれだけ待ちうるか)', () => {
  it('利用者の記録で時間切れになった形は、背景へ回す', () => {
    for (const c of [
      'until grep -q "EXIT=" .probe/push-run12.log 2>/dev/null; do sleep 25; done; echo "=== 終わった ==="',
      'export LC_ALL=C; cd /w/irc-idb; n=0; while [ $n -lt 36 ]; do sleep 25; n=$((n+1)); H=$(git rev-parse --short HEAD); done',
      'for i in $(seq 1 100); do sleep 5; done; git -C /w/irc-cov log --oneline -1',
      'cd /w/x && for i in $(seq 1 110); do n=$(git log --oneline -1 | cut -c1-8); if [ "$n" != "3c9c" ]; then break; fi; sleep 10; done',
    ]) {
      const w = waitLoopOf(c);
      assert.ok(w.wait && w.background, c);
    }
  });

  it('回数 × sleep を見積もり、1 分以下のループは前景のまま', () => {
    assert.deepEqual(waitLoopOf('for i in $(seq 1 3); do sleep 2; done'), { wait: true, estimateMs: 6000, background: false });
    assert.deepEqual(waitLoopOf('for i in $(seq 1 13); do sleep 5; done'), { wait: true, estimateMs: 65_000, background: true });
    assert.deepEqual(waitLoopOf('n=0; while [ $n -lt 36 ]; do sleep 25; n=$((n+1)); done'), { wait: true, estimateMs: 900_000, background: true });
    assert.deepEqual(waitLoopOf('for ((i=0; i<20; i++)); do sleep 10; done'), { wait: true, estimateMs: 200_000, background: true });
    assert.deepEqual(waitLoopOf('for i in 1 2 3; do sleep 30; done'), { wait: true, estimateMs: 90_000, background: true });
    assert.deepEqual(waitLoopOf('for i in {1..4}; do sleep 1m; done'), { wait: true, estimateMs: 240_000, background: true });
  });

  it('回数の決まらないループは、1 回の sleep が 5 秒以上なら背景へ(サーバーの立ち上がりを 1 秒ずつ待つ形は前景のまま)', () => {
    assert.deepEqual(waitLoopOf('until grep -q done a.log; do sleep 25; done'), { wait: true, estimateMs: null, background: true });
    assert.deepEqual(waitLoopOf('until curl -sf localhost:3000; do sleep 1; done'), { wait: true, estimateMs: null, background: false });
  });

  it('抜け道の無い無限ループ・tail -f・watch は背景へ回さない(誰も止めないまま走り続ける)', () => {
    assert.deepEqual(waitLoopOf('while true; do date; sleep 30; done'), { wait: true, estimateMs: null, background: false });
    assert.deepEqual(waitLoopOf('while :; do sleep 30; done'), { wait: true, estimateMs: null, background: false });
    // break があれば終わりうる
    assert.deepEqual(waitLoopOf('while true; do if grep -q ok a; then break; fi; sleep 30; done'), { wait: true, estimateMs: null, background: true });
    assert.deepEqual(waitLoopOf('tail -f logs/app.log'), { wait: false });
    assert.deepEqual(waitLoopOf('watch -n 5 kubectl get pods'), { wait: false });
  });

  it('sleep だけは秒数で決め、gh run watch は背景へ。heredoc の本文や引用の中のループは待つ形ではない', () => {
    assert.deepEqual(waitLoopOf('sleep 300'), { wait: true, estimateMs: 300_000, background: true });
    assert.deepEqual(waitLoopOf('sleep 5'), { wait: true, estimateMs: 5000, background: false });
    assert.deepEqual(waitLoopOf('gh run watch 123'), { wait: true, estimateMs: null, background: true });
    assert.deepEqual(waitLoopOf("cat > poll.sh <<'EOF'\nuntil grep -q done a.log; do sleep 25; done\nEOF\nchmod +x poll.sh"), { wait: false });
    assert.deepEqual(waitLoopOf('echo "until x; do sleep 25; done"'), { wait: false });
    assert.deepEqual(waitLoopOf('for f in src/*.ts; do npx tsc --noEmit "$f"; done'), { wait: false });
    assert.deepEqual(waitLoopOf('npm test'), { wait: false });
  });

  it('sleep の秒数と、ループの回数の読み方', () => {
    assert.deepEqual(['2', '0.5', '2s', '3m', '1h', 'x'].map(sleepSeconds), [2, 0.5, 2, 180, 3600, null]);
    assert.equal(loopIterations('for i in $(seq 5 9); do'), 5);
    assert.equal(loopIterations('for i in $(seq 12); do'), 12);
    assert.equal(loopIterations('for i in {3..1}; do'), 3);
    assert.equal(loopIterations('for ((i=1;i<=4;i++)); do'), 4);
    assert.equal(loopIterations('while [[ $n -le 9 ]]; do'), 10);
    assert.equal(loopIterations('until false; do'), null);
  });
});

describe('backgroundWaitLoop(背景へ回す書き換え)', () => {
  const loop = 'until grep -q done a.log; do sleep 25; done';
  it('背景へ回し、背景では効かない timeout を外す。他の書き換えの上に重ねる', () => {
    assert.deepEqual(backgroundWaitLoop({ command: loop, timeout: 600_000, description: 'd' }, null, {}).out, {
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: loop, description: 'd', run_in_background: true } },
    });
    const wrapped = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: `cd x; ${loop}`, timeout: 240_000 } } };
    assert.deepEqual(backgroundWaitLoop({ command: 'x' }, wrapped, {}).out, { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: `cd x; ${loop}`, run_in_background: true } } });
  });

  it('拒否する呼び出し・もう背景の呼び出し・待つ形でない呼び出し・SWITCHYARD_WAIT_LOOPS=0 は触らない', () => {
    const deny = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' } };
    assert.equal(backgroundWaitLoop({ command: loop }, deny, {}).out, deny);
    assert.equal(backgroundWaitLoop({ command: loop, run_in_background: true }, null, {}).out, null);
    assert.equal(backgroundWaitLoop({ command: 'npm test' }, null, {}).out, null);
    assert.equal(backgroundWaitLoop({ command: loop }, null, { SWITCHYARD_WAIT_LOOPS: '0' }).out, null);
    assert.equal(backgroundWaitLoop({ command: 'for i in $(seq 1 3); do sleep 2; done' }, null, {}).applied, false);
  });
});

describe('hook の入口・sh のふるい・replay', () => {
  /** @param {string} command @param {string} cwd */
  const pre = (command, cwd) => JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

  it('runHook は待つループを背景へ回し、hooks.jsonl に wait-background と見積もりを残す', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cwl-'));
    const cwd = mkdtempSync(join(tmpdir(), 'cwlcwd-'));
    /** @type {string[]} */
    const out = [];
    await runHook('pre-tool-use', pre('for i in $(seq 1 20); do sleep 10; done', cwd), { env: { SWITCHYARD_HOME: home }, profilesFor: () => DEFAULT_PROFILES, write: (s) => out.push(s) });
    assert.deepEqual(JSON.parse(out[0]), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'for i in $(seq 1 20); do sleep 10; done', run_in_background: true } } });
    const rows = readFileSync(pathsOf(home).hooks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => [r.decision, r.estimateMs]), [['wait-background', 200_000]]);
    // 観察だけのモードでは何もしない
    out.length = 0;
    await runHook('pre-tool-use', pre('until grep -q x a; do sleep 25; done', cwd), { env: { SWITCHYARD_HOME: home, SWITCHYARD_OBSERVE: '1' }, profilesFor: () => DEFAULT_PROFILES, write: (s) => out.push(s) });
    assert.equal(out.length, 0);
  });

  it('PreToolUse の sh のふるいは、待つ形を node の判定へ回す(SWITCHYARD_WAIT_LOOPS=0 なら回さない)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cwlcwd-'));
    const awk = join(ROOT, 'bin/switchyard-pretooluse.awk');
    const skips = (/** @type {string} */ command, /** @type {Record<string, string>} */ env = {}) =>
      spawnSync('awk', ['-f', awk], { input: pre(command, cwd), env: { PATH: process.env.PATH ?? '', SWITCHYARD_HOME: mkdtempSync(join(tmpdir(), 'cwl-')), ...env } }).status === 0;
    assert.equal(skips('until grep -q done a.log; do sleep 25; done'), false);
    assert.equal(skips('for i in $(seq 1 100); do sleep 5; done'), false);
    assert.equal(skips('sleep 300'), false);
    assert.equal(skips('gh run watch 1'), false);
    assert.equal(skips('ls -la'), true);
    assert.equal(skips('echo sleeping'), true);
    assert.equal(skips('until grep -q done a.log; do sleep 25; done', { SWITCHYARD_WAIT_LOOPS: '0' }), true);
  });

  it('replay は、今の設定なら背景へ回した待つループを数える', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwlr-'));
    mkdirSync(join(dir, 'p'));
    const line = (/** @type {string} */ id, /** @type {string} */ command, bg = false) =>
      JSON.stringify({ type: 'assistant', cwd: '/w', timestamp: '2026-09-10T00:00:00.000Z', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command, ...(bg ? { run_in_background: true } : {}) } }] } });
    writeFileSync(join(dir, 'p', 's.jsonl'), `${[line('a', 'until grep -q x a; do sleep 25; done'), line('b', 'until grep -q x a; do sleep 25; done', true), line('c', 'sleep 2'), line('d', 'ls')].join('\n')}\n`);
    const r = await replay({ dir, cwdPrefix: null, since: null, profilesFor: () => DEFAULT_PROFILES, examples: 3 });
    assert.equal(r.hook.waitLoops, 1);
    assert.match(formatReport(r, { cwdPrefix: null, sinceDays: null, examples: 3 }), /前景で待つループを背景へ回す\(上と重なる\): 1 件\(25\.0%\)/);
  });
});
