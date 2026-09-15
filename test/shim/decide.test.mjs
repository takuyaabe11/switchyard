// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideShim, formatAnswer } from '../../src/shim/decide.mjs';

const DECIDE = fileURLToPath(new URL('../../src/shim/decide.mjs', import.meta.url));

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

  it('既定表に当たれば run とその profile 名', () => {
    assert.deepEqual(decideShim({ word: 'npm', args: ['test'], cwd: plainDir(), env: {} }), { kind: 'run', profile: 'default:batch' });
    assert.deepEqual(decideShim({ word: 'node', args: ['benchmarks/run.mjs'], cwd: plainDir(), env: {} }), { kind: 'run', profile: 'default:measure' });
  });

  it('どれにも当たらなければ pass', () => {
    assert.deepEqual(decideShim({ word: 'npm', args: ['install'], cwd: plainDir(), env: {} }), { kind: 'pass' });
  });

  it('プロジェクト設定の profile は既定表より先に当たる', () => {
    const dir = plainDir();
    writeFileSync(join(dir, 'conductor.json'), JSON.stringify({ profiles: { unit: { match: ['node --test*'], class: 'batch' } } }));
    assert.deepEqual(decideShim({ word: 'node', args: ['--test', 'a.test.mjs'], cwd: dir, env: {} }), { kind: 'run', profile: 'unit' });
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
