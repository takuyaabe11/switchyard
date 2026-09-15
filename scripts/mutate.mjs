#!/usr/bin/env node
// @ts-check
// 門番の検出力を測る(設計 §15)。原本は触らず、一時ディレクトリの写しに変異を 1 つずつ入れて、組ごとのテストを回す。
// 使い方: node scripts/mutate.mjs <組の名前>   全部の変異が赤になれば終了コード 0、生き残った変異があれば 1。
import { spawnSync } from 'node:child_process';
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
        from: 'if (head === null && s.leases.length === 0 && locksFree(s, job.locks)) {',
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
};

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
    for (const sub of ['bin', 'src', 'test', 'testkit']) {
      if (existsSync(join(root, sub))) cpSync(join(root, sub), join(dir, sub), { recursive: true });
    }
    cpSync(join(root, 'package.json'), join(dir, 'package.json'));
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    const file = join(dir, m.file);
    const src = readFileSync(file, 'utf8');
    const count = src.split(m.from).length - 1;
    if (count !== 1) throw new Error(`${m.name}: 置き換え元が ${count} 箇所ある(1 箇所であるべき)`);
    writeFileSync(file, src.replace(m.from, m.to));
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...suite.tests], { cwd: dir, encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    const num = (/** @type {string} */ k) => (out.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')) ?? [])[1] ?? '?';
    const section = out.includes('✖ failing tests:') ? out.split('✖ failing tests:')[1] : '';
    /** @type {string[]} */
    const red = [];
    for (const line of section.split('\n')) {
      const hit = line.match(/^✖ (.+?) \(\d/);
      if (hit && !red.includes(hit[1])) red.push(hit[1]);
    }
    const killed = num('fail') !== '0' && num('fail') !== '?';
    if (!killed) survived += 1;
    console.log(`== ${m.name} | ${m.file} | ${killed ? '赤' : '生き残り'} | tests ${num('tests')} / fail ${num('fail')} / pass ${num('pass')}`);
    console.log(`   壊した行: ${m.to.trim() === '' ? '(行を消した)' : m.to.trim()}`);
    for (const name of red) console.log(`   赤: ${name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(survived === 0 ? '全部の変異が赤になった' : `生き残った変異: ${survived}`);
process.exitCode = survived === 0 ? 0 : 1;
