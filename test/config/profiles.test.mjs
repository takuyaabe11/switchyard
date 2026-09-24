// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyTemplate, classifiableCommand, classify, DEFAULT_PROFILES, defaultHeadWords, globMatch, isInspect, LEGACY_CONFIG, loadProfiles, segments, validateProfile } from '../../src/config/profiles.mjs';

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
    { name: 'bench', profile: { match: ['npm run benchmark*'], class: 'measure' } },
  ];
  const profiles = [...own, ...DEFAULT_PROFILES];

  it('部分の中では並び順で先に当たったもの(プロジェクト設定が既定表に勝つ)', () => {
    assert.equal(classify('npm run bench:quick', profiles)?.name, 'bench-quick');
  });

  it('部分をまたいでは重い class を採る', () => {
    assert.equal(classify('npm run e2e && npm run benchmark', profiles)?.name, 'bench');
  });

  it('どれにも当たらなければ null', () => {
    assert.equal(classify('git status', profiles), null);
  });

  it('既定表: npm test は batch', () => {
    assert.equal(classify('npm test', DEFAULT_PROFILES)?.profile.class, 'batch');
  });
});

describe('既定表(設計 §9.3)', () => {
  it('measure を持たない。計測はプロジェクトの設定か --class measure だけが決める(マシンの独占を推測で当てない)', () => {
    assert.deepEqual(
      DEFAULT_PROFILES.map((p) => p.profile.class),
      ['batch'],
    );
    assert.equal(classify('npm run benchmark', DEFAULT_PROFILES), null);
    assert.equal(classify('node benchmarks/run.mjs', DEFAULT_PROFILES), null);
    assert.equal(classify('cat benchmarks/standards.json', DEFAULT_PROFILES), null);
  });

  it('語の途中には当てない: makeinfo / pytest-watch は make・pytest ではない', () => {
    assert.equal(classify('makeinfo doc.texi', DEFAULT_PROFILES), null);
    assert.equal(classify('makepkg -si', DEFAULT_PROFILES), null);
    assert.equal(classify('pytest-watch', DEFAULT_PROFILES), null);
    // 本体はこれまでどおり当たる
    assert.equal(classify('make', DEFAULT_PROFILES)?.profile.class, 'batch');
    assert.equal(classify('make build', DEFAULT_PROFILES)?.profile.class, 'batch');
    assert.equal(classify('pytest tests/', DEFAULT_PROFILES)?.profile.class, 'batch');
  });

  it('どの glob も語で始まる(shim の sh のふるいが先頭の語だけで判断できる)', () => {
    for (const np of DEFAULT_PROFILES) for (const g of np.profile.match) assert.equal(g.startsWith('*'), false, g);
    assert.deepEqual(defaultHeadWords(), ['bun', 'cargo', 'go', 'make', 'npm', 'npx', 'pnpm', 'pytest', 'yarn']);
  });
});

describe('isInspect(走らせずに調べるだけの部分。改善 3)', () => {
  it('--version / --help / --list / --dry-run は、どこにあっても分類しない', () => {
    for (const cmd of [
      'make --version',
      'npm test -- --help',
      'cargo build --help',
      'npx playwright test --list --reporter=json',
      'go test --help',
      'pytest --version',
    ]) {
      assert.equal(isInspect(cmd), true, cmd);
      assert.equal(classify(cmd, DEFAULT_PROFILES), null, cmd);
    }
  });

  it('1 文字の旗は末尾のときだけ。値を取る形(pytest -n 4)は分類したまま', () => {
    assert.equal(isInspect('make -n'), true);
    assert.equal(isInspect('pytest -n 4'), false);
    assert.equal(isInspect('make -n build'), false);
    assert.equal(classify('pytest -n 4', DEFAULT_PROFILES)?.profile.class, 'batch');
    assert.equal(classify('make -n build', DEFAULT_PROFILES)?.profile.class, 'batch');
  });

  it('重い部分が別にあれば、そちらは分類される(部分ごとに見る)', () => {
    assert.equal(classify('make --version && npm test', DEFAULT_PROFILES)?.profile.class, 'batch');
  });
});

describe('classifiableCommand(分類に渡す文字列)', () => {
  it('node_modules/.bin の実行ファイルは、直に呼んでも shebang の node から呼んでも npx の形にする', () => {
    assert.equal(classifiableCommand(['./node_modules/.bin/vitest', 'run']), 'npx vitest run');
    assert.equal(classifiableCommand(['node', '/r/node_modules/.bin/jest', '--ci']), 'npx jest --ci');
    assert.equal(classifiableCommand(['node', 'scripts/node_modules.bin/x']), 'node scripts/node_modules.bin/x');
  });

  it('既定表は npm run test・npm t・yarn / pnpm / bun・cargo の重いサブコマンドも見る', () => {
    for (const c of ['npm run test', 'npm run test:unit', 'npm t', 'yarn test', 'pnpm run build', 'bun test', 'cargo nextest run', 'cargo clippy', 'npx jest', 'go build ./...']) {
      assert.equal(classify(c, DEFAULT_PROFILES)?.name, 'default:batch', c);
    }
    for (const c of ['npm run lint', 'yarn install', 'pnpm add x', 'bun run dev', 'npm --version']) assert.equal(classify(c, DEFAULT_PROFILES), null, c);
  });

  it('node の -e / --eval / -p / --print の値(インラインのコード)を除く', () => {
    assert.equal(classifiableCommand(['node', '-e', 'require("./benchmarks/standards.json")']), 'node -e');
    assert.equal(classifiableCommand(['node', '--input-type=module', '-e', 'import "vitest run"', 'arg']), 'node --input-type=module -e arg');
    assert.equal(classifiableCommand(['node', '--eval=console.log("vitest run")']), 'node --eval');
    assert.equal(classifiableCommand(['/usr/local/bin/node', '-p', '"measure"']), '/usr/local/bin/node -p');
    assert.equal(classifiableCommand(['node', '--print', '1', 'x']), 'node --print x');
  });

  it('node 以外と、スクリプトを走らせる node はそのまま空白でつなぐ', () => {
    assert.equal(classifiableCommand(['node', 'benchmarks/run.mjs', '-e', 'x']), 'node benchmarks/run.mjs -e x');
    assert.equal(classifiableCommand(['npm', 'test', '-e', 'x']), 'npm test -e x');
    assert.equal(classifiableCommand(['npx', 'vitest', 'run']), 'npx vitest run');
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
  it('switchyard.json が無ければ既定表だけ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchyard-'));
    assert.deepEqual(loadProfiles(dir), { profiles: DEFAULT_PROFILES, error: null });
  });

  it('プロジェクトの profile を既定表の前に並べる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchyard-'));
    writeFileSync(join(dir, 'switchyard.json'), JSON.stringify({ profiles: { unit: { match: ['npm test'], class: 'batch' } } }));
    const r = loadProfiles(dir);
    assert.equal(r.error, null);
    assert.deepEqual(r.profiles.map((p) => p.name), ['unit', ...DEFAULT_PROFILES.map((p) => p.name)]);
  });

  it('switchyard.json が無く conductor.json があれば、そちらを読んで知らせを付ける(改名の移行)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchyard-'));
    writeFileSync(join(dir, LEGACY_CONFIG), JSON.stringify({ profiles: { e2e: { match: ['npm run e2e*'], class: 'batch', locks: ['port:4173'] } } }));
    const r = loadProfiles(dir);
    assert.equal(r.error, null);
    assert.deepEqual(r.profiles.map((p) => p.name), ['e2e', ...DEFAULT_PROFILES.map((p) => p.name)], '古い名前でも profile は効く');
    assert.match(r.notice ?? '', /conductor\.json を読んだ/);
  });

  it('switchyard.json があれば conductor.json は見ない(知らせも出さない)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchyard-'));
    writeFileSync(join(dir, 'switchyard.json'), JSON.stringify({ profiles: { neu: { match: ['npm test'], class: 'batch' } } }));
    writeFileSync(join(dir, LEGACY_CONFIG), JSON.stringify({ profiles: { alt: { match: ['npm test'], class: 'measure' } } }));
    const r = loadProfiles(dir);
    assert.deepEqual(r.profiles.map((p) => p.name), ['neu', ...DEFAULT_PROFILES.map((p) => p.name)]);
    assert.equal(r.notice, undefined);
  });

  it('壊れた設定は既定表に戻し、理由を返す', () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchyard-'));
    writeFileSync(join(dir, 'switchyard.json'), '{ not json');
    const r = loadProfiles(dir);
    assert.deepEqual(r.profiles, DEFAULT_PROFILES);
    assert.match(r.error ?? '', /switchyard.json を読めない/);
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
