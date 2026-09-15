// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { parseState, readJson } from '../../src/daemon/store.mjs';
import { openClient } from '../../testkit/client.mjs';
import { jobRequest } from '../../testkit/requests.mjs';
import { tempHome } from '../../testkit/tmp.mjs';
import { waitFor } from '../../testkit/wait.mjs';

/** @typedef {import('../../src/daemon/server.mjs').DaemonOptions} DaemonOptions */
/** @typedef {import('../../src/protocol/messages.mjs').Snapshot} Snapshot */

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** @param {Partial<DaemonOptions>} [over] */
async function daemon(over = {}) {
  const home = over.home ?? tempHome();
  const d = await startDaemon({ capacity: 4, tickMs: 20, heartbeatTimeoutMs: 10_000, recoveryGraceMs: 10_000, ...over, home });
  cleanups.push(() => d.close());
  return { d, home };
}

/** @param {string} sock */
async function client(sock) {
  const c = await openClient(sock);
  cleanups.push(() => c.close());
  return c;
}

describe('daemon server', () => {
  it('request に accepted と grant を返し、status と state.json にリースが出る', async () => {
    const { d, home } = await daemon();
    const c = await client(d.sock);
    c.send({ t: 'request', job: jobRequest({ cpus: { min: 1, max: 2 } }) });
    const acc = await c.next((m) => m.t === 'accepted');
    const g = await c.next((m) => m.t === 'grant');
    assert.deepEqual([g.jobId, g.cpus], [acc.jobId, 2]);
    const q = await client(d.sock);
    q.send({ t: 'status' });
    const snap = /** @type {Snapshot} */ ((await q.next((m) => m.t === 'status')).snapshot);
    assert.deepEqual(snap.leases.map((l) => [l.id, l.cpus, l.phase]), [[acc.jobId, 2, 'granted']]);
    assert.equal(parseState(readJson(pathsOf(home).state))?.leases[0].job.id, acc.jobId);
  });

  it('同じ鍵を待つ要求は、先のジョブの exit の後に grant を受け取る', async () => {
    const { d } = await daemon();
    const a = await client(d.sock);
    const b = await client(d.sock);
    a.send({ t: 'request', job: jobRequest({ locks: ['port:4173'] }) });
    const accA = await a.next((m) => m.t === 'accepted');
    await a.next((m) => m.t === 'grant');
    a.send({ t: 'started', jobId: accA.jobId, pid: process.pid, pgid: null });
    b.send({ t: 'request', job: jobRequest({ locks: ['port:4173'] }) });
    const accB = await b.next((m) => m.t === 'accepted');
    const queued = await b.next((m) => m.t === 'queued');
    assert.equal(queued.reason, `鍵 port:4173 を ${accA.jobId} が保持`);
    a.send({ t: 'exit', jobId: accA.jobId, code: 0, killedByCaller: false, durationMs: 5 });
    await a.next((m) => m.t === 'ok');
    assert.equal((await b.next((m) => m.t === 'grant')).jobId, accB.jobId);
  });

  it('失敗した終了は unacked に出て、ack で消える', async () => {
    const { d } = await daemon();
    const a = await client(d.sock);
    a.send({ t: 'request', job: jobRequest({ session: 'sX', cmd: 'npm test' }) });
    const acc = await a.next((m) => m.t === 'accepted');
    await a.next((m) => m.t === 'grant');
    a.send({ t: 'exit', jobId: acc.jobId, code: 1, killedByCaller: false, durationMs: 5 });
    await a.next((m) => m.t === 'ok');
    const q = await client(d.sock);
    q.send({ t: 'unacked', session: 'sX' });
    assert.deepEqual((await q.next((m) => m.t === 'unacked')).jobs, [{ jobId: acc.jobId, kind: 'failed', code: 1, cmd: 'npm test' }]);
    q.send({ t: 'ack', session: 'sX', jobId: acc.jobId });
    await q.next((m) => m.t === 'ok');
    q.send({ t: 'unacked', session: 'sX' });
    assert.deepEqual((await q.next((m) => m.t === 'unacked')).jobs, []);
  });

  it('待っている包みの接続が切れたら、待ち列から外す', async () => {
    const { d } = await daemon({ capacity: 1 });
    const a = await client(d.sock);
    a.send({ t: 'request', job: jobRequest() });
    await a.next((m) => m.t === 'grant');
    const b = await openClient(d.sock);
    b.send({ t: 'request', job: jobRequest() });
    await b.next((m) => m.t === 'queued');
    await b.close();
    await waitFor(() => d.getState().waiting.length === 0);
  });

  it('走行中の包みが切れたら、子が生きていれば孤児にし、子が消えたら資源を返す', async () => {
    let alive = true;
    const { d } = await daemon({ isAlive: () => alive });
    const a = await openClient(d.sock);
    a.send({ t: 'request', job: jobRequest({ session: 'sO' }) });
    const acc = await a.next((m) => m.t === 'accepted');
    await a.next((m) => m.t === 'grant');
    a.send({ t: 'started', jobId: acc.jobId, pid: 4242, pgid: 4242 });
    await waitFor(() => d.getState().leases[0]?.phase === 'running');
    await a.close();
    await waitFor(() => d.getState().leases[0]?.phase === 'orphan');
    assert.deepEqual(d.getState().unacked.sO?.map((u) => u.kind), ['orphan']);
    alive = false;
    await waitFor(() => d.getState().leases.length === 0);
  });

  it('心拍が途絶えたら、見失ったとして資源を返す', async () => {
    const { d } = await daemon({ heartbeatTimeoutMs: 60, isAlive: () => false });
    const a = await client(d.sock);
    a.send({ t: 'request', job: jobRequest({ session: 'sH' }) });
    const acc = await a.next((m) => m.t === 'accepted');
    await a.next((m) => m.t === 'grant');
    await waitFor(() => d.getState().leases.length === 0);
    assert.deepEqual(d.getState().unacked.sH?.map((u) => [u.jobId, u.kind]), [[acc.jobId, 'lost']]);
  });

  it('長く待ったジョブは、grant の直後に started が tick をまたいで遅れても、心拍の途絶と判定されない(C1)', async () => {
    const { d } = await daemon({ heartbeatTimeoutMs: 150, isAlive: () => false });
    const a = await client(d.sock);
    a.send({ t: 'request', job: jobRequest({ session: 'sA', locks: ['port:4173'] }) });
    const accA = await a.next((m) => m.t === 'accepted');
    await a.next((m) => m.t === 'grant');
    a.send({ t: 'started', jobId: accA.jobId, pid: 1, pgid: null });
    const b = await client(d.sock);
    b.send({ t: 'request', job: jobRequest({ session: 'sB', locks: ['port:4173'] }) });
    const accB = await b.next((m) => m.t === 'accepted');
    await b.next((m) => m.t === 'queued');
    // A は心拍を送り続けて自分のリースを保つ(待っている B は、実装どおり心拍を送らない)
    const hb = setInterval(() => a.send({ t: 'hb', jobId: accA.jobId }), 30);
    await new Promise((r) => setTimeout(r, 400));
    clearInterval(hb);
    a.send({ t: 'exit', jobId: accA.jobId, code: 0, killedByCaller: false, durationMs: 1 });
    await a.next((m) => m.t === 'ok');
    await b.next((m) => m.t === 'grant');
    // 包みが子を起動して pgid を確かめる実際の遅れ(ps を同期に呼ぶ)を模す。tick(20ms)を複数またぐ
    await new Promise((r) => setTimeout(r, 60));
    b.send({ t: 'started', jobId: accB.jobId, pid: 2, pgid: null });
    const c = await client(d.sock);
    c.send({ t: 'request', job: jobRequest({ session: 'sC', locks: ['port:4173'] }) });
    await c.next((m) => m.t === 'accepted');
    await c.next((m) => m.t === 'queued');
    // B は started の後は(このテストでは)心拍を送らないので、B 自身の自然な途絶(started から heartbeatTimeoutMs 後)より
    // 十分短い窓で確かめる(長く待つと、この確認自体が別の理由で赤くなる)
    await assert.rejects(c.next((m) => m.t === 'grant', 80), /来ない/);
    assert.deepEqual(d.getState().leases.map((l) => l.job.id), [accB.jobId]);
    assert.equal((d.getState().unacked.sB ?? []).some((u) => u.kind === 'lost'), false);
  });

  it('再起動の後、戻ってきた包みはリースを取り戻し、戻らない包みの分は猶予の後に返す', async () => {
    const home = tempHome();
    const first = await startDaemon({ home, capacity: 4, tickMs: 20 });
    const a = await openClient(first.sock);
    const b = await openClient(first.sock);
    a.send({ t: 'request', job: jobRequest() });
    const accA = await a.next((m) => m.t === 'accepted');
    await a.next((m) => m.t === 'grant');
    b.send({ t: 'request', job: jobRequest() });
    const accB = await b.next((m) => m.t === 'accepted');
    await b.next((m) => m.t === 'grant');
    await first.close();
    await a.close();
    await b.close();

    const { d: second } = await daemon({ home, recoveryGraceMs: 150, isAlive: () => false });
    assert.equal(second.getState().leases.every((l) => l.recovering), true);
    const a2 = await client(second.sock);
    a2.send({ t: 'resume', jobId: accA.jobId, phase: 'running', pid: 9, pgid: 9 });
    await a2.next((m) => m.t === 'accepted');
    await waitFor(() => second.getState().leases.find((l) => l.job.id === accA.jobId)?.recovering === false);
    await waitFor(() => second.getState().leases.every((l) => l.job.id !== accB.jobId));
    assert.deepEqual(second.getState().leases.map((l) => l.job.id), [accA.jobId]);
  });

  it('再起動の後、待っていた包みの resume でその場で入場したときは、grant を 1 通だけ送る', async () => {
    const home = tempHome();
    const first = await startDaemon({ home, capacity: 1, tickMs: 20 });
    const a = await openClient(first.sock);
    const b = await openClient(first.sock);
    a.send({ t: 'request', job: jobRequest() });
    await a.next((m) => m.t === 'grant');
    b.send({ t: 'request', job: jobRequest() });
    const accB = await b.next((m) => m.t === 'accepted');
    await b.next((m) => m.t === 'queued');
    await first.close();
    await a.close();
    await b.close();

    const { d: second } = await daemon({ home });
    const b2 = await client(second.sock);
    b2.send({ t: 'resume', jobId: accB.jobId, phase: 'waiting', pid: null, pgid: null });
    await b2.next((m) => m.t === 'accepted');
    await b2.next((m) => m.t === 'grant');
    await assert.rejects(b2.next((m) => m.t === 'grant', 200), /来ない/);
  });

  it('知らないジョブの resume には unknown を返す', async () => {
    const { d } = await daemon();
    const c = await client(d.sock);
    c.send({ t: 'resume', jobId: 'nope', phase: 'waiting', pid: null, pgid: null });
    assert.equal((await c.next((m) => m.t === 'unknown')).jobId, 'nope');
  });

  it('成功した所要を学び、3 回そろった後の要求に見込みを付ける', async () => {
    const { d } = await daemon();
    for (const ms of [100, 300, 200]) {
      const c = await client(d.sock);
      c.send({ t: 'request', job: jobRequest({ repo: '/r', profile: 'unit' }) });
      const acc = await c.next((m) => m.t === 'accepted');
      await c.next((m) => m.t === 'grant');
      c.send({ t: 'exit', jobId: acc.jobId, code: 0, killedByCaller: false, durationMs: ms });
      await c.next((m) => m.t === 'ok');
    }
    const c = await client(d.sock);
    c.send({ t: 'request', job: jobRequest({ repo: '/r', profile: 'unit' }) });
    await c.next((m) => m.t === 'grant');
    assert.equal(d.getState().leases[0].job.expectedMs, 200);
  });

  it('生きているデーモンが居れば起動を拒み、死んだ socket ファイルは片付けて起動する', async () => {
    const { home } = await daemon();
    await assert.rejects(startDaemon({ home, capacity: 4 }), /別のデーモンが応答している/);
    const home2 = tempHome();
    writeFileSync(pathsOf(home2).sock, '');
    const { d: d2 } = await daemon({ home: home2 });
    assert.equal(existsSync(d2.sock), true);
  });

  it('出来事を events.jsonl に記録し、tick は記録しない', async () => {
    const { d, home } = await daemon({ tickMs: 10 });
    const c = await client(d.sock);
    c.send({ t: 'request', job: jobRequest() });
    await c.next((m) => m.t === 'grant');
    await new Promise((r) => setTimeout(r, 60));
    const kinds = readFileSync(pathsOf(home).events, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .map((r) => (r.kind === 'event' ? r.event.type : r.kind));
    assert.deepEqual(kinds, ['request']);
  });

  it('exit に付いた抜けた子を記録し、同じ repo と profile の後の要求に表示し、再起動しても覚えている', async () => {
    const { d, home } = await daemon();
    const a = await client(d.sock);
    a.send({ t: 'request', job: jobRequest({ repo: '/r', profile: 'e2e' }) });
    const acc = await a.next((m) => m.t === 'accepted');
    await a.next((m) => m.t === 'grant');
    const escape = { escaped: [{ comm: 'chrome', count: 2 }], survivors: [{ pid: 4242, comm: 'chrome', inGroup: false }] };
    a.send({ t: 'exit', jobId: acc.jobId, code: 0, killedByCaller: false, durationMs: 5, escape });
    await a.next((m) => m.t === 'ok');
    const records = readFileSync(pathsOf(home).events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'escape');
    assert.deepEqual(records.map((r) => [r.jobId, r.repo, r.profile, r.escaped, r.survivors]), [[acc.jobId, '/r', 'e2e', escape.escaped, escape.survivors]]);
    const b = await client(d.sock);
    b.send({ t: 'request', job: jobRequest({ repo: '/r', profile: 'e2e' }) });
    await b.next((m) => m.t === 'grant');
    b.send({ t: 'status' });
    const snap = /** @type {Snapshot} */ ((await b.next((m) => m.t === 'status')).snapshot);
    assert.deepEqual(snap.leases.map((l) => l.escapes), [['chrome']]);
    await d.close();
    const { d: again } = await daemon({ home });
    const c = await client(again.sock);
    c.send({ t: 'status' });
    const snap2 = /** @type {Snapshot} */ ((await c.next((m) => m.t === 'status')).snapshot);
    assert.deepEqual(snap2.leases.map((l) => l.escapes), [['chrome']]);
  });

  it('形の違う要求には、どの項目かを名指しした error を返す', async () => {
    const { d } = await daemon();
    const c = await client(d.sock);
    c.send({ t: 'request', job: { ...jobRequest(), class: 'huge' } });
    assert.match(String((await c.next((m) => m.t === 'error')).message), /job.class/);
  });
});
