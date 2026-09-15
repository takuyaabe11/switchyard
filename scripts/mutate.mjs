#!/usr/bin/env node
// @ts-check
// 門番の検出力を測る(設計 §15)。原本は触らず、一時ディレクトリの写しに変異を 1 つずつ入れて、組ごとのテストを回す。
// 使い方: node scripts/mutate.mjs <組の名前>   全部の変異が赤になれば終了コード 0、生き残った変異があれば 1。
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {{ name: string, file: string, from: string, to: string }} Mutation */
/** @type {Record<string, { tests: string[], mutations: Mutation[] }>} */
const SUITES = {
  core: {
    tests: [
      'test/core/decide.test.mjs',
      'test/core/estimate.test.mjs',
      'test/core/invariants.property.test.mjs',
      'test/core/recovery.test.mjs',
      'test/core/schedule.admission.test.mjs',
      'test/core/schedule.backfill.test.mjs',
      'test/core/schedule.lockonly.test.mjs',
      'test/core/schedule.measure.test.mjs',
      'test/core/score.test.mjs',
    ],
    mutations: [
      {
        name: 'M1 鍵の空き判定を緩める',
        file: 'src/core/schedule.mjs',
        from: 'return locks.every((k) => holders(s, k).length < capOf(s, k));',
        to: 'return locks.every((k) => holders(s, k).length <= capOf(s, k));',
      },
      {
        name: 'M2 計測の単独実行を外す',
        file: 'src/core/schedule.mjs',
        from: 'if (head === null && cpuLeases(s).length === 0 && locksFree(s, job.locks)) {',
        to: 'if (head === null && locksFree(s, job.locks)) {',
      },
      {
        name: 'M3 CPU の空き判定を 1 つ緩める',
        file: 'src/core/schedule.mjs',
        from: 'const fits = free >= job.cpus.min && locksFree(s, job.locks);',
        to: 'const fits = free + 1 >= job.cpus.min && locksFree(s, job.locks);',
      },
      {
        name: 'M4 計測の直後の優先を外す',
        file: 'src/core/schedule.mjs',
        from: 'if (s.favorNonMeasure) {',
        to: 'if (false) {',
      },
      {
        name: 'M5 exit でリースを返さない',
        file: 'src/core/decide.mjs',
        from: '      s = removeLease(s, e.jobId);\n      extra.push(',
        to: '      extra.push(',
      },
      {
        name: 'M6 後ろ詰めの時刻条件を外す',
        file: 'src/core/schedule.mjs',
        from: 'const endsBeforeHead = head.etaAt !== null && job.expectedMs !== null && now + job.expectedMs <= head.etaAt;',
        to: 'const endsBeforeHead = true;',
      },
      {
        name: 'M7 CPU 0 のリースも計測の単独に数える',
        file: 'src/core/schedule.mjs',
        from: 'if (head === null && cpuLeases(s).length === 0 && locksFree(s, job.locks)) {',
        to: 'if (head === null && s.leases.length === 0 && locksFree(s, job.locks)) {',
      },
      {
        name: 'M8 鍵だけのジョブも計測の走行中は止める',
        file: 'src/core/schedule.mjs',
        from: 'if (isLockOnly(job)) {',
        to: 'if (isLockOnly(job) && gate === null) {',
      },
      {
        name: 'M9 鍵だけのジョブが前で止まっている鍵を追い越す',
        file: 'src/core/schedule.mjs',
        from: 'const ahead = job.locks.find((k) => blocked.has(k));',
        to: 'const ahead = undefined;',
      },
    ],
  },
  escape: {
    tests: ['test/run/watch.test.mjs', 'test/run/probe.test.mjs', 'test/run/run.test.mjs', 'test/daemon/server.test.mjs', 'test/cli/main.test.mjs'],
    mutations: [
      {
        name: 'E1 グループの違いを見ない',
        file: 'src/run/watch.mjs',
        from: 'for (const [, v] of seen) if (v.pgid !== pgid) counts.set',
        to: 'for (const [, v] of seen) if (v.pgid !== v.pgid) counts.set',
      },
      {
        name: 'E2 走行中に子孫を見ない',
        file: 'src/run/run.mjs',
        from: 'watchTimer = setInterval(() => tr.sample(), watchMs);',
        to: 'watchTimer = null;',
      },
      {
        // I2: 開始時刻(started)の照合をやめ、使い回された pid を同じ子とみなしてしまう変異
        name: 'E3 使い回された pid を同じ子とみなす(開始時刻を照合しない)',
        file: 'src/run/watch.mjs',
        from: 'const orphanedSame = known !== undefined && r.ppid === 1 && known.started === r.started;',
        to: 'const orphanedSame = known !== undefined;',
      },
      {
        name: 'E4 デーモンが抜けた子の名前を覚えない',
        file: 'src/daemon/server.mjs',
        from: 'for (const e of escape.escaped) names.add(e.comm);',
        to: '',
      },
    ],
  },
  wrap: {
    tests: ['test/run/nest.test.mjs', 'test/run/signals.test.mjs', 'test/daemon/unmanaged.test.mjs'],
    mutations: [
      {
        name: 'W1 祖先が持つ鍵を外さない',
        file: 'src/run/run.mjs',
        from: '.filter((k) => !held.has(k)),',
        to: ',',
      },
      {
        name: 'W2 CPU を持つジョブの子に入れ子の印を立てない',
        file: 'src/run/run.mjs',
        from: "if (cpus > 0) childEnv.CONDUCTOR_IN_JOB = '1';",
        to: '',
      },
      {
        name: 'W3 入れ子で何も要らなくてもデーモンに要求する',
        file: 'src/run/run.mjs',
        from: 'if (job.cpus.max === 0 && job.locks.length === 0) {',
        to: 'if (false) {',
      },
      {
        name: 'W4 CPU を持つジョブの中でも CPU を要求する',
        file: 'src/run/run.mjs',
        from: "cpus: env.CONDUCTOR_IN_JOB === '1' ? { min: 0, max: 0 } : flags.cpus",
        to: 'cpus: flags.cpus',
      },
      {
        name: 'W5 グループの確かめ方を差し替えられない',
        file: 'src/run/run.mjs',
        from: 'pgid = verifyGroup(c.pid, ownPgid);',
        to: 'pgid = verifiedGroup(c.pid, ownPgid);',
      },
      {
        name: 'W6 デーモンが管理なしの失敗を ack 待ちに積まない',
        file: 'src/daemon/server.mjs',
        from: "if (u.code !== 0) apply({ type: 'unmanagedExit'",
        to: "if (false) apply({ type: 'unmanagedExit'",
      },
      {
        name: 'W7 管理なしで走っても控えない',
        file: 'src/run/run.mjs',
        from: 'if (unmanaged) {',
        to: 'if (false) {',
      },
      {
        name: 'W8 待っている間にデーモンが要求を拒んでも待ち続ける',
        file: 'src/run/run.mjs',
        from: "} else if (m.t === 'error' && phase === 'waiting') {",
        to: '} else if (false) {',
      },
    ],
  },
  shim: {
    tests: ['test/shim/decide.test.mjs', 'test/shim/shims.test.mjs'],
    mutations: [
      {
        name: 'D1 CPU を持つジョブの中でも分類する',
        file: 'src/shim/decide.mjs',
        from: "if (env.CONDUCTOR_IN_JOB === '1') return { kind: 'pass' };",
        to: '',
      },
      {
        name: 'S2 node が無いと作業を止める',
        file: 'shims/_shim.sh',
        from: '[ -n "$node" ] || exec "$real" "$@"',
        to: '[ -n "$node" ] || exit 1',
      },
      {
        name: 'S3 祖先が持つ git の鍵も取りに行く',
        file: 'src/shim/decide.mjs',
        from: "return heldLocks(env).has(lock) ? { kind: 'pass' } : { kind: 'lock', lock };",
        to: "return { kind: 'lock', lock };",
      },
      {
        name: 'S4 管理対象を包まない',
        file: 'shims/_shim.sh',
        from: '"run "*) exec',
        to: '"never-run "*) exec',
      },
      {
        name: 'S5 git の鍵だけのジョブを作らない',
        file: 'shims/_shim.sh',
        from: '"lock "*) exec',
        to: '"never-lock "*) exec',
      },
    ],
  },
  hooks: {
    tests: ['test/hooks/pretooluse.test.mjs'],
    mutations: [
      {
        name: 'H1 既に背景でも書き換える',
        file: 'src/hooks/pretooluse.mjs',
        from: 'if (heavy && ti.run_in_background !== true) {',
        to: 'if (heavy) {',
      },
      {
        name: 'H2 背景への書き換えに allow を付ける(権限の確認を飛ばす)',
        file: 'src/hooks/pretooluse.mjs',
        from: "return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, run_in_background: true } } };",
        to: "return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...ti, run_in_background: true } } };",
      },
      {
        name: 'H3 shim を通らない形を拒否しない',
        file: 'src/hooks/pretooluse.mjs',
        from: 'if (!SHIM_WORDS.includes(head)) unshimmed.push(seg);',
        to: '',
      },
      {
        name: 'H4 timeout の値を読み飛ばさない',
        file: 'src/hooks/pretooluse.mjs',
        from: "while (i < words.length && words[i].startsWith('-')) i += words[i] === '-s' || words[i] === '-k' ? 2 : 1;\n      i += 1;",
        to: '',
      },
      {
        name: 'H5 conductor run を含むコマンドも判定する',
        file: 'src/hooks/pretooluse.mjs',
        from: "&& p.rest[0] === 'run')) return null;",
        to: "&& p.rest[0] === 'never')) return null;",
      },
      {
        name: 'H6 考える層の中でも判定する',
        file: 'src/hooks/pretooluse.mjs',
        from: "if (env.CONDUCTOR_THINKER === '1') return null;",
        to: '',
      },
    ],
  },
  group: {
    tests: ['test/run/group.test.mjs'],
    mutations: [
      {
        name: 'G1 孫(子の pgid ≠ 子の pid)の拒否を外す',
        file: 'src/run/group.mjs',
        from: 'if (pgid !== childPid || pgid === ownPgid) return null;',
        to: 'if (pgid === ownPgid) return null;',
      },
      {
        name: 'G2 自分のグループと同じ pgid の拒否を外す',
        file: 'src/run/group.mjs',
        from: 'if (pgid !== childPid || pgid === ownPgid) return null;',
        to: 'if (pgid !== childPid) return null;',
      },
    ],
  },
};

/** 変異で止まったテストに、走行ごと付き合わない上限 */
const TEST_TIMEOUT_MS = 180_000;

/**
 * 写しでテストを走らせる。テストは自分のプロセスグループで起動し、時間切れにはそのグループごと SIGKILL する
 * (親だけを殺すと、テストファイルのプロセスが孤児として残る)。時間切れは件数の行が出ないので「生き残り」に数える
 * (外から殺された走行を赤に見せない)。
 * @param {string} dir @param {string[]} tests
 * @returns {Promise<{ stdout: string, stderr: string, timedOut: boolean }>}
 */
function runTests(dir, tests) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...tests], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (s) => (stdout += s));
    child.stderr.setEncoding('utf8').on('data', (s) => (stderr += s));
    const timer = setTimeout(() => {
      timedOut = true;
      // detached で起動したので、子の pgid は子の pid(このスクリプトのグループではない)
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // 既に居ない
        }
      }
    }, TEST_TIMEOUT_MS);
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut });
    });
  });
}

const suiteName = process.argv[2] ?? '';
const suite = SUITES[suiteName];
if (suite === undefined) {
  console.error(`使い方: node scripts/mutate.mjs <${Object.keys(SUITES).join(' | ')}>`);
  process.exit(2);
}

let survived = 0;
for (const m of suite.mutations) {
  const dir = mkdtempSync(join(tmpdir(), 'cmut-'));
  try {
    for (const sub of ['bin', 'shims', 'src', 'test', 'testkit']) {
      if (existsSync(join(root, sub))) cpSync(join(root, sub), join(dir, sub), { recursive: true });
    }
    cpSync(join(root, 'package.json'), join(dir, 'package.json'));
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    const file = join(dir, m.file);
    const src = readFileSync(file, 'utf8');
    const count = src.split(m.from).length - 1;
    if (count !== 1) throw new Error(`${m.name}: 置き換え元が ${count} 箇所ある(1 箇所であるべき)`);
    writeFileSync(file, src.replace(m.from, m.to));
    const r = await runTests(dir, suite.tests);
    const out = `${r.stdout}${r.stderr}`;
    if (r.timedOut) console.log(`   走行が ${TEST_TIMEOUT_MS}ms で終わらず、テストのプロセスグループごと止めた`);
    const num = (/** @type {string} */ k) => (out.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')) ?? [])[1] ?? '?';
    const section = out.includes('✖ failing tests:') ? out.split('✖ failing tests:')[1] : '';
    /** @type {string[]} */
    const red = [];
    for (const line of section.split('\n')) {
      const hit = line.match(/^✖ (.+?) \(\d/);
      if (hit && !red.includes(hit[1])) red.push(hit[1]);
    }
    // テストごとの時間の上限で打ち切られたテストは fail ではなく cancelled に数えられる。どちらも赤とする
    const redCount = (/** @type {string} */ k) => num(k) !== '0' && num(k) !== '?';
    const killed = redCount('fail') || redCount('cancelled');
    if (!killed) survived += 1;
    console.log(`== ${m.name} | ${m.file} | ${killed ? '赤' : '生き残り'} | tests ${num('tests')} / fail ${num('fail')} / cancelled ${num('cancelled')} / pass ${num('pass')}`);
    console.log(`   壊した行: ${m.to.trim() === '' ? '(行を消した)' : m.to.trim()}`);
    for (const name of red) console.log(`   赤: ${name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(survived === 0 ? '全部の変異が赤になった' : `生き残った変異: ${survived}`);
process.exitCode = survived === 0 ? 0 : 1;
