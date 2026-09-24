// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldLocks, repoFamily, repoRoot } from '../../src/config/context.mjs';

/** @returns {string} */
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'switchyard-context-')));

describe('repoRoot(設計 §4.5)', () => {
  it('.git を持つ最も近い祖先を返す', () => {
    const root = tmp();
    mkdirSync(join(root, '.git'));
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    assert.equal(repoRoot(deep), root);
    assert.equal(repoRoot(root), root);
  });

  it('.git がファイル(worktree・submodule)でも作業ツリーの根とみなす', () => {
    const root = tmp();
    writeFileSync(join(root, '.git'), 'gitdir: /somewhere/.git/worktrees/x\n');
    const deep = join(root, 'a');
    mkdirSync(deep);
    assert.equal(repoRoot(deep), root);
  });

  it('.git がどこにも無ければ cwd を返す', () => {
    const root = tmp();
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    assert.equal(repoRoot(deep), deep);
  });

  it('git を起動しないので、git が中身を認めない .git でも根を返す(速さの担保)', () => {
    // .git が空のディレクトリなら `git rev-parse --show-toplevel` は失敗する。
    // 上方探索なら失敗しない — この違いが、外部プロセスを呼んでいないことの証拠になる
    const root = tmp();
    mkdirSync(join(root, '.git'));
    const deep = join(root, 'sub');
    mkdirSync(deep);
    let gitFailed = false;
    try {
      execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: deep, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      gitFailed = true;
    }
    assert.equal(gitFailed, true, 'この土台では git が失敗するはず(失敗しないなら試験の前提が崩れている)');
    assert.equal(repoRoot(deep), root);
  });

  it('本物の repo では git rev-parse --show-toplevel と同じ答えを返す', () => {
    const here = realpathSync(new URL('..', import.meta.url).pathname);
    const fromGit = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).trim());
    assert.equal(repoRoot(here), fromGit);
  });
});

describe('heldLocks', () => {
  it('カンマ区切りを集合にし、空は落とす', () => {
    assert.deepEqual([...heldLocks({ SWITCHYARD_HELD_LOCKS: 'a,,b' })], ['a', 'b']);
    assert.deepEqual([...heldLocks({})], []);
  });
});

describe('repoFamily(同じ git の本体を共有する worktree の一族)', () => {
  const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

  it('本物の git worktree は本体の作業ツリーの根を返し、本体・git の外・commondir の無い .git ファイルはその根のまま', () => {
    const base = tmp();
    const main = join(base, 'app');
    mkdirSync(main);
    git(main, ['init', '-q']);
    writeFileSync(join(main, 'a.txt'), 'a');
    git(main, ['add', '.']);
    git(main, ['commit', '-q', '-m', 'x']);
    git(main, ['worktree', 'add', '-q', join(base, 'app-wt'), '-b', 'wt']);
    assert.equal(repoFamily(repoRoot(join(base, 'app-wt'))), main);
    assert.equal(repoFamily(main), main);
    const plain = tmp();
    assert.equal(repoFamily(plain), plain);
    // submodule のように commondir を持たない gitdir を指すファイル
    const sub = tmp();
    mkdirSync(join(sub, 'mod'));
    writeFileSync(join(sub, '.git'), `gitdir: ${join(sub, 'mod')}\n`);
    assert.equal(repoFamily(sub), sub);
  });
});
