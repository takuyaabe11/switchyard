// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, UsageError, USAGE } from '../../src/cli/args.mjs';
import { cli } from '../../src/cli/main.mjs';

/**
 * Bash を呼んだ assistant の 1 行
 * @param {string} id @param {string} command @param {string} ts
 */
const line = (id, command, ts) => JSON.stringify({ type: 'assistant', cwd: '/w/irc', sessionId: 's', timestamp: ts, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });

/** 記録の根(<根>/<プロジェクト>/<セッション>.jsonl) @param {string[]} lines @param {string} [root] */
function records(lines, root = mkdtempSync(join(tmpdir(), 'crep-'))) {
  mkdirSync(join(root, '-w-irc'), { recursive: true });
  writeFileSync(join(root, '-w-irc', 's.jsonl'), lines.join('\n') + '\n');
  return root;
}

/** @param {string[]} args @param {{ env?: NodeJS.ProcessEnv, now?: () => number }} [o] */
async function capture(args, o = {}) {
  let out = '';
  let err = '';
  const code = await cli(args, {
    env: o.env ?? { SWITCHYARD_HOME: mkdtempSync(join(tmpdir(), 'cd-')) },
    cwd: tmpdir(),
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    now: o.now,
  });
  return { code, out, err };
}

describe('parseArgs replay', () => {
  it('オプションが無ければ既定の値', () => {
    assert.deepEqual(parseArgs(['replay']), { cmd: 'replay', cwdPrefix: null, sinceDays: null, config: null, examples: 5, dir: null });
  });

  it('オプションを読む', () => {
    assert.deepEqual(parseArgs(['replay', '--cwd', '/w/irc', '--since', '14d', '--config', 'c.json', '--examples', '3', '--dir', '/d']), {
      cmd: 'replay',
      cwdPrefix: '/w/irc',
      sinceDays: 14,
      config: 'c.json',
      examples: 3,
      dir: '/d',
    });
    assert.equal(/** @type {{ examples: number }} */ (parseArgs(['replay', '--examples', '0'])).examples, 0);
  });

  it('誤りは UsageError', () => {
    assert.throws(() => parseArgs(['replay', '--since', '14']), /--since は 14d の形/);
    assert.throws(() => parseArgs(['replay', '--since', '0d']), /--since は 14d の形/);
    assert.throws(() => parseArgs(['replay', '--examples', '-1']), /--examples は 0 以上の整数/);
    assert.throws(() => parseArgs(['replay', '--examples', 'x']), /--examples は 0 以上の整数/);
    assert.throws(() => parseArgs(['replay', '--cwd']), /--cwd に値が無い/);
    assert.throws(() => parseArgs(['replay', '--fast']), /知らないオプション: --fast/);
    assert.throws(() => parseArgs(['replay', 'extra']), UsageError);
  });

  it('使い方に replay が載る', () => {
    assert.match(USAGE, /switchyard replay \[--cwd 前方一致\] \[--since 日数d\] \[--config switchyard\.json\] \[--examples 件数\] \[--dir 記録の根\]/);
  });
});

describe('cli replay(設計 §9.2 の判定を、過去のセッション記録で空回しする)', () => {
  it('記録を読んで集計を出し、0 で終わる(デーモンは要らない)', async () => {
    const root = records([line('a', 'npm test', '2026-09-10T00:00:00.000Z'), line('b', 'cat notes.md', '2026-09-11T00:00:00.000Z')]);
    const r = await capture(['replay', '--dir', root]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Bash の呼び出し 2 件/);
    assert.match(r.out, /背景へ書き換え: 1 件\(50\.0%\)/);
  });

  it('--since は now から日数を数える', async () => {
    const root = records([line('a', 'npm test', '2026-09-01T00:00:00.000Z'), line('b', 'npm test', '2026-09-15T00:00:00.000Z')]);
    const r = await capture(['replay', '--dir', root, '--since', '7d'], { now: () => Date.parse('2026-09-16T00:00:00.000Z') });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Bash の呼び出し 1 件/);
    assert.match(r.out, /直近 7 日/);
  });

  it('--dir を省くと HOME の .claude/projects を読む', async () => {
    const home = mkdtempSync(join(tmpdir(), 'chome-'));
    records([line('a', 'npm test', '2026-09-10T00:00:00.000Z')], join(home, '.claude', 'projects'));
    const r = await capture(['replay'], { env: { HOME: home, SWITCHYARD_HOME: mkdtempSync(join(tmpdir(), 'cd-')) } });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Bash の呼び出し 1 件/);
  });

  it('--config の profile で試算する', async () => {
    const root = records([line('a', 'npm run e2e', '2026-09-10T00:00:00.000Z')]);
    const config = join(mkdtempSync(join(tmpdir(), 'ccfg-')), 'switchyard.json');
    writeFileSync(config, JSON.stringify({ profiles: { e2e: { match: ['npm run e2e*'], class: 'batch', locks: ['port:4173'] } } }));
    const plain = await capture(['replay', '--dir', root]);
    assert.match(plain.out, /背景へ書き換え: 0 件/);
    const tried = await capture(['replay', '--dir', root, '--config', config]);
    assert.equal(tried.code, 0, tried.err);
    assert.match(tried.out, /背景へ書き換え: 1 件/);
    assert.match(tried.out, /包む: 1 件\(e2e 1\)/);
  });

  it('記録の置き場所が無ければ 1、無い・読めない --config は 2', async () => {
    const missing = await capture(['replay', '--dir', join(tmpdir(), 'crep-missing-dir', 'x')]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /記録の置き場所が無い/);
    const root = records([line('a', 'npm test', '2026-09-10T00:00:00.000Z')]);
    const broken = join(mkdtempSync(join(tmpdir(), 'ccfg-')), 'switchyard.json');
    writeFileSync(broken, 'not json');
    const bad = await capture(['replay', '--dir', root, '--config', broken]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--config の設定を読めない/);
    const absent = await capture(['replay', '--dir', root, '--config', join(tmpdir(), 'crep-missing-config.json')]);
    assert.equal(absent.code, 2);
    assert.match(absent.err, /--config の設定を読めない/);
  });
});
