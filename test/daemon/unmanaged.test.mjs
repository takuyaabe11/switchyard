// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { connectDaemon, DaemonUnavailableError } from '../../src/client/connect.mjs';
import { decide, initialState } from '../../src/core/decide.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { takeUnmanaged } from '../../src/daemon/store.mjs';
import { runJob } from '../../src/run/run.mjs';
import { tempHome } from '../../testkit/tmp.mjs';
import { waitFor } from '../../testkit/wait.mjs';

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** @param {Record<string, unknown>} over */
const run = (over) => ({ at: 1_000, session: 's1', repo: '/r', profile: 'cmd:npm test', cmd: 'npm test', code: 1, durationMs: 50, ...over });

/** 呼び出し元の入れ子の印を持ち込まない環境 @param {Record<string, string>} [over] @returns {NodeJS.ProcessEnv} */
function cleanEnv(over = {}) {
  const env = { ...process.env };
  delete env.SWITCHYARD_IN_JOB;
  delete env.SWITCHYARD_HELD_LOCKS;
  delete env.SWITCHYARD_JOB_ID;
  return { ...env, ...over };
}

describe('管理なしの走行の控え(設計 §4.2・§4.3 の 8)', () => {
  it('takeUnmanaged は形の合う行だけを返し、ファイルを消す(途中の別名も残さない)', () => {
    const file = pathsOf(tempHome()).unmanaged;
    writeFileSync(file, [JSON.stringify(run({})), '壊れた行', JSON.stringify({ at: 'x' }), JSON.stringify(run({ code: null, cmd: 'make' }))].join('\n'));
    assert.deepEqual(takeUnmanaged(file).map((u) => [u.cmd, u.code]), [['npm test', 1], ['make', null]]);
    assert.equal(existsSync(file), false);
    assert.deepEqual(readdirSync(dirname(file)), []);
  });

  it('takeUnmanaged は控えが無ければ空', () => {
    assert.deepEqual(takeUnmanaged(pathsOf(tempHome()).unmanaged), []);
  });

  it('takeUnmanaged は rename と unlink の間で落ちて残った別名(.taking)も拾い、2 度は取り込まない', () => {
    const file = pathsOf(tempHome()).unmanaged;
    writeFileSync(`${file}.99999.taking`, `${JSON.stringify(run({ cmd: 'npm run left' }))}\n`);
    // 落ちたデーモンと同じ pid の別名(取り込む前に上書きしない)
    writeFileSync(`${file}.${process.pid}.taking`, `${JSON.stringify(run({ cmd: 'npm run same-pid' }))}\n`);
    writeFileSync(file, `${JSON.stringify(run({ cmd: 'npm test' }))}\n`);
    assert.deepEqual(takeUnmanaged(file).map((u) => u.cmd).sort(), ['npm run left', 'npm run same-pid', 'npm test']);
    assert.deepEqual(readdirSync(dirname(file)), []);
    assert.deepEqual(takeUnmanaged(file), []);
  });

  it('デーモンが起動した後に足された控えも、次の tick で取り込み、失敗を ack 待ちに積む', async () => {
    const home = tempHome();
    const p = pathsOf(home);
    const d = await startDaemon({ home, capacity: 4, tickMs: 20 });
    cleanups.push(() => d.close());
    appendFileSync(p.unmanaged, `${JSON.stringify(run({ code: 2, cmd: 'npm run late' }))}\n`);
    await waitFor(() => (d.getState().unacked.s1 ?? []).some((u) => u.cmd === 'npm run late'), 2_000);
    assert.deepEqual(d.getState().unacked.s1.map((u) => [u.kind, u.code, u.cmd]), [['failed', 2, 'npm run late']]);
    assert.equal(existsSync(p.unmanaged), false);
  });

  it('decide の unmanagedExit は ack 待ちに failed で積み、同じ id は 2 度積まない', () => {
    const e = /** @type {const} */ ({ type: 'unmanagedExit', now: 0, session: 's1', jobId: 'u1', code: 2, cmd: 'npm test' });
    const once = decide(initialState({ capacity: 4 }), e).state;
    const twice = decide(once, e).state;
    assert.deepEqual(twice.unacked, { s1: [{ jobId: 'u1', kind: 'failed', code: 2, cmd: 'npm test' }] });
  });

  it('デーモンは起動時に控えを取り込み、記録に写し、失敗だけを ack 待ちに積む', async () => {
    const home = tempHome();
    const p = pathsOf(home);
    writeFileSync(p.unmanaged, `${JSON.stringify(run({ code: 1 }))}\n${JSON.stringify(run({ code: 0, cmd: 'npm run build' }))}\n`);
    const d = await startDaemon({ home, capacity: 4, tickMs: 20 });
    cleanups.push(() => d.close());
    assert.deepEqual(d.getState().unacked.s1.map((u) => [u.kind, u.code, u.cmd]), [['failed', 1, 'npm test']]);
    const kinds = readFileSync(p.events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'unmanaged');
    assert.deepEqual(kinds.map((r) => r.cmd), ['npm test', 'npm run build']);
    assert.equal(existsSync(p.unmanaged), false);
  });

  // 待ち続ける不具合はテストごと止まるので、上限を付けて赤として出す(変異の走行でも時間切れで見逃さない)
  it('待っている間にデーモンが要求を拒んだら、待ち続けずに管理なしで実行し、控える', { timeout: 5_000 }, async () => {
    const home = tempHome();
    // 何を受けても error だけを返すデーモンの代わり。後始末で接続を壊してから閉じる
    // (待ち続ける不具合があると接続が開いたままになり、close が永遠に終わらずテストファイルごと止まるため)
    /** @type {Set<import('node:net').Socket>} */
    const sockets = new Set();
    const fake = createServer((conn) => {
      sockets.add(conn);
      conn.on('close', () => sockets.delete(conn));
      conn.on('data', () => conn.write(`${JSON.stringify({ t: 'error', message: 'テストの拒否' })}\n`));
    });
    await new Promise((resolve) => fake.listen(pathsOf(home).sock, () => resolve(undefined)));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const s of sockets) s.destroy();
          fake.close(() => resolve(undefined));
        }),
    );
    /** @type {string[]} */
    const lines = [];
    const code = await runJob({
      argv: [process.execPath, '-e', 'process.exit(6)'],
      flags: {},
      home,
      cwd: mkdtempSync(join(tmpdir(), 'cproj-')),
      env: cleanEnv(),
      out: (l) => lines.push(l),
      connect: (o) => connectDaemon({ ...o, autoStart: false }),
      // 不具合で待ち続けた場合も、後始末の後は短い時間で管理なしへ落ちて、プロセスが終わるようにする
      reconnectMs: 100,
      unmanagedAfterMs: 1_000,
    });
    assert.equal(code, 6);
    assert.ok(lines.some((l) => l.includes('デーモンが要求を受け付けない(テストの拒否)')), lines.join('\n'));
    assert.equal(JSON.parse(readFileSync(pathsOf(home).unmanaged, 'utf8').trim()).code, 6);
  });

  it('デーモンに届かず管理なしで走ったら、終了時に控えを 1 行足す。入れ子でそのまま走ったときは足さない', async () => {
    const home = tempHome();
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const unavailable = async () => {
      throw new DaemonUnavailableError('テスト');
    };
    const code = await runJob({ argv: [process.execPath, '-e', 'process.exit(3)'], flags: {}, home, cwd, env: cleanEnv({ CLAUDE_CODE_SESSION_ID: 'sessUnmg1' }), out: () => {}, connect: unavailable });
    assert.equal(code, 3);
    await runJob({ argv: [process.execPath, '-e', 'process.exit(4)'], flags: { locks: ['g'] }, home, cwd, env: cleanEnv({ SWITCHYARD_IN_JOB: '1', SWITCHYARD_HELD_LOCKS: 'g' }), out: () => {}, connect: unavailable });
    const lines = readFileSync(pathsOf(home).unmanaged, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.session, l.code, l.profile]), [['sessUnmg', 3, `cmd:${basename(process.execPath)} -e`]]);
  });
});
