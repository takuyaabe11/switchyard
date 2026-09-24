// @ts-check
// 環境のせいかもしれない失敗の通し: デーモンが走行中の様子を覚え、失敗したら包みと確認待ちと記録に手がかりを載せる。
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connectDaemon } from '../../src/client/connect.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { runJob } from '../../src/run/run.mjs';
import { openClient } from '../../testkit/client.mjs';
import { jobRequest } from '../../testkit/requests.mjs';
import { tempHome } from '../../testkit/tmp.mjs';

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** 機械の忙しさを作り物にしたデーモン(busyCores コアが常に働いている) @param {number} busyCores */
async function setup(busyCores) {
  const home = tempHome();
  const t0 = Date.now();
  const d = await startDaemon({ home, capacity: 4, cores: 4, tickMs: 50, overcommit: true, sampleMs: 20, readBusyMs: () => (Date.now() - t0) * busyCores, idleExitMs: null });
  cleanups.push(() => d.close());
  // 先に走っている別の重い走行
  const other = await openClient(d.sock);
  cleanups.push(() => other.close());
  other.send({ t: 'request', job: jobRequest({ session: 'other', cpus: { min: 2, max: 2 } }) });
  const g = await other.next((m) => m.t === 'grant');
  other.send({ t: 'started', jobId: g.jobId, pid: process.pid, pgid: null });
  return { d, home };
}

/** 300ms 走って code で終わる走行を switchyard に通す @param {string} home @param {number} code */
async function failing(home, code) {
  /** @type {string[]} */
  const lines = [];
  const exit = await runJob({
    argv: [process.execPath, '-e', `setTimeout(() => process.exit(${code}), 300)`],
    flags: { cpus: { min: 1, max: 1 } },
    home,
    cwd: tmpdir(),
    env: { PATH: process.env.PATH },
    out: (l) => lines.push(l),
    connect: (o) => connectDaemon({ ...o, autoStart: false }),
  });
  return { exit, lines };
}

describe('daemon: 環境のせいかもしれない失敗', () => {
  it('他の重い走行と重なって機械が全部忙しい中で失敗したら、包みが Claude に伝え、記録に手がかりを残す', async () => {
    const { d, home } = await setup(4);
    const { exit, lines } = await failing(home, 1);
    assert.equal(exit, 1);
    assert.ok(lines.some((l) => /コードのせいではないかもしれない: 機械の 4 コアがほぼ全部使われ、そのうち約 [0-9.]+ コアは他の走行\(switchyard の重い走行 1 本を含む\)/.test(l)), lines.join('\n'));
    const history = readFileSync(pathsOf(home).events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'history');
    assert.equal(history.at(-1).environmental.length, 1);
    const unacked = Object.values(d.getState().unacked).flat();
    assert.equal(unacked.length, 1);
    assert.match(String(unacked[0].hint?.[0]), /switchyard の重い走行 1 本/);
  });

  it('機械に余裕があれば、重なっていても何も言わない', async () => {
    const { d, home } = await setup(1);
    const { exit, lines } = await failing(home, 1);
    assert.equal(exit, 1);
    assert.equal(lines.some((l) => /コードのせいではないかもしれない/.test(l)), false, lines.join('\n'));
    assert.equal(Object.values(d.getState().unacked).flat()[0].hint, undefined);
  });
});
