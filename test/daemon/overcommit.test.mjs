// @ts-check
// デーモンの実測の空き(spareOf)と、詰め込みの通し(標本 → 割り振りの見直し → 盤面)。
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RAMP_KNOWN_MS, RAMP_UNKNOWN_MS, SPARE_WINDOW_MS, spareOf, startDaemon } from '../../src/daemon/server.mjs';
import { openClient } from '../../testkit/client.mjs';
import { jobRequest } from '../../testkit/requests.mjs';
import { tempHome } from '../../testkit/tmp.mjs';
import { waitFor } from '../../testkit/wait.mjs';

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** 0.5 秒ごとの標本。busyCores コア分ずつ働いた累計 @param {number} from @param {number} to @param {number} busyCores */
const samples = (from, to, busyCores) => {
  const out = [];
  for (let at = from; at <= to; at += 500) out.push({ at, busy: at * busyCores });
  return out;
};

describe('spareOf(実測の空き)', () => {
  it('容量から、直近の窓で測った機械全体の使用コア数を引く', () => {
    assert.equal(spareOf({ capacity: 4, samples: samples(0, 20_000, 1), leases: [{ grantedAt: 0, typical: null, cpus: 2 }] }), 3);
  });

  it('窓の間に立ち上がりの途中だった走行は、学んだ使い方(学んでいなければ割り当てたコア数)を実測に足す', () => {
    const at = 10_000;
    // 学んでいない走行: 立ち上がり(長め)の途中は割り当ての 2 コアを足す。終われば実測だけ
    const unknown = [{ grantedAt: at, typical: null, cpus: 2 }];
    assert.equal(spareOf({ capacity: 4, samples: samples(0, at + RAMP_UNKNOWN_MS + SPARE_WINDOW_MS - 500, 0), leases: unknown }), 2);
    assert.equal(spareOf({ capacity: 4, samples: samples(0, at + RAMP_UNKNOWN_MS + SPARE_WINDOW_MS, 0), leases: unknown }), 4);
    // 学んだ走行: 立ち上がり(短め)の途中は学んだ 0.5 コアを足す。終わった後は見込みの合計で引く
    const known = [{ grantedAt: at, typical: 0.5, cpus: 4 }];
    assert.equal(spareOf({ capacity: 4, samples: samples(0, at + 500, 0), leases: known }), 3.5);
    assert.equal(spareOf({ capacity: 4, samples: samples(0, at + RAMP_KNOWN_MS + SPARE_WINDOW_MS, 0), leases: known }), 3.5);
  });

  it('短い走行が次々に入って誰かが立ち上がりの途中でも、立ち上がった走行の実測と合わせて空きを出す(以前は null で詰め込めなかった)', () => {
    const leases = [
      { grantedAt: 0, typical: null, cpus: 2 },
      { grantedAt: 19_800, typical: 0.4, cpus: 2 },
    ];
    // 機械全体で 1 コア働いている。立ち上がり中の 2 本目の見込み 0.4 を足して 1.4 → 空き 2.6
    assert.equal(spareOf({ capacity: 4, samples: samples(0, 20_000, 1), leases }), 4 - 1.4);
  });

  it('学んだ使い方の見込みが実測より大きければ、見込みで引く', () => {
    assert.equal(spareOf({ capacity: 4, samples: samples(0, 20_000, 0.5), leases: [{ grantedAt: 0, typical: 3.8, cpus: 4 }] }), 4 - 3.8);
  });

  it('標本が無い・窓の長さに足りなければ null', () => {
    assert.equal(spareOf({ capacity: 4, samples: [], leases: [{ grantedAt: 0, typical: null, cpus: 1 }] }), null);
    assert.equal(spareOf({ capacity: 4, samples: samples(0, SPARE_WINDOW_MS - 500, 0), leases: [] }), null);
  });
});

describe('daemon: 実測の空きへの詰め込み', () => {
  /**
   * 時計を 20 倍に進める(立ち上がり 3 秒 → 実時間 150ms)。busyCores は機械全体の使用コア数の作り物。
   * tick は長くして、割り振りの見直しが標本を取る側から起きることを確かめる。
   * @param {{ overcommit: boolean, busyCores: number }} o
   */
  async function setup({ overcommit, busyCores }) {
    const t0 = Date.now();
    const mono = () => (Date.now() - t0) * 20;
    const d = await startDaemon({ home: tempHome(), capacity: 2, tickMs: 60_000, heartbeatTimeoutMs: 600_000, recoveryGraceMs: 10_000, idleExitMs: null, overcommit, sampleMs: 20, readBusyMs: () => mono() * busyCores, monoNow: mono });
    cleanups.push(() => d.close());
    const a = await openClient(d.sock);
    const b = await openClient(d.sock);
    cleanups.push(() => a.close(), () => b.close());
    a.send({ t: 'request', job: jobRequest({ cpus: { min: 2, max: 2 } }) });
    const g = await a.next((m) => m.t === 'grant');
    a.send({ t: 'started', jobId: g.jobId, pid: process.pid, pgid: null });
    b.send({ t: 'request', job: jobRequest({ profile: 'q', cpus: { min: 1, max: 1 } }) });
    await b.next((m) => m.t === 'queued');
    return { d, b };
  }

  it('予約で埋まっていても、機械が空いていれば、立ち上がりを待ってから 1 本を容量を超えて入れる', async () => {
    const { d, b } = await setup({ overcommit: true, busyCores: 0.3 });
    const g = await b.next((m) => m.t === 'grant', 5_000);
    assert.equal(g.cpus, 1);
    const lease = d.getState().leases.find((l) => l.job.id === g.jobId);
    assert.equal(lease?.overcommit, true);
  });

  it('機械が実際に忙しければ入れない', async () => {
    const { d } = await setup({ overcommit: true, busyCores: 2 });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(d.getState().waiting.length, 1);
  });

  it('詰め込みを止めていれば(startDaemon の既定)、機械が空いていても入れない', async () => {
    const { d } = await setup({ overcommit: false, busyCores: 0 });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(d.getState().waiting.length, 1);
  });
});
