// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultHeadWords, LEGACY_CONFIG } from '../../src/config/profiles.mjs';
import { GIT_LOCK_SUBCOMMANDS } from '../../src/shim/decide.mjs';
import { stopDaemon } from '../../src/daemon/control.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { tempHome } from '../../testkit/tmp.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SHIMS = realpathSync(join(ROOT, 'shims'));
const SHIM_WORDS = ['npm', 'npx', 'node', 'cargo', 'pytest', 'go', 'make', 'git', 'yarn', 'pnpm', 'bun', 'python', 'python3', 'uv', 'poetry', 'mvn', 'gradle', 'dotnet', 'bundle', 'rspec', 'deno'];

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
  const vars = 'job=${SWITCHYARD_JOB_ID:-none} in=${SWITCHYARD_IN_JOB:-none} held=${SWITCHYARD_HELD_LOCKS:-none}';
  writeFileSync(join(dir, 'npm'), `#!/bin/sh\necho "fake-npm $* ${vars}"\n`);
  writeFileSync(join(dir, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = rev-parse ] && exec ${REAL_GIT} "$@"; done\necho "fake-git $* ${vars}"\n`);
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
  // shim の中の `switchyard run` は、届かなければデーモンを切り離して起動する。
  // 試験が終わってもそれが残り続けていた(実測: 1 回の全件で 10 本以上・1 本あたり約 42MB)ので、後始末に積む
  cleanups.push(() => stopDaemon({ home }));
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, timeout: 15_000, killSignal: 'SIGKILL', env: { HOME: process.env.HOME ?? '', SWITCHYARD_HOME: home, PATH: path ?? `${SHIMS}:${fake}:${BASE_PATH}`, SWITCHYARD_GIT: '1', ...env } },
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

/**
 * shims の写しと、与えた中身の分類器(src/shim/decide.mjs)だけを持つ root を作り、その shims の実パスを返す
 * @param {string} decideSource
 */
function shimsWithClassifier(decideSource) {
  const root = mkdtempSync(join(tmpdir(), 'croot-'));
  cpSync(SHIMS, join(root, 'shims'), { recursive: true });
  for (const word of SHIM_WORDS) chmodSync(join(root, 'shims', word), 0o755);
  mkdirSync(join(root, 'src', 'shim'), { recursive: true });
  writeFileSync(join(root, 'src', 'shim', 'decide.mjs'), decideSource);
  return realpathSync(join(root, 'shims'));
}

describe('shims(設計 §9.1)', () => {
  it('shims に 21 語がそろい、どれも実行できる', () => {
    for (const word of SHIM_WORDS) assert.ok((statSync(join(SHIMS, word)).mode & 0o111) !== 0, word);
  });

  it('sh のふるいの語が、既定表の glob が始まる語と一致する(片方だけ直す事故を止める)', () => {
    const src = readFileSync(join(SHIMS, '_shim.sh'), 'utf8');
    const m = /case "\$name" in\n\s*([^)]*)\)/.exec(src);
    assert.notEqual(m, null, 'ふるいの case が見つからない');
    const inSieve = String(m?.[1]).split('|').map((w) => w.trim()).filter((w) => w !== '').sort();
    assert.deepEqual(inSieve, defaultHeadWords());
  });

  it('sh の git のサブコマンドの集合と大域オプションが、分類器と一致する(片方だけ直す事故を止める)', () => {
    const src = readFileSync(join(SHIMS, '_shim.sh'), 'utf8');
    const subs = /case "\$git_sub" in\n\s*([^)]*)\)/.exec(src);
    assert.notEqual(subs, null, 'git のサブコマンドの case が見つからない');
    assert.deepEqual(String(subs?.[1]).split('|').map((w) => w.trim()).sort(), [...GIT_LOCK_SUBCOMMANDS].sort());
  });

  it('SWITCHYARD_OFF=1 なら、重い走行もデーモンに繋がずにそのまま本物を走らせる', async () => {
    const { home } = await daemon();
    const r = await sh('npm test', { cwd: plainDir(), home, env: { SWITCHYARD_OFF: '1' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /job=none/);
  });

  it('既定(SWITCHYARD_GIT が 1 でない)では、git commit も node を起動せずに、そのまま本物を走らせる', async () => {
    const { home } = await daemon();
    const repo = plainDir();
    execFileSync(REAL_GIT, ['init', '-q'], { cwd: repo });
    // 壊れた node を先に置く: shim の sh 部分が素通しすれば node は呼ばれない
    // (shim は node の失敗も標準エラーも飲み込んで本物へ戻るので、呼ばれたことを印のファイルで確かめる)
    const broken = mkdtempSync(join(tmpdir(), 'cnode-'));
    const mark = join(broken, 'called');
    writeFileSync(join(broken, 'node'), `#!/bin/sh\ntouch '${mark}'\nexit 97\n`);
    chmodSync(join(broken, 'node'), 0o755);
    const fake = fakeBin();
    const r = await sh('git commit -m x', { cwd: repo, home, path: `${SHIMS}:${broken}:${fake}:${BASE_PATH}`, env: { SWITCHYARD_GIT: '0' } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^fake-git commit -m x job=none /m);
    assert.equal(existsSync(mark), false, 'node が呼ばれた');
  });

  it('git -C <repo> commit も鍵だけのジョブとして包み、鍵は -C の先の repo の git-dir', async () => {
    const { home } = await daemon();
    const repo = plainDir();
    execFileSync(REAL_GIT, ['init', '-q'], { cwd: repo });
    const r = await sh(`git -C '${repo}' commit -m x`, { cwd: plainDir(), home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^fake-git -C \\S+ commit -m x job=j\\S+ in=none held=git-index:${realpathSync(join(repo, '.git'))}$`, 'm'));
  });

  it('shebang で起動した node_modules/.bin のスクリプトは、switchyard.json が無くても npx と同じに包む', async () => {
    const { home } = await daemon();
    const cwd = plainDir();
    mkdirSync(join(cwd, 'node_modules', '.bin'), { recursive: true });
    const bin = join(cwd, 'node_modules', '.bin', 'vitest');
    writeFileSync(bin, '#!/usr/bin/env node\nconsole.log(`fake-vitest ${process.argv.slice(2).join(" ")} job=${process.env.SWITCHYARD_JOB_ID ?? "none"}`)\n');
    chmodSync(bin, 0o755);
    const r = await sh('./node_modules/.bin/vitest run', { cwd, home });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^fake-vitest run job=j\S+$/m);
    assert.deepEqual(history(home).map((h) => h.profile), ['default:batch']);
  });

  it('python は -m pytest のときだけ分類器にかけ、それ以外は node を起動せずに本物へ直行する', async () => {
    const { home } = await daemon();
    const cwd = plainDir();
    const fake = fakeBin();
    writeFileSync(join(fake, 'python3'), '#!/bin/sh\necho "fake-python3 $* job=${SWITCHYARD_JOB_ID:-none}"\n');
    chmodSync(join(fake, 'python3'), 0o755);
    // node を PATH に置かない: ふるいで直行するなら、それでも本物が走る
    const noNode = await sh('python3 script.py', { cwd, home, path: `${SHIMS}:${fake}:/usr/bin:/bin` });
    assert.equal(noNode.stdout.trim(), 'fake-python3 script.py job=none');
    const otherModule = await sh('python3 -m http.server', { cwd, home, path: `${SHIMS}:${fake}:/usr/bin:/bin` });
    assert.equal(otherModule.stdout.trim(), 'fake-python3 -m http.server job=none', 'pytest 以外の -m も node を起動しない');
    const r = await sh('python3 -m pytest -q', { cwd, home, path: `${SHIMS}:${fake}:${BASE_PATH}` });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^fake-python3 -m pytest -q job=j\S+$/m);
    assert.deepEqual(history(home).map((h) => h.profile), ['default:batch']);
  });

  it('switchyard.json が無い repo では、既定表に無い語は node を起動せずに本物へ直行する', async () => {
    const { home } = await daemon();
    const cwd = plainDir();
    // node を PATH から外す。ふるいが効いていれば分類器を呼ばないので、それでも本物が走る
    const fake = fakeBin();
    const r = await sh('npm run lint', { cwd, home, path: `${SHIMS}:${fake}:${BASE_PATH}` });
    assert.match(r.stdout, /fake-npm run lint/);
    assert.deepEqual(history(home), [], 'ジョブにならない');
  });

  it('改名の前の conductor.json があるときも、ふるいを通さず分類器にかける', async () => {
    const { home } = await daemon();
    const cwd = plainDir();
    writeFileSync(join(cwd, LEGACY_CONFIG), JSON.stringify({ profiles: { lint: { match: ['npm run lint*'], class: 'batch', cpus: { min: 1, max: 1 } } } }));
    const r = await sh('npm run lint', { cwd, home, env: { SWITCHYARD_TICK_MS: '20' } });
    assert.match(r.stdout, /fake-npm run lint/);
    assert.deepEqual(history(home).map((h) => h.profile), ['lint'], '古い名前の設定でも包まれる');
  });

  it('switchyard.json があれば、ふるいを通さず分類器にかける', async () => {
    const { home } = await daemon();
    const cwd = plainDir();
    writeFileSync(join(cwd, 'switchyard.json'), JSON.stringify({ profiles: { lint: { match: ['npm run lint*'], class: 'batch', cpus: { min: 1, max: 1 } } } }));
    const r = await sh('npm run lint', { cwd, home, env: { SWITCHYARD_TICK_MS: '20' } });
    assert.match(r.stdout, /fake-npm run lint/);
    assert.deepEqual(history(home).map((h) => h.profile), ['lint'], '包まれてジョブになる');
  });

  it('管理対象(npm test)は switchyard run に包まれ、子にジョブの印が渡る', async () => {
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

  it('SWITCHYARD_IN_JOB=1 なら、ジョブを作らずに本物へ直行する', async () => {
    const { home } = await daemon();
    const r = await sh('npm test', { cwd: plainDir(), home, env: { SWITCHYARD_IN_JOB: '1' } });
    assert.equal(r.stdout.trim(), 'fake-npm test job=none in=1 held=none');
    assert.deepEqual(history(home), []);
  });

  it('node が PATH に無ければ、本物をそのまま実行する(作業を止めない)', async () => {
    const fake = fakeBin();
    // PATH を shims と偽のコマンドだけにする(/usr/bin に node がある機械でも node が見つからない形になる。shim は外部コマンドを使わない)
    const r = await sh('npm test', { cwd: plainDir(), home: tempHome(), path: `${SHIMS}:${fake}` });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'fake-npm test job=none in=none held=none');
  });

  it('分類器が失敗したら(終了コード 0 以外)、答えを出していても本物をそのまま実行する', async () => {
    const shims = shimsWithClassifier("process.stdout.write('run default:batch\\n');\nprocess.exit(3);\n");
    const r = await sh('npm test', { cwd: plainDir(), home: tempHome(), path: `${shims}:${fakeBin()}:${BASE_PATH}` });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'fake-npm test job=none in=none held=none');
  });

  it('分類器が想定外の答えを出したら、本物をそのまま実行する', async () => {
    const shims = shimsWithClassifier("process.stdout.write('garbage\\n');\n");
    const r = await sh('npm test', { cwd: plainDir(), home: tempHome(), path: `${shims}:${fakeBin()}:${BASE_PATH}` });
    assert.equal(r.code, 0, r.stderr);
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
    const r = await sh('git stash', { cwd, home, env: { SWITCHYARD_HELD_LOCKS: lock } });
    assert.equal(r.stdout.trim(), `fake-git stash job=none in=none held=${lock}`);
    assert.deepEqual(history(home), []);
  });

  it('本物が PATH に無ければ 127 で終わり、そう表示する', async () => {
    const r = await sh('pytest', { cwd: plainDir(), home: tempHome(), path: SHIMS });
    assert.equal(r.code, 127);
    assert.match(r.stderr, /本物の pytest が PATH に見つからない/);
  });
});
