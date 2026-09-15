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
  it('stream-json から、背景に回ったこと・Stop の差し戻し・結果・費用を取り出す', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Command running in background with ID: b1' }] } }),
      '壊れた行',
      JSON.stringify({ type: 'user', message: { content: '[conductor] このセッションのジョブに、まだ確認されていない終わり方がある:' } }),
      JSON.stringify({ type: 'result', result: 'LIVE_JOB=j123', total_cost_usd: 0.012 }),
    ];
    assert.deepEqual(analyzeStream(lines.join('\n')), { background: true, blockedStop: true, result: 'LIVE_JOB=j123', costUsd: 0.012 });
  });

  it('何も無ければすべて偽', () => {
    assert.deepEqual(analyzeStream(''), { background: false, blockedStop: false, result: '', costUsd: null });
  });

  it('後始末: daemon.lock の pid が既に居なければ、何もせずに終わる(投げない)', () => {
    const home = tempHome();
    // 走り終えたプロセスの pid(もう居ない)
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(pathsOf(home).lock, String(gone));
    assert.doesNotThrow(() => stopDaemon(home));
  });

  it('CONDUCTOR_LIVE_CLAUDE=1 でなければ、何もせずに終わる(費用を出さない)', () => {
    const env = { ...process.env };
    delete env.CONDUCTOR_LIVE_CLAUDE;
    assert.match(execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', env }), /CONDUCTOR_LIVE_CLAUDE=1 のときだけ走る/);
  });
});
