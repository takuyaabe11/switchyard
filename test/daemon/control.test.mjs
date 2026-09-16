// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { answers, commandLooksLikeSwitchyardd, lockPid, stopDaemon } from '../../src/daemon/control.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { tempHome } from '../../testkit/tmp.mjs';

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** @param {string} home */
async function daemon(home) {
  const d = await startDaemon({ home, capacity: 4, tickMs: 20, idleExitMs: null });
  cleanups.push(() => d.close());
  return d;
}

describe('stopDaemon(switchyard stop / restart)', () => {
  it('デーモンが居なければ、止めずにそう言う', async () => {
    const home = tempHome();
    const r = await stopDaemon({ home });
    assert.deepEqual([r.stopped, r.pid], [false, null]);
    assert.match(r.reason, /動いていない/);
  });

  it('応答しているのに持ち主の pid が読めなければ、信号を送らない', async () => {
    const home = tempHome();
    await daemon(home);
    let signalled = 0;
    const r = await stopDaemon({ home, signal: () => { signalled += 1; } });
    assert.deepEqual([r.stopped, r.pid, signalled], [false, null, 0]);
    assert.match(r.reason, /pid を/);
  });

  it('持ち主が switchyardd でなければ、信号を送らない(pid の使い回し。I1)', async () => {
    const home = tempHome();
    await daemon(home);
    writeFileSync(pathsOf(home).lock, String(process.pid));
    let signalled = 0;
    const r = await stopDaemon({ home, isDaemon: () => false, signal: () => { signalled += 1; } });
    assert.deepEqual([r.stopped, signalled], [false, 0]);
    assert.match(r.reason, /switchyardd ではない/);
  });

  it('生きているデーモンへ信号を送り、応答しなくなるまで待つ', async () => {
    const home = tempHome();
    const d = await daemon(home);
    writeFileSync(pathsOf(home).lock, String(process.pid));
    assert.equal(await answers(d.sock), true);
    // 信号の代わりに、このプロセスの中のデーモンを閉じる(SIGTERM を受けた switchyardd と同じ形)
    const r = await stopDaemon({ home, isDaemon: () => true, signal: () => { void d.close(); } });
    assert.equal(r.stopped, true, r.reason);
    assert.equal(r.pid, process.pid);
    assert.equal(await answers(d.sock), false);
  });

  it('止まらなければ、時間切れとして失敗を返す', async () => {
    const home = tempHome();
    const d = await daemon(home);
    writeFileSync(pathsOf(home).lock, String(process.pid));
    const r = await stopDaemon({ home, isDaemon: () => true, signal: () => {}, timeoutMs: 60, stepMs: 10 });
    assert.deepEqual([r.stopped, r.pid], [false, process.pid]);
    assert.match(r.reason, /止まらない/);
    assert.equal(await answers(d.sock), true, 'デーモンは残っている');
  });
});

describe('lockPid', () => {
  it('数でなければ null', () => {
    const home = tempHome();
    const lock = pathsOf(home).lock;
    assert.equal(lockPid(lock), null, '無いファイル');
    writeFileSync(lock, 'abc');
    assert.equal(lockPid(lock), null);
    writeFileSync(lock, '0');
    assert.equal(lockPid(lock), null);
    writeFileSync(lock, ' 4321 \n');
    assert.equal(lockPid(lock), 4321);
  });
});

describe('commandLooksLikeSwitchyardd(control.mjs へ移した後も同じ)', () => {
  it('語の basename で見分ける', () => {
    assert.equal(commandLooksLikeSwitchyardd('node /x/bin/switchyardd.mjs'), true);
    assert.equal(commandLooksLikeSwitchyardd('/usr/bin/env node /x/bin/switchyardd'), true);
    assert.equal(commandLooksLikeSwitchyardd('vim notes-about-switchyardd.txt'), false);
  });
});
