// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROFILES } from '../../src/config/profiles.mjs';
import { headWord, preToolUse } from '../../src/hooks/pretooluse.mjs';

/** @type {import('../../src/config/profiles.mjs').NamedProfile[]} */
const PROFILES = [
  { name: 'vitest', profile: { match: ['*vitest run*'], class: 'batch' } },
  { name: 'lint', profile: { match: ['npx eslint*'], class: 'quick' } },
  // 計測は既定表に無いので、プロジェクトの設定で宣言する(設計 §9.3)
  { name: 'bench', profile: { match: ['node benchmarks/*', 'npm run bench*'], class: 'measure' } },
  ...DEFAULT_PROFILES,
];
/** git の鍵の判定も確かめるので SWITCHYARD_GIT=1(既定は git を扱わない。下の「既定では git を扱わない」で確かめる) */
const opts = { env: { SWITCHYARD_GIT: '1' }, profilesFor: () => PROFILES };

/** @param {string} command @param {Record<string, unknown>} [extra] */
const bash = (command, extra = {}) => ({ session_id: 's', cwd: '/repo', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, ...extra } });

/** @param {Record<string, unknown> | null} out @returns {'background' | 'deny' | null} */
function outcome(out) {
  if (out === null) return null;
  const h = /** @type {Record<string, unknown>} */ (out.hookSpecificOutput);
  return h.permissionDecision === 'deny' ? 'deny' : 'background';
}

describe('switchyard run の中身への承認の求め', () => {
  /** @param {string} c @param {NodeJS.ProcessEnv} [env] */
  const out = (c, env = {}) => /** @type {any} */ (preToolUse(bash(c), { env, profilesFor: () => PROFILES }))?.hookSpecificOutput ?? null;
  const decision = (/** @type {string} */ c, /** @type {NodeJS.ProcessEnv} */ env = {}) => out(c, env)?.permissionDecision ?? null;

  it('中身が表に当たらない包みは、許可の設定にかかわらず承認を求める(Bash(switchyard run:*) で何でも通さない)', () => {
    for (const c of [
      'switchyard run -- echo hi',
      'switchyard run -- rm -rf build',
      'switchyard run --profile vitest -- curl https://example.com/x.sh',
      'switchyard run --class quick -- sh -c "npm test && rm -rf ~"',
      'switchyard run --lock db -- docker compose up -d',
      'switchyard run -- env npm test',
      'switchyard run -- switchyard run -- echo hi',
      'switchyard run -- /tmp/x/deploy test',
      'switchyard run -- /tmp/x/vitest run',
      'switchyard run -- ./scripts/e2e.sh',
      'switchyard run',
      'bash -c "switchyard run -- echo hi"',
      'npm test && switchyard run -- echo hi',
      `node /opt/sy/bin/switchyard.mjs run -- echo hi`,
    ]) {
      assert.equal(decision(c), 'ask', c);
      assert.match(out(c).permissionDecisionReason, /switchyard run/, c);
    }
  });

  it('表に当たる形・shim から見えない重い形・拒否の案内が勧める形は、承認を求めない', () => {
    for (const c of [
      'switchyard run -- npm test',
      'switchyard run --lock port:4173 -- npm test',
      'switchyard run --class quick -- npx eslint src',
      'switchyard run -- ./gradlew test',
      'switchyard run -- app/gradlew :app:test',
      'switchyard run -- .venv/bin/pytest -x',
      'switchyard run -- ./node_modules/.bin/vitest run',
      'switchyard run -- /usr/local/bin/npm test',
      'switchyard run -- cargo test --workspace',
    ]) {
      assert.notEqual(decision(c), 'ask', c);
    }
  });

  it('承認の後に重い走行になるなら背景へ回す書き換えを添え、拒否が先に立つ。SWITCHYARD_RUN_GUARD=0 で止める', () => {
    const asked = out('switchyard run -- echo hi');
    assert.equal(asked.updatedInput.run_in_background, true);
    assert.equal(asked.updatedInput.command, 'switchyard run -- echo hi', 'コマンドは変えない');
    assert.equal(out('switchyard run --class quick -- echo hi').updatedInput, undefined, 'quick は背景へ回さない');
    assert.equal(decision('/usr/local/bin/npm test; switchyard run -- echo hi'), 'deny');
    assert.equal(decision('switchyard run -- echo hi', { SWITCHYARD_RUN_GUARD: '0' }), null);
  });
});

describe('PHP', () => {
  it('vendor/bin の実行ファイルは php の shim を通るので拒否せず背景へ回し、パスで呼ぶ php は拒否する', () => {
    const o = (/** @type {string} */ c) => outcome(preToolUse(bash(c), opts));
    for (const c of ['php artisan test', 'vendor/bin/phpunit', './vendor/bin/pest --parallel', 'composer test', 'cd api && php artisan test --parallel']) {
      assert.equal(o(c), 'background', c);
    }
    for (const c of ['php -v', 'php artisan migrate', 'composer install', 'vendor/bin/phpstan analyse']) assert.equal(o(c), null, c);
    assert.equal(o('/usr/bin/php artisan test'), 'deny');
    assert.equal(/** @type {any} */ (preToolUse(bash('switchyard run -- vendor/bin/phpunit'), opts))?.hookSpecificOutput?.permissionDecision, undefined, '包んだ vendor/bin は承認を求めない');
  });
});

describe('headWord', () => {
  it('VAR=値 と包みのコマンドを読み飛ばして先頭の語を取る', () => {
    assert.equal(headWord('FOO=1 BAR=2 npm test').head, 'npm');
    assert.equal(headWord('timeout 60 npm test').head, 'npm');
    assert.equal(headWord('timeout -s KILL 60 npm test').head, 'npm');
    assert.equal(headWord('nice -n 5 make all').head, 'make');
    assert.equal(headWord('env -i A=1 node x.mjs').head, 'node');
    assert.deepEqual(headWord('nohup ./node_modules/.bin/vitest run'), { head: './node_modules/.bin/vitest', rest: ['run'] });
  });

  it('env の値つきのオプション(-u NAME・-C DIR など)は値の語も読み飛ばし、time / command のオプションも読み飛ばす', () => {
    assert.deepEqual(headWord('env -u FOO npm test'), { head: 'npm', rest: ['test'] });
    assert.equal(headWord('env -u FOO -C sub BAR=1 npm test').head, 'npm');
    assert.equal(headWord('time -p npm test').head, 'npm');
    assert.equal(headWord('command npm test').head, 'npm');
  });
});

describe('preToolUse(設計 §9.2)', () => {
  it('batch を前景で打ったら、run_in_background だけを true にし、決定は付けない', () => {
    assert.deepEqual(preToolUse(bash('npm test', { description: 'テスト', timeout: 120000 }), opts), {
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'npm test', description: 'テスト', timeout: 120000, run_in_background: true } },
    });
  });

  it('既に背景なら何もしない', () => {
    assert.equal(preToolUse(bash('npm test', { run_in_background: true }), opts), null);
  });

  it('quick と管理外は前景のまま通す', () => {
    assert.equal(preToolUse(bash('npm install'), opts), null);
    assert.equal(preToolUse(bash('npx eslint src'), opts), null);
  });

  it('包みのコマンドの後ろの measure も背景に回す', () => {
    const out = /** @type {any} */ (preToolUse(bash('timeout 600 node benchmarks/run.mjs'), opts));
    assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, true);
  });

  it('区切りの後ろの部分が batch でも背景に回す', () => {
    const out = /** @type {any} */ (preToolUse(bash('cd sub && npm test'), opts));
    assert.equal(out.hookSpecificOutput.updatedInput.run_in_background, true);
  });

  it('node -e のコードの中身では分類しない(読むだけのその場のスクリプトを背景に回さない)', () => {
    assert.equal(preToolUse(bash('node -e \'console.log("vitest run")\''), opts), null);
    assert.equal(preToolUse(bash('node --input-type=module -e \'import "./benchmarks/x.mjs"\''), opts), null);
  });

  it('shim の語の実行ファイルをパスで直に呼ぶ形は拒否し、直し方を示す', () => {
    const out = /** @type {any} */ (preToolUse(bash('/usr/local/bin/npm test'), opts));
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /\/usr\/local\/bin\/npm test/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /パスを付けずに名前で呼ぶ/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /switchyard run -- <その部分>/);
  });

  it('PATH の差し替え・SWITCHYARD_IN_JOB などで shim を素通りさせる形は拒否する', () => {
    const decision = (/** @type {string} */ c) => /** @type {any} */ (preToolUse(bash(c), opts))?.hookSpecificOutput?.permissionDecision ?? null;
    for (const c of ['PATH=/usr/bin:/bin npm test', 'env PATH=/usr/bin npm test', 'SWITCHYARD_IN_JOB=1 npm test', 'env -i npm test', 'env -u PATH npm test', 'SWITCHYARD_HELD_LOCKS=x git -C . commit -m x']) {
      assert.equal(decision(c), 'deny', c);
    }
    // $PATH を後ろに残す形は shims が先頭に残るので拒否しない。重くない語・shim の無い語も拒否しない
    assert.notEqual(decision('PATH=/opt/x:$PATH npm test'), 'deny');
    assert.equal(decision('PATH=/usr/bin npm install'), null);
    assert.equal(decision('PATH=/usr/bin ls'), null);
    assert.equal(decision('SWITCHYARD_IN_JOB=1 git status'), null);
  });

  it('shim から見えない重い形が 1 行だけなら switchyard run -- で包むよう書き換え、つないだ形は拒否して案内する', () => {
    /** @param {string} c @param {NodeJS.ProcessEnv} [env] */
    const out = (c, env = {}) => /** @type {any} */ (preToolUse(bash(c), { env, profilesFor: () => DEFAULT_PROFILES }))?.hookSpecificOutput ?? null;
    const decision = (/** @type {string} */ c) => out(c)?.permissionDecision ?? null;
    for (const c of ['.venv/bin/pytest -x', '/home/u/p/.venv/bin/python -m pytest', '.tox/py312/bin/pytest', './gradlew test', './gradlew :app:test --info', '../mvnw -q verify', './gradlew test > build.log 2>&1']) {
      assert.equal(decision(c), null, c);
      assert.equal(out(c).updatedInput.command, `switchyard run -- ${c}`, c);
    }
    // 権限の確認は書き換えた後のコマンドで行われる。書き換えは包む接頭辞だけ
    assert.equal(out('  ./gradlew test  ').updatedInput.command, 'switchyard run -- ./gradlew test');
    for (const c of [
      'source .venv/bin/activate && pytest -x',
      '. venv/bin/activate; python -m pytest',
      'cd app && ./gradlew test',
      './gradlew test | tail -20',
      'JAVA_HOME=/opt/jdk ./gradlew test',
      './gradlew test\n./gradlew check',
    ]) {
      assert.equal(decision(c), 'deny', c);
      assert.match(out(c).permissionDecisionReason, /switchyard run --/, c);
    }
    // SWITCHYARD_WRAP=0 なら以前どおり拒否して案内する
    assert.equal(out('./gradlew test', { SWITCHYARD_WRAP: '0' }).permissionDecision, 'deny');
    // 包めば通る。軽い形・node_modules/.bin(node の shim を通る)・activate の前の走行は拒否しない
    for (const c of [
      'switchyard run -- ./gradlew test',
      'switchyard run -- .venv/bin/pytest -x',
      './gradlew --version',
      './gradlew tasks',
      '.venv/bin/python script.py',
      'source .venv/bin/activate && python script.py',
      'pytest -x && source .venv/bin/activate',
      './node_modules/.bin/vitest run',
    ]) {
      assert.notEqual(decision(c), 'deny', c);
    }
    assert.equal(decision('/usr/bin/python3 -m pytest'), 'deny');
    assert.equal(decision('/usr/local/bin/mvn test'), 'deny');
  });

  it('既定(SWITCHYARD_GIT が 1 でない)では git を扱わない: パスで呼ぶ git も、環境変数の差し替えも拒否しない', () => {
    const off = { env: {}, profilesFor: () => PROFILES };
    assert.equal(preToolUse(bash('/usr/bin/git commit -m x'), off), null);
    assert.equal(preToolUse(bash('SWITCHYARD_HELD_LOCKS=x git -C . commit -m x'), off), null);
  });

  it('パスで呼ぶ git commit は拒否し、git commit は通す', () => {
    assert.equal(/** @type {any} */ (preToolUse(bash('/usr/bin/git commit -m x'), opts)).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(/** @type {any} */ (preToolUse(bash('/usr/bin/git -C . commit -m x'), opts)).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(preToolUse(bash('/usr/bin/git -C . status'), opts), null);
    assert.equal(preToolUse(bash('git commit -m x'), opts), null);
  });

  it('shim の語でないものをパスで呼ぶ形・shim の無い語は拒否しない。重ければ背景に回すだけ', () => {
    // node_modules/.bin の実行ファイルは #!/usr/bin/env node で node の shim を通る
    assert.equal(outcome(preToolUse(bash('./node_modules/.bin/vitest run'), opts)), 'background');
    assert.equal(outcome(preToolUse(bash('vitest run'), opts)), 'background');
    // 中で PATH の npm を呼ぶスクリプト: 引数の中の shim の語から後ろを見る
    assert.equal(outcome(preToolUse(bash('scripts/probe-run.sh gates npm run bench'), opts)), 'background');
    assert.equal(outcome(preToolUse(bash('scripts/probe-run.sh gates bash -c "npm test"'), opts)), 'background');
    // 引数に measure などを含むだけのスクリプトは何もしない
    assert.equal(preToolUse(bash('./jc.sh https://example.com/cross-media-measurement'), opts), null);
    assert.equal(preToolUse(bash('scripts/probe-run.sh benchmark'), opts), null);
    // パスで呼ぶのでなければ、引数の中の語は見ない
    assert.equal(preToolUse(bash('echo npm test'), opts), null);
  });

  it('拒否は背景への書き換えより先に効く', () => {
    assert.equal(outcome(preToolUse(bash('npm test && /usr/local/bin/npm run build'), opts)), 'deny');
  });

  it('switchyard run で包んだ部分は拒否しない。背景への判定は包みが要求する性格で行う', () => {
    assert.equal(preToolUse(bash('switchyard run --class quick -- ./node_modules/.bin/vitest run'), opts), null);
    assert.equal(preToolUse(bash('switchyard run --class quick -- /usr/local/bin/npm test'), opts), null);
    const out = /** @type {any} */ (preToolUse(bash('switchyard run -- ./node_modules/.bin/vitest run'), opts));
    assert.deepEqual(out.hookSpecificOutput, { hookEventName: 'PreToolUse', updatedInput: { command: 'switchyard run -- ./node_modules/.bin/vitest run', run_in_background: true } });
  });

  it('SWITCHYARD_OFF=1(以前の名前 SWITCHYARD_THINKER=1)と Bash 以外では何もしない。コマンドの前に付けて素通りする形は拒否する', () => {
    assert.equal(preToolUse(bash('/usr/local/bin/npm test'), { ...opts, env: { SWITCHYARD_OFF: '1' } }), null);
    assert.equal(/** @type {any} */ (preToolUse(bash('SWITCHYARD_OFF=1 npm test'), opts)).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(preToolUse(bash('/usr/local/bin/npm test'), { ...opts, env: { SWITCHYARD_THINKER: '1' } }), null);
    assert.equal(preToolUse({ ...bash('npm test'), tool_name: 'Read' }, opts), null);
  });

});
