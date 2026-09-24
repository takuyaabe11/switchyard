// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { environmentalNote, environmentalReasons } from '../../src/core/diagnose.mjs';

const quiet = { maxOthers: 0, maxBusyCores: 1, maxOtherLoad: 0, minAvailMb: 8000, heldMs: 0 };
const reasons = (/** @type {any} */ over) => environmentalReasons({ code: 1, killedByCaller: false, stats: quiet, cores: 8, memFloorMb: 1600, ...over });

describe('environmentalReasons(環境のせいかもしれない失敗の手がかり)', () => {
  it('成功・呼び出し元が止めた・終了コードが無いときは何も言わない', () => {
    const busy = { maxOthers: 3, maxBusyCores: 8, maxOtherLoad: 5, minAvailMb: 100, heldMs: 60_000 };
    assert.deepEqual(reasons({ code: 0, stats: busy }), []);
    assert.deepEqual(reasons({ killedByCaller: true, stats: busy }), []);
    assert.deepEqual(reasons({ code: null, stats: busy }), []);
  });

  it('静かな機械での普通の失敗には何も言わない', () => {
    assert.deepEqual(reasons({}), []);
    assert.deepEqual(reasons({ stats: null }), []);
  });

  it('SIGKILL・空きメモリが下限を割った・他の処理と取り合って全コアが忙しかった・計測で止められた、をそれぞれ挙げる', () => {
    assert.equal(reasons({ code: 137 }).length, 1);
    assert.match(reasons({ stats: { ...quiet, minAvailMb: 900 } })[0], /900MB/);
    assert.match(reasons({ stats: { ...quiet, maxOthers: 2, maxBusyCores: 7.5, maxOtherLoad: 5.5 } })[0], /約 5\.5 コアは他の走行\(switchyard の重い走行 2 本を含む\)/);
    assert.match(reasons({ stats: { ...quiet, maxBusyCores: 8, maxOtherLoad: 4 } })[0], /switchyard の外の処理/);
    assert.match(reasons({ stats: { ...quiet, heldMs: 12_000 } })[0], /12 秒/);
    assert.equal(reasons({ code: 137, stats: { maxOthers: 1, maxBusyCores: 8, maxOtherLoad: 6, minAvailMb: 10, heldMs: 5_000 } }).length, 4);
  });

  it('しきい値の手前では挙げない(重なっても機械に余裕がある・重ならずに忙しい・短い一時停止・下限を知らない)', () => {
    assert.deepEqual(reasons({ stats: { ...quiet, maxOthers: 2, maxBusyCores: 6, maxOtherLoad: 4 } }), [], '機械に余裕がある');
    assert.deepEqual(reasons({ stats: { ...quiet, maxBusyCores: 8, maxOtherLoad: 0.5 } }), [], '忙しいのはほぼ自分だけ');
    assert.deepEqual(reasons({ stats: { ...quiet, maxBusyCores: 8, maxOtherLoad: null } }), [], '測れていない');
    assert.deepEqual(reasons({ stats: { ...quiet, heldMs: 999 } }), []);
    assert.deepEqual(reasons({ stats: { ...quiet, minAvailMb: 10 }, memFloorMb: null }), []);
  });

  it('Claude に見せる 1 行は、手がかりと「コードを直す前に空いてから走らせ直す」を含む', () => {
    const note = environmentalNote(['a', 'b']);
    assert.match(note, /コードのせいではないかもしれない: a・b/);
    assert.match(note, /コードを直す前に/);
  });
});
