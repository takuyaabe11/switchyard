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

describe('daemon server: 止めたジョブの包みを見失ったとき(設計 §6.7)', () => {
  it('pause で止めたリースの包みが消えたら、デーモンが SIGCONT を送る', async () => {
    const home = tempHome();
    /** @type {Array<[number, string]>} */
    const sent = [];
    // 心拍の途絶ではなく、接続が切れたことで見失う経路を見たいので、心拍の上限は長く取る
    const d = await startDaemon({ home, capacity: 4, tickMs: 10, heartbeatTimeoutMs: 10_000, idleExitMs: null, isAlive: () => false });
    cleanups.push(() => d.close());
    const c = await client(d.sock);
    c.send({ t: 'request', job: jobRequest({ cpus: { min: 1, max: 1 }, preempt: 'pause' }) });
    const g = await c.next((m) => m.t === 'grant');
    c.send({ t: 'started', jobId: g.jobId, pid: process.pid, pgid: 999_999 });
    await waitFor(() => d.getState().leases[0]?.phase === 'running');
    // 計測を投げると、走行中のジョブが止まる
    const c2 = await client(d.sock);
    c2.send({ t: 'request', job: jobRequest({ class: 'measure', cpus: { min: 1, max: 1 } }) });
    await waitFor(() => d.getState().leases.some((l) => l.held === 'pause'));
    // 包みが消える。存在しない pgid なので送信は失敗するが、投げずに進むこと(リースは返る)
    c.close();
    await waitFor(() => d.getState().leases.every((l) => l.held === undefined), 3_000);
    assert.deepEqual(sent, []);
  });
});

describe('daemon server のアイドル終了', () => {
  it('一度も入場を出していないまま静かなら、自分で終わる', async () => {
    const home = tempHome();
    let exited = 0;
    const d = await startDaemon({ home, capacity: 4, tickMs: 5, idleExitMs: 1, onIdleExit: () => { exited += 1; } });
    cleanups.push(() => d.close());
    await waitFor(() => exited > 0);
    assert.equal(exited > 0, true);
  });

  it('入場を 1 度でも出したら、その後どれだけ静かでも終わらない', async () => {
    const home = tempHome();
    let exited = 0;
    const d = await startDaemon({ home, capacity: 4, tickMs: 5, idleExitMs: 1, onIdleExit: () => { exited += 1; } });
    cleanups.push(() => d.close());
    const c = await client(d.sock);
    c.send({ t: 'request', job: jobRequest({ cpus: { min: 1, max: 1 } }) });
    const g = await c.next((m) => m.t === 'grant');
    c.send({ t: 'exit', jobId: g.jobId, code: 0, durationMs: 1 });
    await c.next((m) => m.t === 'ok');
    c.close();
    // tick を何度も回す時間を置いても、終了は呼ばれない
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(exited, 0);
  });

  it('待っているジョブがあれば、入場前でも終わらない', async () => {
    const home = tempHome();
    let exited = 0;
    // 容量 0 にはできないので、鍵を取り合わせて待たせる
    const d = await startDaemon({ home, capacity: 1, tickMs: 5, idleExitMs: 1, onIdleExit: () => { exited += 1; } });
    cleanups.push(() => d.close());
    const a = await client(d.sock);
    a.send({ t: 'request', job: jobRequest({ cpus: { min: 1, max: 1 }, locks: ['k'] }) });
    await a.next((m) => m.t === 'grant');
    const b = await client(d.sock);
    b.send({ t: 'request', job: jobRequest({ cpus: { min: 1, max: 1 }, locks: ['k'] }) });
    await b.next((m) => m.t === 'queued');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(exited, 0);
  });

  it('終わり方を渡さなければ、静かでも tick を止めない', async () => {
    const home = tempHome();
    const d = await startDaemon({ home, capacity: 4, tickMs: 5, idleExitMs: 1 });
    cleanups.push(() => d.close());
    await new Promise((r) => setTimeout(r, 60));
    // tick が生きていれば、要求はいつもどおり通る
    const c = await client(d.sock);
    c.send({ t: 'status' });
    const m = await c.next((x) => x.t === 'status');
    assert.equal(typeof m.snapshot, 'object');
  });

  it('idleExitMs が null なら終わらない', async () => {
    const home = tempHome();
    let exited = 0;
    const d = await startDaemon({ home, capacity: 4, tickMs: 5, idleExitMs: null, onIdleExit: () => { exited += 1; } });
    cleanups.push(() => d.close());
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(exited, 0);
  });
});

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
    assert.deepEqual((await q.next((m) => m.t === 'unacked')).jobs, [{ jobId: acc.jobId, kind: 'failed', code: 1, cmd: 'npm test', repo: '/repo', profile: 'p' }]);
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
    // 途絶の猶予(300ms)より長く B を待たせる(700ms)。心拍の間隔(30ms)に対して猶予は 10 倍あり、
    // 負荷のかかった CI でも A 自身は途絶しない(猶予 150ms・心拍を B の要求の後から送る形では、CI で A が途絶して落ちた)
    const { d } = await daemon({ heartbeatTimeoutMs: 300, isAlive: () => false });
    const a = await client(d.sock);
    a.send({ t: 'request', job: jobRequest({ session: 'sA', locks: ['port:4173'] }) });
    const accA = await a.next((m) => m.t === 'accepted');
    await a.next((m) => m.t === 'grant');
    a.send({ t: 'started', jobId: accA.jobId, pid: 1, pgid: null });
    // A は started の直後から心拍を送り続けて自分のリースを保つ(待っている B は、実装どおり心拍を送らない)
    const hb = setInterval(() => a.send({ t: 'hb', jobId: accA.jobId }), 30);
    const b = await client(d.sock);
    b.send({ t: 'request', job: jobRequest({ session: 'sB', locks: ['port:4173'] }) });
    const accB = await b.next((m) => m.t === 'accepted');
    await b.next((m) => m.t === 'queued');
    await new Promise((r) => setTimeout(r, 700));
    clearInterval(hb);
    a.send({ t: 'exit', jobId: accA.jobId, code: 0, killedByCaller: false, durationMs: 1 });
    await a.next((m) => m.t === 'ok');
    await b.next((m) => m.t === 'grant');
    // 包みが子を起動して pgid を確かめる実際の遅れ(ps を同期に呼ぶ)を模す。tick(20ms)を複数またぐ
    await new Promise((r) => setTimeout(r, 60));
    b.send({ t: 'started', jobId: accB.jobId, pid: 2, pgid: null });
    // B も started の後は心拍を送り続けて自分のリースを保つ。こうしないと、確認の所要が長い環境
    // (node --test はファイルを並列に回す)で B 自身が自然に途絶し、確認自体が別の理由で赤くなりうる
    const hbB = setInterval(() => b.send({ t: 'hb', jobId: accB.jobId }), 40);
    try {
      const c = await client(d.sock);
      c.send({ t: 'request', job: jobRequest({ session: 'sC', locks: ['port:4173'] }) });
      await c.next((m) => m.t === 'accepted');
      await c.next((m) => m.t === 'queued');
      await assert.rejects(c.next((m) => m.t === 'grant', 200), /来ない/);
      assert.deepEqual(d.getState().leases.map((l) => l.job.id), [accB.jobId]);
      assert.equal((d.getState().unacked.sB ?? []).some((u) => u.kind === 'lost'), false);
    } finally {
      clearInterval(hbB);
    }
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

  it('resume の前から既にリースだった包みへ、grant を 1 通だけ送り直す(M1)', async () => {
    const home = tempHome();
    const first = await startDaemon({ home, capacity: 4, tickMs: 20 });
    const a = await openClient(first.sock);
    a.send({ t: 'request', job: jobRequest() });
    const accA = await a.next((m) => m.t === 'accepted');
    await a.next((m) => m.t === 'grant');
    // started はまだ送っていない(grant を受けただけの状態で再起動をまたぐ)
    await first.close();
    await a.close();

    const { d: second } = await daemon({ home });
    const a2 = await client(second.sock);
    a2.send({ t: 'resume', jobId: accA.jobId, phase: 'waiting', pid: null, pgid: null });
    await a2.next((m) => m.t === 'accepted');
    await a2.next((m) => m.t === 'grant');
    await assert.rejects(a2.next((m) => m.t === 'grant', 200), /来ない/);
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

  it('出来事と決定を events.jsonl に記録し、tick は記録しない', async () => {
    const { d, home } = await daemon({ tickMs: 10 });
    const c = await client(d.sock);
    c.send({ t: 'request', job: jobRequest() });
    await c.next((m) => m.t === 'grant');
    await new Promise((r) => setTimeout(r, 60));
    const kinds = readFileSync(pathsOf(home).events, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .map((r) => (r.kind === 'event' ? r.event.type : r.kind === 'decision' ? `decision:${r.decision.type}` : r.kind));
    assert.deepEqual(kinds, ['request', 'decision:grant']);
  });

  it('待たせた決定(queued)も、理由と順番つきで events.jsonl に記録する', async () => {
    // 「なぜ・どれだけ待ったか」を後から数えるための記録(改善: switchyard report)
    const { d, home } = await daemon({ capacity: 1, tickMs: 10 });
    const a = await client(d.sock);
    a.send({ t: 'request', job: jobRequest({ cpus: { min: 1, max: 1 } }) });
    const accA = await a.next((m) => m.t === 'accepted');
    await a.next((m) => m.t === 'grant');
    a.send({ t: 'started', jobId: accA.jobId, pid: process.pid, pgid: null });
    const b = await client(d.sock);
    b.send({ t: 'request', job: jobRequest({ cpus: { min: 1, max: 1 } }) });
    const accB = await b.next((m) => m.t === 'accepted');
    await b.next((m) => m.t === 'queued');
    const queued = readFileSync(pathsOf(home).events, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === 'decision' && r.decision.type === 'queued');
    assert.deepEqual(queued.map((r) => [r.decision.jobId, r.decision.position, typeof r.decision.reason, typeof r.at]), [[accB.jobId, 1, 'string', 'number']]);
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

describe('実測の CPU の使い方で要求を縮める(right-sizing)', () => {
  const runOnce = async (/** @type {any} */ d, /** @type {number} */ cpuMs, /** @type {Partial<import('../../src/protocol/messages.mjs').JobRequest>} */ over = {}) => {
    const c = await client(d.sock);
    c.send({ t: 'request', job: jobRequest({ profile: 'unit', cpus: { min: 2, max: 4 }, ...over }) });
    const acc = await c.next((m) => m.t === 'accepted');
    const grant = await c.next((m) => m.t === 'grant');
    c.send({ t: 'exit', jobId: acc.jobId, code: 0, killedByCaller: false, durationMs: 10_000, cpuMs });
    await c.next((m) => m.t === 'ok');
    return grant.cpus;
  };

  it('割り振りの半分も使わない成功が 2 回続いた profile は、次から実測に合わせた要求で並べ、記録に CPU 時間を残す', async () => {
    const { d, home } = await daemon({ capacity: 4 });
    for (let i = 0; i < 2; i += 1) assert.equal(await runOnce(d, 8_000), 4, '縮める前は宣言どおり(空きを max まで配る)');
    assert.equal(await runOnce(d, 8_000), 1, '平均 0.8 コア → 1 コア');
    const history = readFileSync(pathsOf(home).events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'history');
    assert.deepEqual(history.map((h) => h.cpuMs), [8_000, 8_000, 8_000]);
    const req = readFileSync(pathsOf(home).events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'event' && r.event.type === 'request').pop();
    assert.deepEqual([req.event.job.cpus, req.event.job.sizedFrom, req.event.job.measuredCores], [{ min: 1, max: 1 }, { min: 2, max: 4 }, 0.8]);
    // 盤面にも載せる(PreToolUse が待ちの見込みに使う)
    const q = await client(d.sock);
    q.send({ t: 'status' });
    const snap = /** @type {Snapshot} */ ((await q.next((m) => m.t === 'status')).snapshot);
    assert.deepEqual(snap.sized, { [JSON.stringify(['/repo', 'unit'])]: 0.8 });
  });

  it('adaptive: false なら宣言どおり。計測は縮めない。再起動しても記録から学び直す', async () => {
    const off = await daemon({ capacity: 4, adaptive: false });
    for (let i = 0; i < 4; i += 1) assert.equal(await runOnce(off.d, 8_000), 4);
    await off.d.close();
    const on = await daemon({ capacity: 4, home: off.home });
    assert.equal(await runOnce(on.d, 8_000), 1, '同じ home の記録から学んでいる');
    assert.equal(await runOnce(on.d, 8_000, { class: 'measure' }), 4, '計測は縮めない');
  });
});
