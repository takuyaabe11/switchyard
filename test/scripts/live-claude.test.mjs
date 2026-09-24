// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyzeStream, stopDaemon } from '../../scripts/live-claude.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { tempHome } from '../../testkit/tmp.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/live-claude.mjs', import.meta.url));

describe('live-claude(設計 §15)', () => {
  it('stream-json から、背景に回ったか・前景の出力・Stop の差し戻し・拒否・結果・費用を取り出す', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'system', subtype: 'task_started', is_backgrounded: false }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '[switchyard] started j1 (CPU 2)\nLIVE_JOB=j1' }] } }),
      '壊れた行',
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '[switchyard] the shims cannot see this, so it would skip the queue: ./gradlew test.' }] } }),
      JSON.stringify({ type: 'system', subtype: 'hook_response', output: '[switchyard] jobs in this session ended in a way nobody has looked at yet:' }),
      JSON.stringify({ type: 'result', result: 'LIVE_JOB=j1', total_cost_usd: 0.012 }),
    ];
    const a = analyzeStream(lines.join('\n'));
    assert.deepEqual([a.background, a.foregroundOutput, a.blockedStop, a.denied, a.result, a.costUsd], [false, true, true, true, 'LIVE_JOB=j1', 0.012]);
    assert.match(a.toolText, /\[switchyard\] started/);
  });

  it('背景に回ったことは、task_started の is_backgrounded と、背景に回ったと告げる tool_result の両方で見る', () => {
    assert.equal(analyzeStream(JSON.stringify({ type: 'system', subtype: 'task_started', is_backgrounded: true })).background, true);
    const msg = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Command running in background with ID: b1' }] } });
    assert.deepEqual([analyzeStream(msg).background, analyzeStream(msg).foregroundOutput], [true, false]);
  });

  it('何も無ければすべて偽', () => {
    assert.deepEqual(analyzeStream(''), { background: false, foregroundOutput: false, blockedStop: false, denied: false, commands: [], toolText: '', result: '', costUsd: null });
    const use = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'switchyard run -- echo hi' } }] } });
    assert.deepEqual(analyzeStream(use).commands, ['switchyard run -- echo hi']);
  });

  it('後始末: daemon.lock の pid が既に居なければ、何もせずに終わる(投げない)', () => {
    const home = tempHome();
    // 走り終えたプロセスの pid(もう居ない)
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(pathsOf(home).lock, String(gone));
    assert.doesNotThrow(() => stopDaemon(home));
  });

  it('SWITCHYARD_LIVE_CLAUDE=1 でなければ、何もせずに終わる(費用を出さない)', () => {
    const env = { ...process.env };
    delete env.SWITCHYARD_LIVE_CLAUDE;
    assert.match(execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', env }), /SWITCHYARD_LIVE_CLAUDE=1 のときだけ走る/);
  });
});
