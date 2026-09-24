// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { switchyardHome, pathsOf } from '../../src/daemon/paths.mjs';
import { appendRecord, createStateWriter, JOURNAL_MAX_BYTES, loadEscapes, loadEstimates, parseState, readJournal, readJson, readRecords, rotateRecords, writeJsonAtomic } from '../../src/daemon/store.mjs';
import { state } from '../../testkit/fixtures.mjs';
import { socketPath } from '../../src/platform.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'switchyard-'));

describe('paths', () => {
  it('SWITCHYARD_HOME があればそれを使う', () => {
    assert.equal(switchyardHome({ SWITCHYARD_HOME: '/x/y' }), '/x/y');
    assert.equal(pathsOf('/x/y').sock, socketPath('/x/y'));
    assert.equal(pathsOf('/x/y').hooks, join('/x/y', 'hooks.jsonl'));
  });
});

describe('store', () => {
  it('writeJsonAtomic は書き終えたファイルだけを残す', () => {
    const dir = tmp();
    const file = join(dir, 'sub', 'state.json');
    writeJsonAtomic(file, { a: 1 });
    assert.deepEqual(readJson(file), { a: 1 });
    assert.deepEqual(readdirSync(join(dir, 'sub')), ['state.json']);
  });

  it('createStateWriter は中身が変わったときだけ書く(tick ごとの書き直しを止める)', () => {
    const dir = tmp();
    const file = join(dir, 'state.json');
    const write = createStateWriter(file);
    assert.equal(write({ a: 1 }), true);
    assert.deepEqual(readJson(file), { a: 1 });
    const before = statSync(file).mtimeMs;
    assert.equal(write({ a: 1 }), false, '同じ中身なら書かない');
    assert.equal(statSync(file).mtimeMs, before, '書かなければ mtime も動かない');
    assert.equal(write({ a: 2 }), true);
    assert.deepEqual(readJson(file), { a: 2 });
  });

  it('rotateRecords は上限を超えたときだけ 1 世代前へ回す', () => {
    const dir = tmp();
    const file = join(dir, 'events.jsonl');
    appendRecord(file, { a: 1 });
    assert.equal(rotateRecords(file, 1024), false, '上限以下なら何もしない');
    assert.equal(existsSync(file), true);
    assert.equal(rotateRecords(file, 1), true);
    assert.equal(existsSync(file), false, '本体は空(無い)になる');
    assert.deepEqual(readRecords(`${file}.1`).records, [{ a: 1 }]);
    assert.equal(rotateRecords(file, 1), false, '本体が無ければ回すものが無い');
  });

  it('readJournal は 1 世代前と本体を古い順につなぐ', () => {
    const dir = tmp();
    const file = join(dir, 'events.jsonl');
    appendRecord(file, { n: 1 });
    rotateRecords(file, 1);
    appendRecord(file, { n: 2 });
    assert.deepEqual(readJournal(file).records, [{ n: 1 }, { n: 2 }]);
    // 回した直後でも見込みの材料が残る
    assert.equal(readJournal(join(dir, 'none.jsonl')).records.length, 0);
  });

  it('回した記録を読み直しても見込みの帳簿が切れない', () => {
    const dir = tmp();
    const file = join(dir, 'events.jsonl');
    for (const ms of [100, 200, 300]) appendRecord(file, { kind: 'history', repo: '/r', profile: 'p', durationMs: ms, code: 0 });
    rotateRecords(file, 1);
    assert.equal(loadEstimates(readJournal(file).records).expected('/r', 'p'), 200);
  });

  it('上限の既定は 8MB', () => {
    assert.equal(JOURNAL_MAX_BYTES, 8 * 1024 * 1024);
  });

  it('readJson は無い・壊れているとき null', () => {
    const dir = tmp();
    assert.equal(readJson(join(dir, 'none.json')), null);
    writeFileSync(join(dir, 'bad.json'), '{');
    assert.equal(readJson(join(dir, 'bad.json')), null);
  });

  it('parseState は形の合わない値を拒む', () => {
    assert.deepEqual(parseState(state()), state());
    assert.equal(parseState(null), null);
    assert.equal(parseState({ capacity: '8' }), null);
    assert.equal(parseState({ ...state(), leases: {} }), null);
  });

  it('記録は追記され、壊れた行は数えて読み飛ばす', () => {
    const file = join(tmp(), 'events.jsonl');
    assert.deepEqual(readRecords(file), { records: [], bad: 0 });
    appendRecord(file, { kind: 'event', n: 1 });
    writeFileSync(file, 'garbage\n[1,2]\n', { flag: 'a' });
    appendRecord(file, { kind: 'event', n: 2 });
    const r = readRecords(file);
    assert.deepEqual(r.records, [{ kind: 'event', n: 1 }, { kind: 'event', n: 2 }]);
    assert.equal(r.bad, 2);
    assert.equal(existsSync(file), true);
  });

  it('loadEscapes は escape 行から repo × profile ごとに抜けた子の名前を集める', () => {
    const m = loadEscapes([
      { kind: 'escape', repo: '/r', profile: 'e2e', escaped: [{ comm: 'chrome', count: 3 }], survivors: [] },
      { kind: 'escape', repo: '/r', profile: 'e2e', escaped: [{ comm: 'node', count: 1 }, { bad: true }], survivors: [] },
      { kind: 'history', repo: '/r', profile: 'e2e' },
    ]);
    assert.deepEqual([...m.keys()], [JSON.stringify(['/r', 'e2e'])]);
    assert.deepEqual([...(m.get(JSON.stringify(['/r', 'e2e'])) ?? [])].sort(), ['chrome', 'node']);
  });

  it('loadEstimates は history 行から見込みを作る', () => {
    const records = [
      { kind: 'history', repo: '/r', profile: 'unit', durationMs: 100, code: 0 },
      { kind: 'history', repo: '/r', profile: 'unit', durationMs: 300, code: 0 },
      { kind: 'event', event: {} },
      { kind: 'history', repo: '/r', profile: 'unit', durationMs: 200, code: 0 },
      { kind: 'history', repo: '/r', profile: 'unit', durationMs: 999, code: 1 },
    ];
    assert.equal(loadEstimates(records).expected('/r', 'unit'), 200);
  });
});
