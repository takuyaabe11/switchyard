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
  it('容量から、立ち上がった後の窓で測った機械全体の使用コア数を引く', () => {
    assert.equal(spareOf({ capacity: 4, samples: samples(0, 20_000, 1), leases: [{ grantedAt: 0, typical: null }] }), 3);
  });

  it('入場から立ち上がりの時間(学んでいなければ長め)と窓の長さが経つまでは null', () => {
    const lease = [{ grantedAt: 10_000, typical: null }];
    assert.equal(spareOf({ capacity: 4, samples: samples(0, 10_000 + RAMP_UNKNOWN_MS + SPARE_WINDOW_MS - 500, 0), leases: lease }), null);
    assert.equal(spareOf({ capacity: 4, samples: samples(0, 10_000 + RAMP_UNKNOWN_MS + SPARE_WINDOW_MS, 0), leases: lease }), 4);
    const known = [{ grantedAt: 10_000, typical: 0.5 }];
    assert.equal(spareOf({ capacity: 4, samples: samples(0, 10_000 + RAMP_KNOWN_MS + SPARE_WINDOW_MS, 0), leases: known }), 3.5);
  });

  it('学んだ使い方の見込みが実測より大きければ、見込みで引く(立ち上がりの途中で空いて見えても詰め込みすぎない)', () => {
    assert.equal(spareOf({ capacity: 4, samples: samples(0, 20_000, 0.5), leases: [{ grantedAt: 0, typical: 3.8 }] }), 4 - 3.8);
  });

  it('標本が無ければ null', () => {
    assert.equal(spareOf({ capacity: 4, samples: [], leases: [{ grantedAt: 0, typical: null }] }), null);
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
