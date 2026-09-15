// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeStream } from '../../scripts/live-claude.mjs';

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

  it('CONDUCTOR_LIVE_CLAUDE=1 でなければ、何もせずに終わる(費用を出さない)', () => {
    const env = { ...process.env };
    delete env.CONDUCTOR_LIVE_CLAUDE;
    assert.match(execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', env }), /CONDUCTOR_LIVE_CLAUDE=1 のときだけ走る/);
  });
});
