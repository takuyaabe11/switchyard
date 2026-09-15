// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDecoder, encode } from '../../src/protocol/ndjson.mjs';

describe('ndjson', () => {
  it('encode は 1 行の JSON に改行を付ける', () => {
    assert.equal(encode({ t: 'hb', jobId: 'j1' }), '{"t":"hb","jobId":"j1"}\n');
  });

  it('断片に分かれて届いても、行がそろったときに 1 回ずつ渡す', () => {
    /** @type {unknown[]} */
    const got = [];
    const feed = createDecoder((m) => got.push(m), () => assert.fail('壊れた行は無いはず'));
    feed('{"a":');
    assert.deepEqual(got, []);
    feed('1}\n{"b":2}\n{"c"');
    assert.deepEqual(got, [{ a: 1 }, { b: 2 }]);
    feed(':3}\n');
    assert.deepEqual(got, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('JSON でない行は onBadLine へ渡し、続きは読み続ける', () => {
    /** @type {unknown[]} */
    const got = [];
    /** @type {string[]} */
    const bad = [];
    const feed = createDecoder((m) => got.push(m), (l) => bad.push(l));
    feed('not json\n\n{"ok":true}\n');
    assert.deepEqual(bad, ['not json']);
    assert.deepEqual(got, [{ ok: true }]);
  });

  it('onMessage の例外を壊れた行と取り違えない', () => {
    /** @type {string[]} */
    const bad = [];
    const feed = createDecoder(() => {
      throw new Error('受け手の失敗');
    }, (l) => bad.push(l));
    assert.throws(() => feed('{"x":1}\n'), /受け手の失敗/);
    assert.deepEqual(bad, []);
  });
});
