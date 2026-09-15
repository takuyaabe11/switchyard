// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEscapeTracker } from '../../src/run/watch.mjs';

/** @typedef {import('../../src/run/watch.mjs').ProcRow} ProcRow */

describe('createEscapeTracker', () => {
  it('グループの違う子孫を名前ごとに数え、無関係なプロセスは数えない', () => {
    /** @type {ProcRow[]} */
    const table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh' },
      { pid: 11, ppid: 10, pgid: 10, comm: '/bin/sleep' },
      { pid: 12, ppid: 10, pgid: 12, comm: '/usr/bin/perl' },
      { pid: 13, ppid: 12, pgid: 12, comm: '/usr/bin/perl' },
      { pid: 99, ppid: 1, pgid: 99, comm: 'other' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table, isAlive: () => false });
    t.sample();
    assert.deepEqual(t.report(), { seen: 4, escaped: [{ comm: 'perl', count: 2 }], survivors: [] });
  });

  it('親が終わって親子関係が切れた後に抜けた子も、同じ名前なら数える', () => {
    /** @type {ProcRow[]} */
    let table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh' },
      { pid: 12, ppid: 10, pgid: 10, comm: 'perl' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table, isAlive: () => false });
    t.sample();
    assert.deepEqual(t.report().escaped, []);
    table = [{ pid: 12, ppid: 1, pgid: 12, comm: 'perl' }];
    t.sample();
    assert.deepEqual(t.report().escaped, [{ comm: 'perl', count: 1 }]);
  });

  it('終わりかけの子を ps が (perl) のように括弧つきで出しても、同じ名前として数える', () => {
    /** @type {ProcRow[]} */
    let table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh' },
      { pid: 12, ppid: 10, pgid: 12, comm: '/usr/bin/perl' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table, isAlive: () => false });
    t.sample();
    table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh' },
      { pid: 12, ppid: 10, pgid: 12, comm: '(perl)' },
    ];
    t.sample();
    assert.deepEqual(t.report().escaped, [{ comm: 'perl', count: 1 }]);
  });

  it('使い回された pid(名前が違う)を、前に見た子と取り違えない', () => {
    /** @type {ProcRow[]} */
    let table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh' },
      { pid: 12, ppid: 10, pgid: 10, comm: 'perl' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table, isAlive: () => false });
    t.sample();
    table = [{ pid: 12, ppid: 1, pgid: 12, comm: 'nginx' }];
    t.sample();
    assert.deepEqual(t.report().escaped, []);
  });

  it('終わった後も生きている子を、グループの内か外かを付けて出す(起点の pid は除く)', () => {
    /** @type {ProcRow[]} */
    const table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh' },
      { pid: 12, ppid: 10, pgid: 12, comm: 'perl' },
      { pid: 11, ppid: 10, pgid: 10, comm: 'sleep' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table, isAlive: () => true });
    t.sample();
    assert.deepEqual(t.report().survivors, [
      { pid: 11, comm: 'sleep', inGroup: true },
      { pid: 12, comm: 'perl', inGroup: false },
    ]);
  });

  it('ps が失敗しても投げず、それまでに見たものを保つ', () => {
    let fail = false;
    const t = createEscapeTracker({
      rootPid: 10,
      pgid: 10,
      list: () => {
        if (fail) throw new Error('ps が失敗');
        return [
          { pid: 10, ppid: 1, pgid: 10, comm: 'sh' },
          { pid: 12, ppid: 10, pgid: 12, comm: 'perl' },
        ];
      },
      isAlive: () => false,
    });
    t.sample();
    fail = true;
    assert.doesNotThrow(() => t.sample());
    assert.deepEqual(t.report().escaped, [{ comm: 'perl', count: 1 }]);
  });
});
