// @ts-check
// 既定の表の走行を学ぶ単位(src/config/variant.mjs)と、PreToolUse と switchyard run が同じ名前を出すこと、replay のばらつきの数え方
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifiableCommand, DEFAULT_PROFILES } from '../../src/config/profiles.mjs';
import { learnedName, profileNameOf, variantOf } from '../../src/config/variant.mjs';
import { preToolUse } from '../../src/hooks/pretooluse.mjs';
import { compareUnits, spreadOf, unitsOf } from '../../src/replay/variants.mjs';
import { buildRequest } from '../../src/run/run.mjs';

describe('variantOf(道具とサブコマンド・絞っているか)', () => {
  it('オプションより前の名前の語を 3 語まで。先頭の語はパスを外す', () => {
    assert.equal(variantOf('npm test'), 'npm test');
    assert.equal(variantOf('npm run build:prod'), 'npm run build:prod');
    assert.equal(variantOf('npx vitest run'), 'npx vitest run');
    assert.equal(variantOf('mvn clean install verify'), 'mvn clean install');
    assert.equal(variantOf('/usr/local/bin/cargo test --release'), 'cargo test');
    assert.equal(variantOf('make -j8 all'), 'make');
    assert.equal(variantOf('npx tsc -p .'), 'npx tsc');
    assert.equal(variantOf(''), '');
  });

  it('python -m は、モジュールまでを道具とみなす', () => {
    assert.equal(variantOf('python3 -m pytest -q'), 'python3 -m pytest');
    assert.equal(variantOf('python -m pytest tests/a.py'), 'python -m pytest …');
    assert.equal(variantOf('node -m x'), 'node');
  });

  it('パス・ファイル・テストの id・絞り込みのオプションがあれば「 …」を付ける。全体を指す引数(./...)は付けない', () => {
    assert.equal(variantOf('pytest tests/test_a.py'), 'pytest …');
    assert.equal(variantOf('pytest test_a.py'), 'pytest …');
    assert.equal(variantOf('pytest tests/test_a.py::test_x'), 'pytest …');
    assert.equal(variantOf('cargo test parser::tests'), 'cargo test …');
    assert.equal(variantOf('pytest -k login'), 'pytest …');
    assert.equal(variantOf('npm test -- --grep=login'), 'npm test …');
    assert.equal(variantOf('npm test -- -t login'), 'npm test …');
    assert.equal(variantOf('go test ./...'), 'go test');
    assert.equal(variantOf('go test ./pkg/a'), 'go test …');
    assert.equal(variantOf('cargo test -p core'), 'cargo test');
    // オプションの後ろの名前の語は、サブコマンドにも絞り込みにも数えない
    assert.equal(variantOf('npm test --reporter dot'), 'npm test');
  });

  it('learnedName は既定の表の profile にだけ単位を付け、秘密らしい値を隠す。profileNameOf で表の名前に戻る', () => {
    assert.equal(learnedName('default:batch', 'npm test'), 'default:batch npm test');
    assert.equal(learnedName('unit', 'npm test'), 'unit');
    assert.equal(learnedName('cmd:x', 'npm test'), 'cmd:x');
    assert.equal(learnedName('default:batch npm test', 'npm test'), 'default:batch npm test');
    assert.equal(learnedName('default:batch', ''), 'default:batch');
    assert.equal(learnedName('default:batch', 'npm run API_TOKEN=abc'), 'default:batch npm run');
    assert.equal(learnedName('default:batch', `npm run ghp_${'a'.repeat(36)}`), 'default:batch npm run');
    assert.equal(profileNameOf('default:batch npm test'), 'default:batch');
    assert.equal(profileNameOf('unit tests'), 'unit tests');
  });
});

describe('PreToolUse と switchyard run が同じ単位の名前を出す(盤面の学んだ値を同じ鍵で引く)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cvar-'));
  /** @param {string} command */
  const hookName = (command) => {
    /** @type {string[]} */
    const names = [];
    preToolUse({ tool_name: 'Bash', tool_input: { command }, cwd }, { env: {}, profilesFor: () => DEFAULT_PROFILES, shouldBackground: (h) => (names.push(...h.map((x) => x.profile ?? '')), false) });
    return names;
  };
  /** @param {string[]} argv */
  const runName = (argv) => buildRequest({ argv, flags: {}, env: {}, cwd }).job.profile;

  it('shim の語・node_modules/.bin・python -m・switchyard run の包み', () => {
    for (const argv of [['npm', 'test'], ['npm', 'run', 'build:prod'], ['npx', 'tsc', '-p', '.'], ['pytest', 'tests/a.py', '-x'], ['python3', '-m', 'pytest', '-q'], ['cargo', 'test', '--release'], ['go', 'test', './...']]) {
      assert.deepEqual(hookName(argv.join(' ')), [runName(argv)], argv.join(' '));
    }
    assert.deepEqual(hookName('./node_modules/.bin/vitest run'), [runName(['./node_modules/.bin/vitest', 'run'])]);
    assert.equal(runName(['./node_modules/.bin/vitest', 'run']), 'default:batch npx vitest run');
    // 包みそのものと、中の shim の語の両方が同じ名前になる
    assert.deepEqual(hookName('cd app && switchyard run -- npm test'), ['default:batch npm test', 'default:batch npm test']);
  });

  it('switchyard run --profile は単位の名前を受け付け、表は profile の名前で引く', () => {
    const { job } = buildRequest({ argv: ['npm', 'test'], flags: { profile: 'default:batch npm test' }, env: {}, cwd });
    assert.equal(job.profile, 'default:batch npm test');
    assert.equal(job.class, 'batch');
    assert.throws(() => buildRequest({ argv: ['npm', 'test'], flags: { profile: 'nope npm test' }, env: {}, cwd }), /nope npm test/);
  });
});

describe('replay: 学ぶ単位ごとの所要のばらつき', () => {
  it('unitsOf は shim の語で始まる重い部分だけを数える(sed の引数の中の npm test は数えない)', () => {
    assert.deepEqual(unitsOf('npx tsc && npm test', DEFAULT_PROFILES).map((u) => u.learned), ['default:batch npx tsc', 'default:batch npm test']);
    assert.deepEqual(unitsOf("sed -i 's|npm test|x|' a.js", DEFAULT_PROFILES), []);
    assert.deepEqual(unitsOf('ls', DEFAULT_PROFILES), []);
    assert.equal(classifiableCommand(['npm', 'test']), 'npm test');
  });

  it('spreadOf: 単位の中央値からのずれ(対数の中央値を倍率に)・2 倍以上ずれた走行・3 本未満の単位は見込みを出せない・1 秒未満は除く', () => {
    const runs = [...[10, 10, 40].map((s) => ({ unit: 'a', ms: s * 1000 })), { unit: 'b', ms: 5000 }, { unit: 'a', ms: 500 }];
    const s = spreadOf(runs);
    assert.deepEqual(s, { units: 2, runs: 4, learnableRuns: 3, typicalFactor: 1, over2x: 1 });
    assert.deepEqual(spreadOf([]), { units: 0, runs: 0, learnableRuns: 0, typicalFactor: 1, over2x: 0 });
    // ずれの中央値: 10・20・40 秒 → 中央値 20 秒から ×2・×1・×2 → 典型 ×2
    assert.equal(spreadOf([10, 20, 40].map((x) => ({ unit: 'a', ms: x * 1000 }))).typicalFactor, 2);
  });

  it('compareUnits: npm test と npx tsc を 1 つの単位に混ぜると所要がずれ、分けるとずれが消える。重い部分が 2 つの呼び出しは数えない', () => {
    const runs = [
      ...[20, 21, 22].map((s) => ({ command: 'npm test', cwd: '/w', ms: s * 1000 })),
      ...[2, 3, 3].map((s) => ({ command: 'npx tsc', cwd: '/w', ms: s * 1000 })),
      { command: 'npx tsc && npm test', cwd: '/w', ms: 99_000 },
    ];
    const c = compareUnits(runs, () => DEFAULT_PROFILES);
    // 混ぜると中央値は 11.5 秒: npx tsc の 3 本が 2 倍以上ずれる
    assert.deepEqual([c.byProfile.units, c.byProfile.runs, c.byProfile.over2x], [1, 6, 3]);
    assert.deepEqual([c.byVariant.units, c.byVariant.learnableRuns, c.byVariant.over2x], [2, 6, 0]);
    assert.ok(c.byVariant.typicalFactor < 1.2 && c.byProfile.typicalFactor > 2.5, JSON.stringify(c));
  });
});
