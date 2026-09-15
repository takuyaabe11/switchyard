// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { tempHome } from '../../testkit/tmp.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHIMS = realpathSync(join(ROOT, 'shims'));
const SHIM_WORDS = ['npm', 'npx', 'node', 'cargo', 'pytest', 'go', 'make', 'git'];

/** 呼び出し元の PATH から shims を除いたもの(このテスト自体が shim の下で走っても本物を指す) */
const BASE_PATH = (process.env.PATH ?? '')
  .split(':')
  .filter((d) => d !== '' && (!existsSync(d) || realpathSync(d) !== SHIMS))
  .join(':');
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: { PATH: BASE_PATH } }).trim();

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** 偽の npm と git を置いたディレクトリ。git は rev-parse だけ本物へ回す */
function fakeBin() {
  const dir = mkdtempSync(join(tmpdir(), 'cfake-'));
  const vars = 'job=${CONDUCTOR_JOB_ID:-none} in=${CONDUCTOR_IN_JOB:-none} held=${CONDUCTOR_HELD_LOCKS:-none}';
  writeFileSync(join(dir, 'npm'), `#!/bin/sh\necho "fake-npm $* ${vars}"\n`);
  writeFileSync(join(dir, 'git'), `#!/bin/sh\ncase "$1" in rev-parse) exec ${REAL_GIT} "$@" ;; esac\necho "fake-git $* ${vars}"\n`);
  chmodSync(join(dir, 'npm'), 0o755);
  chmodSync(join(dir, 'git'), 0o755);
  return dir;
}

async function daemon() {
  const home = tempHome();
  const d = await startDaemon({ home, capacity: 4, tickMs: 20 });
  cleanups.push(() => d.close());
  return { d, home };
}

/**
 * sh -c で command を走らせる(shims を PATH の先頭に置く)
 * @param {string} command @param {{ cwd: string, home: string, path?: string, env?: Record<string, string> }} o
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function sh(command, { cwd, home, path, env = {} }) {
  const fake = fakeBin();
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, timeout: 15_000, killSignal: 'SIGKILL', env: { HOME: process.env.HOME ?? '', CONDUCTOR_HOME: home, PATH: path ?? `${SHIMS}:${fake}:${BASE_PATH}`, ...env } },
      (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof err.code === 'number' ? err.code : -1, stdout, stderr }),
    );
  });
}

/** @param {string} home */
const history = (home) =>
  existsSync(pathsOf(home).events)
    ? readFileSync(pathsOf(home).events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'history')
    : [];

const plainDir = () => mkdtempSync(join(tmpdir(), 'cproj-'));

describe('shims(設計 §9.1)', () => {
  it('shims に 8 語がそろい、どれも実行できる', () => {
    for (const word of SHIM_WORDS) assert.ok((statSync(join(SHIMS, word)).mode & 0o111) !== 0, word);
  });

  it('管理対象(npm test)は conductor run に包まれ、子にジョブの印が渡る', async () => {
    const { home } = await daemon();
    const r = await sh('npm test', { cwd: plainDir(), home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^fake-npm test job=j\S+ in=1 held=none$/m);
    assert.deepEqual(history(home).map((h) => [h.profile, h.code]), [['default:batch', 0]]);
  });

  it('管理対象でなければ、本物をそのまま実行する', async () => {
    const { home } = await daemon();
    const r = await sh('npm install x', { cwd: plainDir(), home });
    assert.equal(r.stdout.trim(), 'fake-npm install x job=none in=none held=none');
    assert.deepEqual(history(home), []);
  });

  it('CONDUCTOR_IN_JOB=1 なら、ジョブを作らずに本物へ直行する', async () => {
    const { home } = await daemon();
    const r = await sh('npm test', { cwd: plainDir(), home, env: { CONDUCTOR_IN_JOB: '1' } });
    assert.equal(r.stdout.trim(), 'fake-npm test job=none in=1 held=none');
    assert.deepEqual(history(home), []);
  });

  it('node が PATH に無ければ、本物をそのまま実行する(作業を止めない)', async (t) => {
    if (existsSync('/usr/bin/node') || existsSync('/bin/node')) {
      t.skip('/usr/bin か /bin に node がある');
      return;
    }
    const { home } = await daemon();
    const fake = fakeBin();
    const r = await sh('npm test', { cwd: plainDir(), home, path: `${SHIMS}:${fake}:/usr/bin:/bin` });
    assert.equal(r.stdout.trim(), 'fake-npm test job=none in=none held=none');
  });

  it('git commit は git-dir の鍵だけのジョブとして包み、鍵を子に渡す', async () => {
    const { home } = await daemon();
    const cwd = plainDir();
    execFileSync(REAL_GIT, ['init', '-q'], { cwd });
    const lock = `git-index:${realpathSync(join(cwd, '.git'))}`;
    const r = await sh('git commit -m x', { cwd, home });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(`fake-git commit -m x job=j`) && r.stdout.includes(` in=none held=${lock}`), r.stdout);
    assert.deepEqual(history(home).map((h) => [h.profile, h.cpus]), [['cmd:git commit', 0]]);
  });

  it('祖先が git の鍵を持っていれば、git stash はジョブを作らずに走る', async () => {
    const { home } = await daemon();
    const cwd = plainDir();
    execFileSync(REAL_GIT, ['init', '-q'], { cwd });
    const lock = `git-index:${realpathSync(join(cwd, '.git'))}`;
    const r = await sh('git stash', { cwd, home, env: { CONDUCTOR_HELD_LOCKS: lock } });
    assert.equal(r.stdout.trim(), `fake-git stash job=none in=none held=${lock}`);
    assert.deepEqual(history(home), []);
  });

  it('本物が PATH に無ければ 127 で終わり、そう表示する', async () => {
    const r = await sh('pytest', { cwd: plainDir(), home: tempHome(), path: SHIMS });
    assert.equal(r.code, 127);
    assert.match(r.stderr, /本物の pytest が PATH に見つからない/);
  });
});
