// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conductorHome, pathsOf } from '../../src/daemon/paths.mjs';
import { appendRecord, loadEstimates, parseState, readJson, readRecords, writeJsonAtomic } from '../../src/daemon/store.mjs';
import { state } from '../../testkit/fixtures.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'conductor-'));

describe('paths', () => {
  it('CONDUCTOR_HOME があればそれを使う', () => {
    assert.equal(conductorHome({ CONDUCTOR_HOME: '/x/y' }), '/x/y');
    assert.equal(pathsOf('/x/y').sock, '/x/y/conductord.sock');
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
