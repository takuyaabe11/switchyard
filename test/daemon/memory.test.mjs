// @ts-check
// デーモンのメモリを見た受け入れの通し(RSS の標本 → ピークの記録 → 次の要求の見込み → 待たせる)。
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { openClient } from '../../testkit/client.mjs';
import { jobRequest } from '../../testkit/requests.mjs';
import { tempHome } from '../../testkit/tmp.mjs';

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** @param {{ memory: boolean, home?: string, availableMb: () => number, rssOf: () => number }} o */
async function setup({ memory, home = tempHome(), availableMb, rssOf }) {
  const d = await startDaemon({
    home, capacity: 8, tickMs: 60_000, heartbeatTimeoutMs: 600_000, recoveryGraceMs: 10_000, idleExitMs: null,
    memory, memFloorMb: 1000, memSampleMs: 20, readAvailableMb: availableMb,
    readRss: async () => new Map([[4242, rssOf()], [4343, rssOf()]]),
  });
  cleanups.push(() => d.close());
  return { d, home };
}

/** @param {string} sock */
async function client(sock) {
  const c = await openClient(sock);
  cleanups.push(() => c.close());
  return c;
}

describe('daemon: メモリを見た受け入れ', () => {
  it('走行中のピークの RSS を測って記録に残し、次の同じ走行の要求に見込みとして載せる', async () => {
    let rssMb = 300;
    const { d, home } = await setup({ memory: true, availableMb: () => 10_000, rssOf: () => rssMb });
    const a = await client(d.sock);
    a.send({ t: 'request', job: jobRequest({ profile: 'e2e' }) });
    const g = await a.next((m) => m.t === 'grant');
    a.send({ t: 'started', jobId: g.jobId, pid: process.pid, pgid: 4242 });
    rssMb = 2_400;
    await new Promise((r) => setTimeout(r, 150));
    rssMb = 800;
    await new Promise((r) => setTimeout(r, 150));
    a.send({ t: 'exit', jobId: g.jobId, code: 0, durationMs: 10_000, cpuMs: 1_000 });
    await a.next((m) => m.t === 'ok');
    const history = readFileSync(pathsOf(home).events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'history');
    assert.equal(history[0].peakMemMb, 2_400);
    const b = await client(d.sock);
    b.send({ t: 'request', job: jobRequest({ profile: 'e2e' }) });
    const acc = await b.next((m) => m.t === 'accepted');
    await b.next((m) => m.t === 'grant');
    assert.equal(d.getState().leases.find((l) => l.job.id === acc.jobId)?.job.memMb, 2_400);
  });

  it('見込みのピークを重ねると空きメモリが下限を割るなら、走行が終わる(か空きが戻る)まで待たせる', async () => {
    let availableMb = 3_000;
    const home = tempHome();
    // 1 回目: ピーク 2400MB を学ぶ(何も走っていないので入る)
    {
      const { d } = await setup({ memory: true, home, availableMb: () => availableMb, rssOf: () => 2_400 });
      const a = await client(d.sock);
      a.send({ t: 'request', job: jobRequest({ profile: 'e2e' }) });
      const g = await a.next((m) => m.t === 'grant');
      a.send({ t: 'started', jobId: g.jobId, pid: process.pid, pgid: 4242 });
      await new Promise((r) => setTimeout(r, 100));
      a.send({ t: 'exit', jobId: g.jobId, code: 0, durationMs: 10_000, cpuMs: 1_000 });
      await a.next((m) => m.t === 'ok');
      await d.close();
    }
    const { d } = await setup({ memory: true, home, availableMb: () => availableMb, rssOf: () => 100 });
    const a = await client(d.sock);
    a.send({ t: 'request', job: jobRequest({ profile: 'other' }) });
    const ga = await a.next((m) => m.t === 'grant');
    a.send({ t: 'started', jobId: ga.jobId, pid: process.pid, pgid: 4343 });
    const b = await client(d.sock);
    b.send({ t: 'request', job: jobRequest({ profile: 'e2e' }) });
    const q = await b.next((m) => m.t === 'queued');
    assert.match(String(q.reason), /^メモリ不足/);
    // 空きが戻れば、次の標本の後に入れる
    availableMb = 6_000;
    await b.next((m) => m.t === 'grant', 3_000);
  });

  it('メモリを見ない(startDaemon の既定)なら、見込みを載せず待たせない', async () => {
    const { d } = await setup({ memory: false, availableMb: () => 0, rssOf: () => 9_999 });
    const a = await client(d.sock);
    a.send({ t: 'request', job: jobRequest({}) });
    const g = await a.next((m) => m.t === 'grant');
    a.send({ t: 'started', jobId: g.jobId, pid: process.pid, pgid: 4242 });
    const b = await client(d.sock);
    b.send({ t: 'request', job: jobRequest({}) });
    await b.next((m) => m.t === 'grant');
  });
});
