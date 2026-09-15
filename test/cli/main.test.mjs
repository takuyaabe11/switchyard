// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli } from '../../src/cli/main.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { openClient } from '../../testkit/client.mjs';
import { jobRequest } from '../../testkit/requests.mjs';
import { tempHome } from '../../testkit/tmp.mjs';
import { waitFor } from '../../testkit/wait.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'conductor.mjs');

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** @param {string[]} args @param {NodeJS.ProcessEnv} env */
async function capture(args, env) {
  let out = '';
  let err = '';
  const code = await cli(args, { env, cwd: mkdtempSync(join(tmpdir(), 'cproj-')), stdout: (s) => (out += s), stderr: (s) => (err += s) });
  return { code, out, err };
}

describe('cli', () => {
  it('help は 0、引数の誤りは 2 で使い方を出す', async () => {
    const env = { CONDUCTOR_HOME: tempHome() };
    assert.equal((await capture(['help'], env)).code, 0);
    const bad = await capture(['fly'], env);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /知らないサブコマンド: fly[\s\S]*使い方:/);
  });

  it('デーモンが居なければ top はそう言い、デーモンを起動しない', async () => {
    const home = tempHome();
    const r = await capture(['top'], { CONDUCTOR_HOME: home });
    assert.deepEqual([r.code, r.out], [0, 'デーモンは動いていない(走行も待ちも無い)\n']);
    assert.equal(existsSync(pathsOf(home).lock), false);
  });

  it('top と why がデーモンの状態を読む', async () => {
    const home = tempHome();
    const d = await startDaemon({ home, capacity: 4, tickMs: 20 });
    cleanups.push(() => d.close());
    const c = await openClient(d.sock);
    cleanups.push(() => c.close());
    c.send({ t: 'request', job: jobRequest({ cmd: 'npm test' }) });
    const acc = await c.next((m) => m.t === 'accepted');
    await c.next((m) => m.t === 'grant');
    const top = await capture(['top'], { CONDUCTOR_HOME: home });
    assert.match(top.out, /CPU 1 \/ 4 使用中/);
    const why = await capture(['why', String(acc.jobId)], { CONDUCTOR_HOME: home });
    assert.deepEqual([why.code, /は割り振り済みで/.test(why.out)], [0, true]);
    assert.equal((await capture(['why', 'nope'], { CONDUCTOR_HOME: home })).code, 1);
  });

  it('ack: Claude のセッションは他のセッションのジョブを確認済みにできない', async () => {
    const home = tempHome();
    const d = await startDaemon({ home, capacity: 4, tickMs: 20 });
    cleanups.push(() => d.close());
    const c = await openClient(d.sock);
    cleanups.push(() => c.close());
    c.send({ t: 'request', job: jobRequest({ session: 'other123' }) });
    const acc = await c.next((m) => m.t === 'accepted');
    await c.next((m) => m.t === 'grant');
    c.send({ t: 'exit', jobId: acc.jobId, code: 1, killedByCaller: false, durationMs: 1 });
    await c.next((m) => m.t === 'ok');
    const refused = await capture(['ack', String(acc.jobId), '--session', 'other123'], { CONDUCTOR_HOME: home, CLAUDE_CODE_SESSION_ID: 'mine5678xx' });
    assert.equal(refused.code, 2);
    assert.equal(d.getState().unacked.other123?.length, 1);
    const human = await capture(['ack', String(acc.jobId), '--session', 'other123'], { CONDUCTOR_HOME: home });
    assert.equal(human.code, 0);
    assert.equal(d.getState().unacked.other123, undefined);
  });

  it('bin: run はデーモンを自動起動し、子の終了コードを返す', async () => {
    const home = tempHome();
    cleanups.push(async () => {
      const lock = pathsOf(home).lock;
      if (!existsSync(lock)) return;
      try {
        process.kill(Number(readFileSync(lock, 'utf8')), 'SIGTERM');
      } catch {
        // 既に居ない
      }
      await waitFor(() => !existsSync(lock), 3_000);
    });
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, CONDUCTOR_HOME: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    const code = await new Promise((resolve) => {
      const p = execFile(process.execPath, [BIN, 'run', '--', process.execPath, '-e', 'process.exit(7)'], { env, cwd: mkdtempSync(join(tmpdir(), 'cproj-')) });
      p.once('exit', (c) => resolve(c));
    });
    assert.equal(code, 7);
    const top = await new Promise((resolve) => {
      execFile(process.execPath, [BIN, 'top'], { env }, (_e, stdout) => resolve(stdout));
    });
    assert.match(String(top), /走行も待ちも無い/);
  });
});
