// @ts-check
// 割り当てたコア数を並列度として道具に渡す(src/config/threads.mjs)。
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDaemon, DaemonUnavailableError } from '../../src/client/connect.mjs';
import { ALL_CPUS, DEFAULT_PROFILES, validateProfile } from '../../src/config/profiles.mjs';
import { THREAD_ENV_VARS, threadEnv } from '../../src/config/threads.mjs';
import { startDaemon, threadsOf } from '../../src/daemon/server.mjs';
import { runJob } from '../../src/run/run.mjs';
import { tempHome } from '../../testkit/tmp.mjs';

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** @type {typeof connectDaemon} */
const noAutoStart = (o) => connectDaemon({ ...o, autoStart: false });

/**
 * 子の環境の並列度の変数を読んで返す
 * @param {{ capacity?: number, env?: NodeJS.ProcessEnv, profiles?: Record<string, unknown>, flags?: Record<string, unknown>, daemon?: boolean }} o
 */
async function childEnv({ capacity = 4, env = {}, profiles = {}, flags = {}, daemon = true }) {
  const home = tempHome();
  if (daemon) {
    const d = await startDaemon({ home, capacity, tickMs: 20 });
    cleanups.push(() => d.close());
  }
  const cwd = mkdtempSync(join(tmpdir(), 'cthr-'));
  writeFileSync(join(cwd, 'switchyard.json'), JSON.stringify({ profiles }));
  const file = join(cwd, 'env.json');
  const code = await runJob({
    argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.env))`],
    flags: { cpus: { min: 2, max: 3 }, ...flags },
    home,
    cwd,
    env: { PATH: process.env.PATH, ...env },
    out: () => {},
    connect: daemon ? noAutoStart : () => Promise.reject(new DaemonUnavailableError('no daemon in this test')),
  });
  assert.equal(code, 0);
  return /** @type {Record<string, string>} */ (JSON.parse(readFileSync(file, 'utf8')));
}

describe('threadEnv(並列度の環境変数)', () => {
  it('知っている変数すべてに数を入れ、親の環境にある変数は足さない。1 未満なら何も足さない', () => {
    const all = threadEnv(3, {});
    assert.deepEqual(Object.keys(all).sort(), [...THREAD_ENV_VARS].sort());
    assert.ok(Object.values(all).every((v) => v === '3'));
    const kept = threadEnv(3, { CARGO_BUILD_JOBS: '16', GOMAXPROCS: '' });
    assert.equal(kept.CARGO_BUILD_JOBS, undefined);
    assert.equal(kept.GOMAXPROCS, undefined, '空の値も利用者の設定として扱う');
    assert.equal(kept.RUST_TEST_THREADS, '3');
    assert.deepEqual(threadEnv(0, {}), {});
  });
});

describe('threadsOf(道具に渡すスレッド数)', () => {
  it('ふつうは割り当てたコア数。実測で縮めた走行は宣言の最大(容量まで)。容量いっぱいなら機械の全コア数', () => {
    assert.equal(threadsOf({ cpus: 3, job: {} }, 8, 10), 3);
    assert.equal(threadsOf({ cpus: 1, job: { sizedFrom: { min: 2, max: 6 } } }, 8, 10), 6);
    assert.equal(threadsOf({ cpus: 8, job: {} }, 8, 10), 10, '他と分け合っていないので予約のコアまで使ってよい');
    assert.equal(threadsOf({ cpus: 1, job: { sizedFrom: { min: 2, max: ALL_CPUS } } }, 8, 10), 10);
  });
});

describe('既定の表の cpus と "all"', () => {
  it('既定の表の上限は容量いっぱい。switchyard.json の max に "all" と書ける', () => {
    assert.deepEqual(DEFAULT_PROFILES[0].profile.cpus, { min: 2, max: ALL_CPUS });
    assert.deepEqual(validateProfile('x', { match: ['a'], class: 'batch', cpus: { min: 2, max: 'all' } }).cpus, { min: 2, max: ALL_CPUS });
    assert.throws(() => validateProfile('x', { match: ['a'], class: 'batch', cpus: { min: 2, max: 'many' } }), /all/);
  });
});

describe('runJob: 割り当てを並列度として子へ渡す', () => {
  it('割り当てたコア数を CARGO_BUILD_JOBS などと SWITCHYARD_THREADS に入れる', async () => {
    const e = await childEnv({});
    assert.equal(e.SWITCHYARD_CPUS, '3');
    assert.equal(e.SWITCHYARD_THREADS, '3');
    for (const v of THREAD_ENV_VARS) assert.equal(e[v], '3', v);
  });

  it('利用者の値が勝つ: 親の環境の値と、profile の env の値', async () => {
    const e = await childEnv({
      env: { CARGO_BUILD_JOBS: '16' },
      profiles: { x: { match: ['never'], class: 'batch', cpus: { min: 2, max: 3 }, env: { GOMAXPROCS: '7' } } },
      flags: { profile: 'x', cpus: undefined },
    });
    assert.equal(e.CARGO_BUILD_JOBS, '16');
    assert.equal(e.GOMAXPROCS, '7');
    assert.equal(e.RUST_TEST_THREADS, '3');
  });

  it('SWITCHYARD_THREAD_ENV=0 なら渡さない。デーモンに届かず管理なしで走る子にも渡さない(宣言の最小に縛らない)', async () => {
    const off = await childEnv({ env: { SWITCHYARD_THREAD_ENV: '0' } });
    for (const v of THREAD_ENV_VARS) assert.equal(off[v], undefined, v);
    const unmanaged = await childEnv({ daemon: false });
    for (const v of THREAD_ENV_VARS) assert.equal(unmanaged[v], undefined, v);
    assert.equal(unmanaged.SWITCHYARD_THREADS, undefined);
  });
});
