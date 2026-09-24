// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonUnavailableError } from '../../src/client/connect.mjs';
import { runJob } from '../../src/run/run.mjs';
import { tempHome } from '../../testkit/tmp.mjs';
import { waitFor } from '../../testkit/wait.mjs';
import { POSIX_ONLY } from '../../testkit/platform.mjs';

const node = process.execPath;

/** デーモンを使わない(信号の扱いだけを見る)。すぐ管理なしで子を起動する @type {typeof import('../../src/client/connect.mjs').connectDaemon} */
const unavailable = async () => {
  throw new DaemonUnavailableError('テスト');
};

/** 子のプロセスグループを確かめられなかったことにする差し替え(設計 §15) */
const noGroup = () => null;

/** ゾンビ(終わって回収を待つだけ。init が回収しないコンテナで残る)は生きていると数えない @param {string} file */
const pidAlive = (file) => {
  try {
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', readFileSync(file, 'utf8').trim()], { encoding: 'utf8' }).trim();
    return stat !== '' && !stat.startsWith('Z');
  } catch {
    return false;
  }
};

/**
 * @param {{ argv: string[], killGraceMs: number, cwd: string }} o
 */
function start({ argv, killGraceMs, cwd }) {
  const signals = new EventEmitter();
  const running = runJob({ argv, flags: {}, home: tempHome(), cwd, env: { ...process.env, SWITCHYARD_IN_JOB: '', SWITCHYARD_HELD_LOCKS: '' }, out: () => {}, connect: unavailable, signals, killGraceMs, verifyGroup: noGroup });
  return { signals, running };
}

describe('信号(pgid を確かめられないとき。設計 §4.3 の 3・5)', { skip: POSIX_ONLY }, () => {
  it('呼び出し元の SIGTERM は子の pid だけに届き、グループ(孫)には送らない', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const pidFile = join(cwd, 'grandchild.pid');
    const { signals, running } = start({ argv: ['sh', '-c', `sleep 30 & echo $! > ${pidFile}; wait`], killGraceMs: 2000, cwd });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    try {
      signals.emit('SIGTERM');
      assert.equal(await running, 143);
      assert.equal(pidAlive(pidFile), true, 'グループへ送らないはずなのに、孫が終わった');
    } finally {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL');
      } catch {
        // 既に居ない
      }
    }
  });

  it('SIGTERM を無視する子は、猶予の後に SIGKILL で終わる', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const ready = join(cwd, 'ready');
    const { signals, running } = start({
      argv: [node, '-e', `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000)`],
      killGraceMs: 300,
      cwd,
    });
    await waitFor(() => existsSync(ready));
    const t0 = Date.now();
    signals.emit('SIGTERM');
    assert.equal(await running, 137);
    assert.ok(Date.now() - t0 >= 250, `猶予より早く終わった: ${Date.now() - t0}ms`);
  });

  it('猶予の内に終わった子には SIGKILL を送らず、すぐ返す', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const ready = join(cwd, 'ready');
    const { signals, running } = start({
      argv: [node, '-e', `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50)); require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000)`],
      killGraceMs: 3000,
      cwd,
    });
    await waitFor(() => existsSync(ready));
    const t0 = Date.now();
    signals.emit('SIGTERM');
    assert.equal(await running, 0);
    assert.ok(Date.now() - t0 < 1500, `終わるまでに ${Date.now() - t0}ms かかった`);
  });

  it('信号を 2 回受けても、SIGKILL までの猶予は最初の転送から測る', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const ready = join(cwd, 'ready');
    const { signals, running } = start({
      argv: [node, '-e', `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => {}, 1000)`],
      killGraceMs: 600,
      cwd,
    });
    await waitFor(() => existsSync(ready));
    const t0 = Date.now();
    signals.emit('SIGTERM');
    setTimeout(() => signals.emit('SIGTERM'), 400);
    assert.equal(await running, 137);
    assert.ok(Date.now() - t0 < 900, `最初の転送から ${Date.now() - t0}ms かかった(2 回目で猶予が始まり直している)`);
  });
});
