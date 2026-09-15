// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDaemon, DaemonUnavailableError } from '../../src/client/connect.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { buildRequest, heldLocks, runJob } from '../../src/run/run.mjs';
import { tempHome } from '../../testkit/tmp.mjs';
import { waitFor } from '../../testkit/wait.mjs';

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** @param {Partial<import('../../src/daemon/server.mjs').DaemonOptions>} [over] */
async function daemon(over = {}) {
  const home = over.home ?? tempHome();
  const d = await startDaemon({ capacity: 4, tickMs: 20, ...over, home });
  cleanups.push(() => d.close());
  return { d, home };
}

/** 自動起動しない接続 @type {typeof connectDaemon} */
const noAutoStart = (o) => connectDaemon({ ...o, autoStart: false });

/** 呼び出し元の入れ子の印を持ち込まない環境 @param {Record<string, string>} [over] @returns {NodeJS.ProcessEnv} */
function cleanEnv(over = {}) {
  const env = { ...process.env };
  delete env.CONDUCTOR_IN_JOB;
  delete env.CONDUCTOR_HELD_LOCKS;
  delete env.CONDUCTOR_JOB_ID;
  return { ...env, ...over };
}

const node = process.execPath;

/** 子が受け取った conductor の環境変数を JSON で file に書く argv @param {string} file */
const dumpEnv = (file) => [
  node,
  '-e',
  `require('fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify({ inJob: process.env.CONDUCTOR_IN_JOB ?? null, held: process.env.CONDUCTOR_HELD_LOCKS ?? null, cpus: process.env.CONDUCTOR_CPUS ?? null }))`,
];

describe('入れ子(設計 §4.3 の 7)', () => {
  it('heldLocks は CONDUCTOR_HELD_LOCKS のカンマ区切りを読み、空の要素を捨てる', () => {
    assert.deepEqual([...heldLocks({ CONDUCTOR_HELD_LOCKS: 'a,,b' })], ['a', 'b']);
    assert.deepEqual([...heldLocks({})], []);
  });

  it('buildRequest は祖先の鍵を外し、CPU を持つジョブの中では CPU を 0..0 にする', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const r = buildRequest({ argv: ['x'], flags: { locks: ['a', 'c'] }, env: { CONDUCTOR_HELD_LOCKS: 'a,b', CONDUCTOR_IN_JOB: '1' }, cwd });
    assert.deepEqual([r.job.locks, r.job.cpus], [['c'], { min: 0, max: 0 }]);
  });

  it('buildRequest の profile 名は、先頭の語の basename と 2 語目', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    assert.equal(buildRequest({ argv: ['/opt/homebrew/bin/npm', 'install', 'x'], flags: {}, env: {}, cwd }).job.profile, 'cmd:npm install');
  });

  it('buildRequest は、鍵だけのジョブの子(祖先の鍵があり CONDUCTOR_IN_JOB が無い)にだけ、親のジョブの id を parent として載せる(設計 §4.3 の 7)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const parentOf = (/** @type {NodeJS.ProcessEnv} */ env) => buildRequest({ argv: ['npm', 'test'], flags: {}, env, cwd }).job.parent;
    assert.equal(parentOf({ CONDUCTOR_HELD_LOCKS: 'git-index:/r/.git', CONDUCTOR_JOB_ID: 'j9' }), 'j9');
    // CPU を持つジョブの中(入れ子の印あり)・祖先の鍵なし・親の id なしでは載せない
    assert.equal(parentOf({ CONDUCTOR_HELD_LOCKS: 'git-index:/r/.git', CONDUCTOR_JOB_ID: 'j9', CONDUCTOR_IN_JOB: '1' }), undefined);
    assert.equal(parentOf({ CONDUCTOR_JOB_ID: 'j9' }), undefined);
    assert.equal(parentOf({ CONDUCTOR_HELD_LOCKS: 'git-index:/r/.git' }), undefined);
  });

  it('CPU を持つジョブの子には CONDUCTOR_IN_JOB=1 と、持っている鍵を CONDUCTOR_HELD_LOCKS で渡す', async () => {
    const { home } = await daemon();
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const file = join(cwd, 'env.json');
    const code = await runJob({ argv: dumpEnv(file), flags: { locks: ['L'] }, home, cwd, env: cleanEnv(), out: () => {}, connect: noAutoStart });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { inJob: '1', held: 'L', cpus: '1' });
  });

  it('鍵だけのジョブの子には CONDUCTOR_IN_JOB を立てず、鍵だけを渡す', async () => {
    const { home } = await daemon();
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const file = join(cwd, 'env.json');
    const code = await runJob({ argv: dumpEnv(file), flags: { cpus: { min: 0, max: 0 }, locks: ['g'] }, home, cwd, env: cleanEnv(), out: () => {}, connect: noAutoStart });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { inJob: null, held: 'g', cpus: '0' });
  });

  it('入れ子で CPU も鍵も要らなければ、デーモンに接続せずにそのまま走らせる', async () => {
    let calls = 0;
    /** @type {typeof connectDaemon} */
    const counting = async () => {
      calls += 1;
      throw new DaemonUnavailableError('テスト');
    };
    /** @type {string[]} */
    const lines = [];
    const code = await runJob({
      argv: [node, '-e', 'process.exit(7)'],
      flags: { locks: ['g'] },
      home: tempHome(),
      cwd: mkdtempSync(join(tmpdir(), 'cproj-')),
      env: cleanEnv({ CONDUCTOR_IN_JOB: '1', CONDUCTOR_HELD_LOCKS: 'g' }),
      out: (l) => lines.push(l),
      connect: counting,
    });
    assert.deepEqual([code, calls], [7, 0]);
    assert.ok(!lines.some((l) => l.includes('管理なし')), lines.join('\n'));
  });

  it('デーモンに要求せずに走らせる子(入れ子で直接・管理なし)には、祖先の CONDUCTOR_JOB_ID を渡さない', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    /** @param {string} file */
    const dumpJob = (file) => [node, '-e', `require('fs').writeFileSync(${JSON.stringify(file)}, JSON.stringify(process.env.CONDUCTOR_JOB_ID ?? null))`];
    /** @type {typeof connectDaemon} */
    const unavailable = async () => {
      throw new DaemonUnavailableError('テスト');
    };
    const nested = join(cwd, 'nested.json');
    const direct = await runJob({ argv: dumpJob(nested), flags: { locks: ['g'] }, home: tempHome(), cwd, env: cleanEnv({ CONDUCTOR_IN_JOB: '1', CONDUCTOR_HELD_LOCKS: 'g', CONDUCTOR_JOB_ID: 'jparent' }), out: () => {}, connect: unavailable });
    const lone = join(cwd, 'unmanaged.json');
    const unmanaged = await runJob({ argv: dumpJob(lone), flags: {}, home: tempHome(), cwd, env: cleanEnv({ CONDUCTOR_JOB_ID: 'jparent' }), out: () => {}, connect: unavailable });
    assert.deepEqual([direct, unmanaged], [0, 0]);
    assert.deepEqual([JSON.parse(readFileSync(nested, 'utf8')), JSON.parse(readFileSync(lone, 'utf8'))], [null, null]);
  });

  it('祖先が持つ鍵は待たない(git commit の中の git stash が、親の鍵で止まらない)', async () => {
    const { d, home } = await daemon();
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const parentDone = join(cwd, 'parent.done');
    const parent = runJob({
      argv: [node, '-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(parentDone)}, ''), 1500)`],
      flags: { cpus: { min: 0, max: 0 }, locks: ['g'] },
      home,
      cwd,
      env: cleanEnv(),
      out: () => {},
      connect: noAutoStart,
    });
    await waitFor(() => d.getState().leases.some((l) => l.job.locks.includes('g')));
    const child = await runJob({
      argv: [node, '-e', 'process.exit(5)'],
      flags: { cpus: { min: 0, max: 0 }, locks: ['g'] },
      home,
      cwd,
      env: cleanEnv({ CONDUCTOR_HELD_LOCKS: 'g' }),
      out: () => {},
      connect: noAutoStart,
    });
    assert.equal(child, 5);
    assert.equal(existsSync(parentDone), false, '子が親の鍵を待って、親の終了より後に走った');
    assert.equal(await parent, 0);
  });
});
