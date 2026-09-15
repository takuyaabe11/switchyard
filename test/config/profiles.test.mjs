// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTemplate, classify, DEFAULT_PROFILES, globMatch, loadProfiles, segments, validateProfile } from '../../src/config/profiles.mjs';

describe('globMatch', () => {
  it('* は任意の文字列、? は 1 文字、全体一致', () => {
    assert.equal(globMatch('npm run e2e*', 'npm run e2e:fast'), true);
    assert.equal(globMatch('npm run e2e*', 'x npm run e2e'), false);
    assert.equal(globMatch('go test', 'go test ./...'), false);
    assert.equal(globMatch('a?c', 'abc'), true);
    assert.equal(globMatch('a?c', 'ac'), false);
    assert.equal(globMatch('*bench*', 'npm run benchmark'), true);
  });

  it('本文に * があっても、グロブの * として扱う', () => {
    assert.equal(globMatch('echo *', 'echo *'), true);
    assert.equal(globMatch('a*b', 'a*xb'), true);
  });
});

describe('segments', () => {
  it('&& / || / ; / | で区切り、空白を整える', () => {
    assert.deepEqual(segments('cd x &&  npm   test | tee log; echo ok || true'), ['cd x', 'npm test', 'tee log', 'echo ok', 'true']);
  });

  it('空の部分は捨てる', () => {
    assert.deepEqual(segments(' ; npm test ;'), ['npm test']);
  });
});

describe('classify', () => {
  /** @type {import('../../src/config/profiles.mjs').NamedProfile[]} */
  const own = [
    { name: 'bench-quick', profile: { match: ['npm run bench:quick'], class: 'quick' } },
    { name: 'e2e', profile: { match: ['npm run e2e*'], class: 'batch', locks: ['port:4173'] } },
  ];
  const profiles = [...own, ...DEFAULT_PROFILES];

  it('部分の中では並び順で先に当たったもの(プロジェクト設定が既定表に勝つ)', () => {
    assert.equal(classify('npm run bench:quick', profiles)?.name, 'bench-quick');
  });

  it('部分をまたいでは重い class を採る', () => {
    assert.equal(classify('npm run e2e && npm run benchmark', profiles)?.name, 'default:measure');
  });

  it('どれにも当たらなければ null', () => {
    assert.equal(classify('git status', profiles), null);
  });

  it('既定表: npm test は batch', () => {
    assert.equal(classify('npm test', DEFAULT_PROFILES)?.profile.class, 'batch');
  });
});

describe('validateProfile', () => {
  it('正しい形はそのまま通す', () => {
    const p = validateProfile('u', { match: ['npm test'], class: 'batch', cpus: { min: 2, max: 8 }, locks: ['a'], env: { N: '{cpus}' }, args: ['--w={cpus}'], preempt: 'never' });
    assert.deepEqual(p, { match: ['npm test'], class: 'batch', cpus: { min: 2, max: 8 }, locks: ['a'], env: { N: '{cpus}' }, args: ['--w={cpus}'], preempt: 'never' });
  });

  it('形が違えば、どの項目かを名指しして投げる', () => {
    assert.throws(() => validateProfile('u', { match: [], class: 'batch' }), /profile u: match/);
    assert.throws(() => validateProfile('u', { match: ['x'], class: 'huge' }), /profile u: class/);
    assert.throws(() => validateProfile('u', { match: ['x'], class: 'batch', cpus: { min: 3, max: 2 } }), /profile u: cpus/);
    assert.throws(() => validateProfile('u', { match: ['x'], class: 'batch', preempt: 'stop' }), /profile u: preempt/);
    assert.throws(() => validateProfile('u', { match: ['x'], class: 'batch', env: { N: 1 } }), /profile u: env/);
  });
});

describe('loadProfiles', () => {
  it('conductor.json が無ければ既定表だけ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-'));
    assert.deepEqual(loadProfiles(dir), { profiles: DEFAULT_PROFILES, error: null });
  });

  it('プロジェクトの profile を既定表の前に並べる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-'));
    writeFileSync(join(dir, 'conductor.json'), JSON.stringify({ profiles: { unit: { match: ['npm test'], class: 'batch' } } }));
    const r = loadProfiles(dir);
    assert.equal(r.error, null);
    assert.deepEqual(r.profiles.map((p) => p.name), ['unit', ...DEFAULT_PROFILES.map((p) => p.name)]);
  });

  it('壊れた設定は既定表に戻し、理由を返す', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-'));
    writeFileSync(join(dir, 'conductor.json'), '{ not json');
    const r = loadProfiles(dir);
    assert.deepEqual(r.profiles, DEFAULT_PROFILES);
    assert.match(r.error ?? '', /conductor.json を読めない/);
  });
});

describe('applyTemplate', () => {
  it('env と args の {cpus} を置き換える', () => {
    assert.deepEqual(applyTemplate({ match: ['x'], class: 'batch', env: { A: '{cpus}', B: 'fixed' }, args: ['--w={cpus}'] }, 6), { env: { A: '6', B: 'fixed' }, args: ['--w=6'] });
  });

  it('雛形が無ければ空', () => {
    assert.deepEqual(applyTemplate({ match: ['x'], class: 'batch' }, 3), { env: {}, args: [] });
  });
});
