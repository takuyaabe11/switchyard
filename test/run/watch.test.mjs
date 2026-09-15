// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEscapeTracker, parsePsLine } from '../../src/run/watch.mjs';

/** @typedef {import('../../src/run/watch.mjs').ProcRow} ProcRow */

describe('parsePsLine(R1)', () => {
  it('空白を含む実行ファイルのパスでも、comm はパス全体・started は lstart の 5 語', () => {
    const line =
      '  501     1   501 Tue Sep 15 14:57:31 2026 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)';
    const r = parsePsLine(line);
    assert.deepEqual(r && [r.pid, r.ppid, r.pgid, r.started], [501, 1, 501, 'Tue Sep 15 14:57:31 2026']);
    assert.equal(r?.comm, '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)');
  });

  it('日付が 1 桁で空白が 2 つ続いても、started は単語をつないだ 1 つの空白区切りになる', () => {
    const line = '   10     1    10 Tue Sep  1 09:05:07 2026 sh';
    const r = parsePsLine(line);
    assert.deepEqual(r, { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'Tue Sep 1 09:05:07 2026' });
  });

  it('語が足りない行は null', () => {
    assert.equal(parsePsLine('10 1 10 Tue Sep 15'), null);
  });
});

describe('createEscapeTracker', () => {
  it('グループの違う子孫を名前ごとに数え、無関係なプロセスは数えない', () => {
    /** @type {ProcRow[]} */
    const table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' },
      { pid: 11, ppid: 10, pgid: 10, comm: '/bin/sleep', started: 'T1' },
      { pid: 12, ppid: 10, pgid: 12, comm: '/usr/bin/perl', started: 'T1' },
      { pid: 13, ppid: 12, pgid: 12, comm: '/usr/bin/perl', started: 'T1' },
      { pid: 99, ppid: 1, pgid: 99, comm: 'other', started: 'T1' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table });
    t.sample();
    const r = t.report();
    assert.deepEqual([r.seen, r.escaped], [4, [{ comm: 'perl', count: 2 }]]);
  });

  it('親が終わって親子関係が切れた後に抜けた子も、開始時刻が同じなら数える', () => {
    /** @type {ProcRow[]} */
    let table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' },
      { pid: 12, ppid: 10, pgid: 10, comm: 'perl', started: 'T2' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table });
    t.sample();
    assert.deepEqual(t.report().escaped, []);
    table = [{ pid: 12, ppid: 1, pgid: 12, comm: 'perl', started: 'T2' }];
    t.sample();
    assert.deepEqual(t.report().escaped, [{ comm: 'perl', count: 1 }]);
  });

  it('終わりかけの子を ps が (perl) のように括弧つきで出しても、同じ名前として数える', () => {
    /** @type {ProcRow[]} */
    let table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' },
      { pid: 12, ppid: 10, pgid: 12, comm: '/usr/bin/perl', started: 'T2' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table });
    t.sample();
    table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' },
      { pid: 12, ppid: 10, pgid: 12, comm: '(perl)', started: 'T2' },
    ];
    t.sample();
    assert.deepEqual(t.report().escaped, [{ comm: 'perl', count: 1 }]);
  });

  it('使い回された pid(開始時刻が違う)を、前に見た子と取り違えない(I2)', () => {
    /** @type {ProcRow[]} */
    let table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' },
      { pid: 12, ppid: 10, pgid: 10, comm: 'perl', started: 'T1' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table });
    t.sample();
    // 同じ pid・同じ名前でも、開始時刻が違えば別のプロセス(使い回された pid)とみなす
    table = [{ pid: 12, ppid: 1, pgid: 12, comm: 'perl', started: 'T9' }];
    t.sample();
    assert.deepEqual(t.report().escaped, []);
  });

  it('終わった後も生きている子を、グループの内か外かを付けて出す(起点の pid は除く)', () => {
    /** @type {ProcRow[]} */
    const table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' },
      { pid: 12, ppid: 10, pgid: 12, comm: 'perl', started: 'T1' },
      { pid: 11, ppid: 10, pgid: 10, comm: 'sleep', started: 'T1' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table });
    t.sample();
    assert.deepEqual(t.report().survivors, [
      { pid: 11, comm: 'sleep', inGroup: true },
      { pid: 12, comm: 'perl', inGroup: false },
    ]);
  });

  it('報告の時点で pid が使い回されていたら、生き残りとして出さない(開始時刻の再照合。I2)', () => {
    /** @type {ProcRow[]} */
    let table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' },
      { pid: 12, ppid: 10, pgid: 12, comm: 'perl', started: 'T1' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table });
    t.sample();
    // report() の直前に、同じ pid が別プロセス(開始時刻が違う)へ使い回された
    table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' },
      { pid: 12, ppid: 1, pgid: 12, comm: 'perl', started: 'T9' },
    ];
    assert.deepEqual(t.report().survivors, []);
  });

  it('報告の時点でプロセスごと消えていたら、生き残りとして出さない', () => {
    /** @type {ProcRow[]} */
    let table = [
      { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' },
      { pid: 12, ppid: 10, pgid: 12, comm: 'perl', started: 'T1' },
    ];
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table });
    t.sample();
    table = [{ pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' }];
    assert.deepEqual(t.report().survivors, []);
  });

  it('ps が失敗しても投げず、それまでに見たものを保つ', () => {
    let fail = false;
    const t = createEscapeTracker({
      rootPid: 10,
      pgid: 10,
      list: () => {
        if (fail) throw new Error('ps が失敗');
        return [
          { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' },
          { pid: 12, ppid: 10, pgid: 12, comm: 'perl', started: 'T1' },
        ];
      },
    });
    t.sample();
    fail = true;
    assert.doesNotThrow(() => t.sample());
    assert.deepEqual(t.report().escaped, [{ comm: 'perl', count: 1 }]);
  });
});
