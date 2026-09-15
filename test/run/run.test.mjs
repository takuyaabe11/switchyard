// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectDaemon, DaemonUnavailableError } from '../../src/client/connect.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { buildRequest, runJob } from '../../src/run/run.mjs';
import { killGroupLeftovers, pidsInGroup } from '../../testkit/procs.mjs';
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

/** 自動起動しない接続(テストのデーモンと取り合わないように) @type {typeof connectDaemon} */
const noAutoStart = (o) => connectDaemon({ ...o, autoStart: false });

/** @param {Record<string, unknown>} profiles */
function project(profiles) {
  const dir = mkdtempSync(join(tmpdir(), 'cproj-'));
  writeFileSync(join(dir, 'conductor.json'), JSON.stringify({ profiles }));
  return dir;
}

const node = process.execPath;

describe('buildRequest', () => {
  it('--profile の性格を使い、引数で上書きし、鍵は足し合わせる', () => {
    const cwd = project({ x: { match: ['never'], class: 'measure', cpus: { min: 2, max: 3 }, locks: ['a'], preempt: 'never' } });
    const r = buildRequest({ argv: ['echo', 'hi'], flags: { profile: 'x', locks: ['b', 'a'], why: '目的' }, env: { CLAUDE_CODE_SESSION_ID: 'abcdefghij' }, cwd });
    assert.deepEqual(r.job, { session: 'abcdefgh', repo: cwd, profile: 'x', cmd: 'echo hi', class: 'measure', cpus: { min: 2, max: 3 }, locks: ['a', 'b'], preempt: 'never', why: '目的' });
  });

  it('どれにも当たらなければ batch・CPU 1・profile 名はコマンドの頭 2 語', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const r = buildRequest({ argv: ['git', 'status', '-s'], flags: {}, env: {}, cwd });
    assert.deepEqual([r.job.class, r.job.cpus, r.job.profile, r.profile], ['batch', { min: 1, max: 1 }, 'cmd:git status', null]);
  });

  it('無い profile を指定したら投げる', () => {
    assert.throws(() => buildRequest({ argv: ['x'], flags: { profile: 'nope' }, env: {}, cwd: mkdtempSync(join(tmpdir(), 'cproj-')) }), /profile nope が見つからない/);
  });
});

describe('runJob', () => {
  it('割り振られた CPU を雛形で子へ渡し、子の終了コードを返す', async () => {
    const { d, home } = await daemon();
    const cwd = project({ x: { match: ['never'], class: 'batch', cpus: { min: 2, max: 3 }, env: { N: '{cpus}' } } });
    /** @type {string[]} */
    const lines = [];
    const code = await runJob({
      argv: [node, '-e', 'process.exit(Number(process.env.N) * 10 + Number(process.env.CONDUCTOR_CPUS))'],
      flags: { profile: 'x' },
      home,
      cwd,
      out: (l) => lines.push(l),
      connect: noAutoStart,
    });
    assert.equal(code, 33);
    assert.equal(d.getState().leases.length, 0);
    assert.ok(lines.some((l) => l.includes('CPU 3')), lines.join('\n'));
    const history = readFileSync(pathsOf(home).events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'history');
    assert.deepEqual(history.map((h) => [h.profile, h.code]), [['x', 33]]);
  });

  it('同じ鍵を持つ 2 本は、重ならずに順に走る', async () => {
    const { home } = await daemon();
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const log = join(cwd, 'spans.txt');
    const script = (/** @type {string} */ name) =>
      `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)}, '${name} start '+Date.now()+'\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)}, '${name} end '+Date.now()+'\\n')},200)`;
    const run = (/** @type {string} */ name) => runJob({ argv: [node, '-e', script(name)], flags: { locks: ['L'] }, home, cwd, out: () => {}, connect: noAutoStart });
    const codes = await Promise.all([run('a'), run('b')]);
    assert.deepEqual(codes, [0, 0]);
    /** @type {Record<string, number>} */
    const t = {};
    for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
      const [name, what, at] = line.split(' ');
      t[`${name}.${what}`] = Number(at);
    }
    const [first, second] = t['a.start'] < t['b.start'] ? ['a', 'b'] : ['b', 'a'];
    assert.ok(t[`${second}.start`] >= t[`${first}.end`], JSON.stringify(t));
  });

  it('待っている間に SIGTERM を受けたら、待つのをやめて 143 を返し、待ち列から消える', async () => {
    const { d, home } = await daemon({ capacity: 1 });
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const blocker = runJob({ argv: [node, '-e', 'setTimeout(()=>{}, 1500)'], flags: {}, home, cwd, out: () => {}, connect: noAutoStart });
    await waitFor(() => d.getState().leases.length === 1);
    const signals = new EventEmitter();
    const waiting = runJob({ argv: [node, '-e', ''], flags: {}, home, cwd, out: () => {}, connect: noAutoStart, signals });
    await waitFor(() => d.getState().waiting.length === 1);
    signals.emit('SIGTERM');
    assert.equal(await waiting, 143);
    await waitFor(() => d.getState().waiting.length === 0);
    assert.equal(await blocker, 0);
  });

  it('走行中に SIGTERM を受けたら子のグループへ転送し、killed として記録する', async () => {
    const { d, home } = await daemon();
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const signals = new EventEmitter();
    const running = runJob({
      argv: ['sh', '-c', 'sleep 30 & wait'],
      flags: {},
      home,
      cwd,
      out: () => {},
      connect: noAutoStart,
      signals,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sessKill1' },
    });
    await waitFor(() => d.getState().leases[0]?.phase === 'running');
    signals.emit('SIGTERM');
    assert.equal(await running, 143);
    await waitFor(() => (d.getState().unacked.sessKill ?? []).length === 1);
    assert.equal(d.getState().unacked.sessKill[0].kind, 'killed');
  });

  it('SIGTERM の後に生まれた子も、グループごと終わらせてから終了を返す', async () => {
    const { d, home } = await daemon();
    const signals = new EventEmitter();
    const running = runJob({
      argv: ['sh', '-c', 'trap "sleep 30 & exit 0" TERM; sleep 30 & wait'],
      flags: {},
      home,
      cwd: mkdtempSync(join(tmpdir(), 'cproj-')),
      out: () => {},
      connect: noAutoStart,
      signals,
      killGraceMs: 500,
    });
    await waitFor(() => d.getState().leases[0]?.phase === 'running');
    const pgid = /** @type {number} */ (d.getState().leases[0].pgid);
    try {
      await waitFor(() => pidsInGroup(pgid).length >= 2);
      signals.emit('SIGTERM');
      await running;
      assert.deepEqual(pidsInGroup(pgid), []);
    } finally {
      killGroupLeftovers(pgid);
    }
  });

  it('デーモンに届かなければ、管理なしで実行し、そう表示する', async () => {
    /** @type {string[]} */
    const lines = [];
    const code = await runJob({
      argv: [node, '-e', 'process.exit(Number(process.env.CONDUCTOR_CPUS))'],
      flags: { cpus: { min: 2, max: 6 } },
      home: tempHome(),
      cwd: mkdtempSync(join(tmpdir(), 'cproj-')),
      out: (l) => lines.push(l),
      connect: async () => {
        throw new DaemonUnavailableError('テスト');
      },
    });
    assert.equal(code, 2);
    assert.ok(lines.some((l) => l.includes('管理なしで実行する')), lines.join('\n'));
  });

  it('走行中にデーモンが入れ替わっても子は走り続け、resume でリースを取り戻す', async () => {
    const home = tempHome();
    const first = await startDaemon({ home, capacity: 4, tickMs: 20 });
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    /** @type {string[]} */
    const lines = [];
    const running = runJob({ argv: [node, '-e', 'setTimeout(()=>{}, 1200)'], flags: {}, home, cwd, out: (l) => lines.push(l), connect: noAutoStart, reconnectMs: 50 });
    await waitFor(() => first.getState().leases[0]?.phase === 'running');
    const id = first.getState().leases[0].job.id;
    await first.close();
    const { d: second } = await daemon({ home });
    await waitFor(() => second.getState().leases.some((l) => l.job.id === id && !l.recovering), 3_000);
    assert.equal(await running, 0);
    await waitFor(() => second.getState().leases.length === 0);
    assert.ok(lines.some((l) => l.includes('つなぎ直した')), lines.join('\n'));
  });

  it('再接続を待っている間に子が終わったら、待ちのタイマーでプロセスの終了を遅らせない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cproj-'));
    const script = join(dir, 'exit-timing.mjs');
    const root = new URL('../../', import.meta.url);
    const at = (/** @type {string} */ rel) => JSON.stringify(new URL(rel, root).href);
    writeFileSync(
      script,
      [
        `import { startDaemon } from ${at('src/daemon/server.mjs')};`,
        `import { connectDaemon } from ${at('src/client/connect.mjs')};`,
        `import { runJob } from ${at('src/run/run.mjs')};`,
        "import { mkdtempSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        "const home = mkdtempSync(join(tmpdir(), 'cd-'));",
        'const d = await startDaemon({ home, capacity: 2, tickMs: 20 });',
        "const p = runJob({ argv: [process.execPath, '-e', 'setTimeout(() => {}, 300)'], flags: {}, home, cwd: home, out: () => {}, connect: (o) => connectDaemon({ ...o, autoStart: false }), reconnectMs: 4000 });",
        "while (d.getState().leases[0]?.phase !== 'running') await new Promise((r) => setTimeout(r, 10));",
        'await d.close();',
        "console.log('code=' + (await p));",
      ].join('\n'),
    );
    const started = Date.now();
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, [script], { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const elapsed = Date.now() - started;
    assert.match(String(out), /code=0/);
    assert.ok(elapsed < 3_000, `プロセスの終了までに ${elapsed}ms かかった(再接続の待ち 4000ms に引きずられている)`);
  });

  it('入れ替わったデーモンがジョブを知らなければ、管理なしで走り続ける', async () => {
    const home = tempHome();
    const first = await startDaemon({ home, capacity: 4, tickMs: 20 });
    /** @type {string[]} */
    const lines = [];
    const running = runJob({ argv: [node, '-e', 'setTimeout(()=>{}, 800)'], flags: {}, home, cwd: mkdtempSync(join(tmpdir(), 'cproj-')), out: (l) => lines.push(l), connect: noAutoStart, reconnectMs: 50 });
    await waitFor(() => first.getState().leases[0]?.phase === 'running');
    await first.close();
    rmSync(pathsOf(home).state);
    await daemon({ home });
    assert.equal(await running, 0);
    assert.ok(lines.some((l) => l.includes('管理なしで走り続ける')), lines.join('\n'));
  });
});
