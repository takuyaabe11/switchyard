// @ts-check
// Windows(Git for Windows)での通し。POSIX の仕組みを見るテストは Windows では飛ばすので、Windows の経路はここで見る。
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopDaemon } from '../src/daemon/control.mjs';
import { pathsOf } from '../src/daemon/paths.mjs';
import { startDaemon } from '../src/daemon/server.mjs';
import { findGitBash, toBashPath } from '../src/platform.mjs';
import { spawnMeasured, windowsExe } from '../src/run/group.mjs';
import { buildRequest, runJob } from '../src/run/run.mjs';
import { connectDaemon } from '../src/client/connect.mjs';
import { tempHome } from '../testkit/tmp.mjs';
import { waitFor } from '../testkit/wait.mjs';
import { WIN } from '../testkit/platform.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const node = process.execPath;
const noAutoStart = (/** @type {any} */ o) => connectDaemon({ ...o, autoStart: false });

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('Windows(Git for Windows)', { skip: WIN ? false : 'Windows だけの通し' }, () => {
  it('Git Bash が見つかる', () => {
    assert.ok(findGitBash() !== null);
  });

  it('名前でもパスでも、.exe を探す。bash のスクリプト(拡張子なし)は null', () => {
    const exe = windowsExe('node');
    assert.ok(exe !== null && /node\.exe$/i.test(exe), String(exe));
    assert.equal(windowsExe(node.replace(/\.exe$/i, '')), node);
    const dir = mkdtempSync(join(tmpdir(), 'cwin-'));
    writeFileSync(join(dir, 'fake'), '#!/bin/sh\nexit 0\n');
    assert.equal(windowsExe(join(dir, 'fake')), null);
  });

  it('.exe はそのまま起動し、C:\\… のパスの引数を壊さず渡し、終了コードを返す。CPU 時間は測らない(null)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwin-'));
    const file = join(dir, 'out.txt');
    const { child, cpuMs } = spawnMeasured([node, '-e', `require('fs').writeFileSync(${JSON.stringify(file)}, 'ok'); process.exit(3)`]);
    const code = await new Promise((r) => child.once('exit', (c) => r(c)));
    assert.equal(code, 3);
    assert.equal(readFileSync(file, 'utf8'), 'ok');
    assert.equal(await cpuMs, null);
  });

  it('拡張子の無い sh のスクリプトは Git Bash の下で走らせ、終了コードを返す', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cwin-'));
    const script = join(dir, 'fake-tool');
    const out = join(dir, 'out.txt');
    writeFileSync(script, '#!/bin/sh\necho "args:$*" > "$1"\nexit 5\n');
    const { child } = spawnMeasured([script, out, 'b']);
    const code = await new Promise((r) => child.once('exit', (c) => r(c)));
    assert.equal(code, 5);
    assert.match(readFileSync(out, 'utf8'), /args:.*out\.txt b/);
  });

  it('子を止められないので、preempt の宣言は never として要求する', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    assert.equal(buildRequest({ argv: ['npm', 'test'], flags: { preempt: 'pause' }, env: {}, cwd }).job.preempt, 'never');
  });

  it('名前付きパイプのデーモンを通して走らせ、終了コードを返す', async () => {
    const home = tempHome();
    const d = await startDaemon({ home, capacity: 2, tickMs: 20 });
    cleanups.push(() => d.close());
    const code = await runJob({ argv: [node, '-e', 'process.exit(4)'], flags: {}, home, cwd: home, out: () => {}, connect: noAutoStart });
    assert.equal(code, 4);
  });

  it('呼び出し元の SIGTERM で、子の木(孫も)ごと止める', async () => {
    const home = tempHome();
    const d = await startDaemon({ home, capacity: 2, tickMs: 20 });
    cleanups.push(() => d.close());
    const dir = mkdtempSync(join(tmpdir(), 'cwin-'));
    const pidFile = join(dir, 'grandchild.pid');
    const script = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setInterval(() => {}, 1000);`;
    const signals = new EventEmitter();
    const p = runJob({ argv: [node, '-e', script], flags: {}, home, cwd: dir, out: () => {}, connect: noAutoStart, signals: /** @type {any} */ (signals), killGraceMs: 500 });
    await waitFor(() => existsSync(pidFile), 10_000);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(alive(grandchild));
    signals.emit('SIGTERM');
    await p;
    await waitFor(() => !alive(grandchild), 5_000);
  });

  it('SessionStart が書く PATH の行を Git Bash で読むと、shim が重い走行を switchyard run で包む', async () => {
    const home = tempHome();
    cleanups.push(async () => {
      await stopDaemon({ home });
      await waitFor(() => !existsSync(pathsOf(home).lock), 5_000);
    });
    const bash = findGitBash();
    assert.ok(bash !== null);
    const fake = mkdtempSync(join(tmpdir(), 'cfake-'));
    writeFileSync(join(fake, 'npm'), '#!/bin/sh\necho "fake-npm $* in=${SWITCHYARD_IN_JOB:-none} job=${SWITCHYARD_JOB_ID:-none}"\n');
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const command = [`export PATH='${toBashPath(fake)}':"$PATH"`, `export PATH='${toBashPath(join(ROOT, 'shims'))}':"$PATH"`, 'npm test'].join('; ');
    const out = await new Promise((resolve) => {
      execFile(bash, ['-c', command], { cwd, timeout: 30_000, env: { ...process.env, SWITCHYARD_HOME: home } }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
    const r = /** @type {{ err: Error | null, stdout: string, stderr: string }} */ (out);
    assert.equal(r.err, null, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /fake-npm test in=1 job=j/, `${r.stdout}\n${r.stderr}`);
  });
});
