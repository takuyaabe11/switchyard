// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideShim, formatAnswer } from '../../src/shim/decide.mjs';

const DECIDE = fileURLToPath(new URL('../../src/shim/decide.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../../bin/conductor.mjs', import.meta.url));

/** git の外の一時ディレクトリ */
const plainDir = () => mkdtempSync(join(tmpdir(), 'cproj-'));

/** git init 済みの一時ディレクトリ */
function gitDir() {
  const dir = plainDir();
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

/** 呼ばれたら失敗させる git-dir の読み取り(git の index を触らない形で呼ばないことを確かめる) */
const mustNotRead = () => {
  throw new Error('git-dir を読んだ');
};

describe('decideShim(設計 §9.1)', () => {
  it('CPU を持つジョブの中では、何でも pass', () => {
    assert.deepEqual(decideShim({ word: 'npm', args: ['test'], cwd: plainDir(), env: { CONDUCTOR_IN_JOB: '1' } }), { kind: 'pass' });
  });

  it('既定表に当たれば run とその profile 名。既定表は measure を持たない', () => {
    assert.deepEqual(decideShim({ word: 'npm', args: ['test'], cwd: plainDir(), env: {} }), { kind: 'run', profile: 'default:batch' });
    assert.deepEqual(decideShim({ word: 'node', args: ['benchmarks/run.mjs'], cwd: plainDir(), env: {} }), { kind: 'pass' });
  });

  it('node -e のコードの中身では分類しない', () => {
    const vitest = [{ name: 'vitest', profile: { match: ['*vitest run*'], class: /** @type {const} */ ('batch') } }];
    const profilesFor = () => vitest;
    assert.deepEqual(decideShim({ word: 'node', args: ['-e', 'console.log("vitest run")'], cwd: plainDir(), env: {}, profilesFor }), { kind: 'pass' });
    assert.deepEqual(decideShim({ word: 'node', args: ['node_modules/.bin/vitest', 'run'], cwd: plainDir(), env: {}, profilesFor }), { kind: 'run', profile: 'vitest' });
  });

  it('node で呼んだこの plugin の conductor の CLI は、分類せずに pass(外側のジョブに包まない)', () => {
    const bench = [{ name: 'bench', profile: { match: ['*npm run bench*'], class: /** @type {const} */ ('measure') } }];
    const profilesFor = () => bench;
    const dir = plainDir();
    symlinkSync(CLI, join(dir, 'conductor.mjs'));
    assert.deepEqual(decideShim({ word: 'node', args: [CLI, 'run', '--lock', 'port:4173', '--', 'npm', 'run', 'bench'], cwd: dir, env: {}, profilesFor }), { kind: 'pass' });
    // 相対パス・symlink でも実パスで見分ける
    assert.deepEqual(decideShim({ word: 'node', args: ['conductor.mjs', 'run', '--', 'npm', 'run', 'bench'], cwd: dir, env: {}, profilesFor }), { kind: 'pass' });
    // 同じ名前の別のファイルは、いつもどおり分類する
    const other = plainDir();
    writeFileSync(join(other, 'conductor.mjs'), '');
    assert.deepEqual(decideShim({ word: 'node', args: ['conductor.mjs', 'run', '--', 'npm', 'run', 'bench'], cwd: other, env: {}, profilesFor }), { kind: 'run', profile: 'bench' });
  });

  it('どれにも当たらなければ pass', () => {
    assert.deepEqual(decideShim({ word: 'npm', args: ['install'], cwd: plainDir(), env: {} }), { kind: 'pass' });
  });

  it('プロジェクト設定の profile は既定表より先に当たる', () => {
    const dir = plainDir();
    writeFileSync(join(dir, 'conductor.json'), JSON.stringify({ profiles: { unit: { match: ['node --test*'], class: 'batch' } } }));
    assert.deepEqual(decideShim({ word: 'node', args: ['--test', 'a.test.mjs'], cwd: dir, env: {} }), { kind: 'run', profile: 'unit' });
  });

  it('profilesFor を渡せば、repo の設定を読まずにその profile で分類する(conductor replay の --config)', () => {
    const e2e = { name: 'e2e', profile: { match: ['npm run e2e*'], class: /** @type {const} */ ('batch'), locks: ['port:4173'] } };
    /** @type {string[]} */
    const asked = [];
    const dir = plainDir();
    const profilesFor = (/** @type {string} */ cwd) => {
      asked.push(cwd);
      return [e2e];
    };
    assert.deepEqual(decideShim({ word: 'npm', args: ['run', 'e2e'], cwd: dir, env: {}, profilesFor }), { kind: 'run', profile: 'e2e' });
    assert.deepEqual(asked, [dir]);
    // 渡さなければ repo(ここでは設定の無い一時ディレクトリ)の既定表で分類する
    assert.deepEqual(decideShim({ word: 'npm', args: ['run', 'e2e'], cwd: dir, env: {} }), { kind: 'pass' });
  });

  it('git commit は git-dir の実パスの鍵を持つ lock', () => {
    const dir = gitDir();
    assert.deepEqual(decideShim({ word: 'git', args: ['commit', '-m', 'x'], cwd: dir, env: {} }), { kind: 'lock', lock: `git-index:${realpathSync(join(dir, '.git'))}` });
  });

  it('index を書き換えない git は、git-dir を読まずに pass', () => {
    assert.deepEqual(decideShim({ word: 'git', args: ['status'], cwd: plainDir(), env: {}, gitDir: mustNotRead }), { kind: 'pass' });
    assert.deepEqual(decideShim({ word: 'git', args: [], cwd: plainDir(), env: {}, gitDir: mustNotRead }), { kind: 'pass' });
  });

  it('祖先が同じ git の鍵を持っていれば pass', () => {
    const dir = gitDir();
    const lock = `git-index:${realpathSync(join(dir, '.git'))}`;
    assert.deepEqual(decideShim({ word: 'git', args: ['stash'], cwd: dir, env: { CONDUCTOR_HELD_LOCKS: `other,${lock}` } }), { kind: 'pass' });
  });

  it('git の外の git commit は pass', () => {
    assert.deepEqual(decideShim({ word: 'git', args: ['commit'], cwd: plainDir(), env: {}, gitDir: () => null }), { kind: 'pass' });
  });

  it('答えを 1 行の文字列にする', () => {
    assert.deepEqual([formatAnswer({ kind: 'run', profile: 'p' }), formatAnswer({ kind: 'lock', lock: 'k' }), formatAnswer({ kind: 'pass' })], ['run p', 'lock k', 'pass']);
  });

  it('CLI として呼ぶと、答えを 1 行出す', () => {
    const env = { ...process.env };
    delete env.CONDUCTOR_IN_JOB;
    delete env.CONDUCTOR_HELD_LOCKS;
    assert.equal(execFileSync(process.execPath, [DECIDE, 'npm', 'test'], { cwd: plainDir(), env, encoding: 'utf8' }), 'run default:batch\n');
  });
});
