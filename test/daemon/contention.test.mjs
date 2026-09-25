// @ts-check
// デーモンが走行ごとに他の処理の負荷を測って記録に残し、記録から学んだ遅れの倍率でジョブを待たせないかを決める通し。
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { ensurePrivateDir } from '../../src/daemon/paths.mjs';
import { openClient } from '../../testkit/client.mjs';
import { jobRequest } from '../../testkit/requests.mjs';
import { tempHome } from '../../testkit/tmp.mjs';

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** @param {string} home */
const historyOf = (home) =>
  readFileSync(pathsOf(home).events, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === 'history');

describe('daemon: 重なりによる遅れを学ぶ', () => {
  /**
   * 時計を 100 倍に進め(実時間 20ms の標本 = 2 秒)、機械全体が busyCores コア忙しい作り物にする。
   * 1 本を走らせて、所要 6 秒・CPU 時間 6 秒(平均 1 コア)で終わらせる。
   * @param {number} busyCores @param {{ tickMs?: number, durationMs?: number }} [o]
   */
  async function runOnce(busyCores, { tickMs = 60_000, durationMs = 6_000 } = {}) {
    const home = tempHome();
    const t0 = Date.now();
    const mono = () => (Date.now() - t0) * 100;
    const d = await startDaemon({ home, capacity: 4, cores: 4, tickMs, heartbeatTimeoutMs: 600_000, idleExitMs: null, overcommit: true, sampleMs: 20, readBusyMs: () => mono() * busyCores, monoNow: mono });
    cleanups.push(() => d.close());
    const c = await openClient(d.sock);
    cleanups.push(async () => c.close());
    c.send({ t: 'request', job: jobRequest({ repo: '/r', profile: 'unit' }) });
    const g = await c.next((m) => m.t === 'grant');
    c.send({ t: 'started', jobId: g.jobId, pid: process.pid, pgid: null });
    // 標本が 6 秒分(実時間 60ms)以上たまるまで走らせる
    await new Promise((r) => setTimeout(r, 150));
    c.send({ t: 'exit', jobId: g.jobId, code: 0, killedByCaller: false, durationMs, cpuMs: durationMs });
    await c.next((m) => m.t === 'ok');
    return { home, jobId: g.jobId };
  }

  it('機械が 4 コアとも忙しい中の走行は、他の処理 3 コアの「重なった」走行として、jobId と一緒に記録に残す', async () => {
    const { home, jobId } = await runOnce(4);
    const h = historyOf(home).at(-1);
    assert.equal(h.jobId, jobId);
    // 作り物の時計は標本の時刻と忙しさを別々に読むので、負荷の高い機械では少しずれる
    assert.ok(Math.abs(h.otherLoad - 3) < 0.2, String(h.otherLoad));
    assert.equal(h.overlap, 'contended');
  });

  it('機械を忙しくしているのがこの走行だけなら「静か」', async () => {
    const { home } = await runOnce(1);
    const h = historyOf(home).at(-1);
    assert.ok(h.otherLoad < 0.2, String(h.otherLoad));
    assert.equal(h.overlap, 'alone');
  });

  it('所要の半分も測れなかった走行は学ばない(tick が何度来ても、同じ標本の区間を二重に積まない)', async () => {
    // 測れるのは実時間 150ms ≒ 15 秒分。所要 60 秒の半分に届かない
    const { home } = await runOnce(4, { tickMs: 5, durationMs: 60_000 });
    assert.equal('overlap' in historyOf(home).at(-1), false);
  });

  it('CPU 時間が分からない走行は、重なりを記録しない', async () => {
    const home = tempHome();
    const d = await startDaemon({ home, capacity: 4, cores: 4, tickMs: 60_000, idleExitMs: null, overcommit: true, sampleMs: 20, readBusyMs: () => 0 });
    cleanups.push(() => d.close());
    const c = await openClient(d.sock);
    cleanups.push(async () => c.close());
    c.send({ t: 'request', job: jobRequest() });
    const g = await c.next((m) => m.t === 'grant');
    c.send({ t: 'started', jobId: g.jobId, pid: process.pid, pgid: null });
    c.send({ t: 'exit', jobId: g.jobId, code: 0, killedByCaller: false, durationMs: 6_000, cpuMs: null });
    await c.next((m) => m.t === 'ok');
    const h = historyOf(home).at(-1);
    assert.equal('overlap' in h, false);
    assert.equal('otherLoad' in h, false);
  });

  it('記録から学んだ倍率を要求に載せ、盤面に出す。遅くならない profile は容量が埋まっていても待たせない', async () => {
    const home = tempHome();
    ensurePrivateDir(home);
    const row = (/** @type {string} */ profile, /** @type {number} */ durationMs, /** @type {string} */ overlap) =>
      JSON.stringify({ at: 1, kind: 'history', repo: '/r', profile, class: 'batch', cpus: 1, durationMs, code: 0, cpuMs: null, peakMemMb: null, overlap });
    const lines = [];
    for (let i = 0; i < 3; i += 1) lines.push(row('lint', 10_000, 'alone'), row('lint', 10_500, 'contended'), row('e2e', 10_000, 'alone'), row('e2e', 20_000, 'contended'));
    writeFileSync(pathsOf(home).events, `${lines.join('\n')}\n`, { mode: 0o600 });
    const d = await startDaemon({ home, capacity: 2, tickMs: 60_000, idleExitMs: null });
    cleanups.push(() => d.close());
    const a = await openClient(d.sock);
    cleanups.push(async () => a.close());
    a.send({ t: 'status' });
    const snap = /** @type {{ snapshot: { slowdown: Record<string, number> } }} */ (await a.next((m) => m.t === 'status')).snapshot;
    assert.deepEqual(snap.slowdown, { [JSON.stringify(['/r', 'lint'])]: 1.05, [JSON.stringify(['/r', 'e2e'])]: 2 });
    // lint が容量を使い切っていても、次の lint は待たずに入る。e2e(2 倍)は待つ
    a.send({ t: 'request', job: jobRequest({ repo: '/r', profile: 'lint', cpus: { min: 2, max: 2 } }) });
    const g1 = await a.next((m) => m.t === 'grant');
    const b = await openClient(d.sock);
    cleanups.push(async () => b.close());
    b.send({ t: 'request', job: jobRequest({ repo: '/r', profile: 'lint', cpus: { min: 1, max: 1 } }) });
    const g2 = await b.next((m) => m.t === 'grant');
    assert.equal(d.getState().leases.find((l) => l.job.id === g2.jobId)?.tolerant, true);
    assert.equal(d.getState().leases.find((l) => l.job.id === g1.jobId)?.job.slowdown, 1.05);
    const c = await openClient(d.sock);
    cleanups.push(async () => c.close());
    c.send({ t: 'request', job: jobRequest({ repo: '/r', profile: 'e2e' }) });
    await c.next((m) => m.t === 'queued');
    a.send({ t: 'status' });
    const leases = /** @type {{ snapshot: { leases: Array<{ tolerant: boolean }> } }} */ (await a.next((m) => m.t === 'status' && /** @type {any} */ (m).snapshot.leases.length === 2)).snapshot.leases;
    assert.deepEqual(leases.map((l) => l.tolerant), [true, true]);
  });
});
