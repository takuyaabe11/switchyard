// @ts-check
// 設計 §13 の V4: spawn(detached) で子が自分のプロセスグループを持つか。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readPgid, signalGroup, spawnInOwnGroup, verifiedGroup, waitGroupGone } from '../../src/run/group.mjs';
import { killGroupLeftovers, pidsInGroup } from '../../testkit/procs.mjs';
import { waitFor } from '../../testkit/wait.mjs';

describe('別グループでの起動(V4)', () => {
  it('子は自分の pid と同じ pgid を持ち、呼び出し元のグループと違う', async () => {
    const child = spawnInOwnGroup(['sleep', '5'], { stdio: 'ignore' });
    const pid = /** @type {number} */ (child.pid);
    try {
      const own = readPgid(process.pid);
      assert.notEqual(own, null);
      assert.equal(verifiedGroup(pid), pid);
      assert.notEqual(pid, own);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('SIGSTOP で出力が止まり、SIGCONT で再開し、SIGTERM で終わる', async () => {
    const child = spawnInOwnGroup([process.execPath, '-e', 'setInterval(() => process.stdout.write("."), 10)'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = /** @type {number} */ (child.pid);
    let dots = 0;
    child.stdout?.on('data', (b) => {
      dots += String(b).length;
    });
    try {
      await waitFor(() => dots > 3);
      assert.equal(signalGroup(pid, 'SIGSTOP'), true);
      await new Promise((r) => setTimeout(r, 100));
      const frozen = dots;
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(dots, frozen);
      signalGroup(pid, 'SIGCONT');
      await waitFor(() => dots > frozen + 3);
      const exited = new Promise((resolve) => child.once('exit', (code, sig) => resolve(sig)));
      signalGroup(pid, 'SIGTERM');
      assert.equal(await exited, 'SIGTERM');
    } finally {
      // 途中で落ちても、止めたままの子や走り続ける子を残さない
      killGroupLeftovers(pid);
    }
  });

  it('孫プロセスも同じグループに入り、グループへの SIGTERM で一緒に終わる', async () => {
    const child = spawnInOwnGroup(['sh', '-c', 'sleep 30 & sleep 30 & wait'], { stdio: 'ignore' });
    const pid = /** @type {number} */ (child.pid);
    try {
      await waitFor(() => pidsInGroup(pid).length >= 3);
      signalGroup(pid, 'SIGTERM');
      await waitFor(() => pidsInGroup(pid).length === 0);
    } finally {
      killGroupLeftovers(pid);
    }
  });

  it('自分のグループ・1 以下・自分の pgid が読めないときは送らない', () => {
    const own = /** @type {number} */ (readPgid(process.pid));
    assert.throws(() => signalGroup(own, 'SIGSTOP'), /自分のプロセスグループ/);
    assert.throws(() => signalGroup(1, 'SIGTERM'), /不正な pgid/);
    assert.throws(() => signalGroup(0, 'SIGTERM'), /不正な pgid/);
    assert.throws(() => signalGroup(99999, 'SIGTERM', null), /読めない/);
  });

  it('waitGroupGone はグループが消えたら true、時間内に消えなければ false', async () => {
    const quick = spawnInOwnGroup(['sleep', '0.1'], { stdio: 'ignore' });
    assert.equal(await waitGroupGone(/** @type {number} */ (quick.pid), 2_000), true);
    const stubborn = spawnInOwnGroup(['sleep', '5'], { stdio: 'ignore' });
    const pid = /** @type {number} */ (stubborn.pid);
    try {
      assert.equal(await waitGroupGone(pid, 100), false);
    } finally {
      signalGroup(pid, 'SIGKILL');
    }
  });

  it('終わったグループへの信号は false', async () => {
    const child = spawnInOwnGroup(['true'], { stdio: 'ignore' });
    const pid = /** @type {number} */ (child.pid);
    await new Promise((resolve) => child.once('exit', resolve));
    await waitFor(() => pidsInGroup(pid).length === 0);
    assert.equal(signalGroup(pid, 'SIGTERM'), false);
  });
});
