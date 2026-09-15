// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probe } from '../../src/run/probe.mjs';
import { waitFor } from '../../testkit/wait.mjs';

/** @param {number} pid */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('probe', () => {
  it('グループから抜けないコマンドでは、何も報告しない', async () => {
    const r = await probe({ argv: ['sh', '-c', 'sleep 30 & sleep 30 & wait'], seconds: 0.5, intervalMs: 50, graceMs: 1_000 });
    assert.deepEqual([r.escaped, r.survivors], [[], []]);
    assert.ok(r.seen >= 3, `seen ${r.seen}`);
  });

  it('setsid してグループから抜ける子を検出し、SIGTERM の後の生き残りとして出し、片付ける', async () => {
    const r = await probe({ argv: ['sh', '-c', 'perl -e "use POSIX; POSIX::setsid(); sleep 30" & sleep 30 & wait'], seconds: 0.5, intervalMs: 50, graceMs: 1_000 });
    assert.deepEqual(r.escaped, [{ comm: 'perl', count: 1 }]);
    assert.deepEqual(r.survivors.map((s) => [s.comm, s.inGroup]), [['perl', false]]);
    await waitFor(() => !alive(r.survivors[0].pid));
  });
});
