// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEscapeTracker, nextWatchMs, parsePsLine } from '../../src/run/watch.mjs';

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

  it('Linux(procps)の形も読める: comm はパスでなく名前、桁の幅も違う', () => {
    // procps の `ps -A -o pid=,ppid=,pgid=,lstart=,comm=` の実際の形。
    // macOS と違い comm は実行ファイルの名前だけ(最大 15 文字)で、空白を含まない。
    // Linux の土台では手元で走らせられないので、出力の形をここで固定する(CI の ubuntu が実物で確かめる)
    assert.deepEqual(parsePsLine('      1       0       1 Mon Sep 15 08:33:02 2026 systemd'), {
      pid: 1,
      ppid: 0,
      pgid: 1,
      comm: 'systemd',
      started: 'Mon Sep 15 08:33:02 2026',
    });
    assert.deepEqual(parsePsLine('  12345    1234   12345 Tue Sep  1 09:05:07 2026 node'), {
      pid: 12345,
      ppid: 1234,
      pgid: 12345,
      comm: 'node',
      started: 'Tue Sep 1 09:05:07 2026',
    });
    // カーネルスレッドは角括弧つきで出る。名前として扱えれば足りる(数に混じっても数字は壊さない)
    assert.equal(parsePsLine('     28       2      0 Mon Sep 15 08:33:02 2026 [kworker/0:1]')?.comm, '[kworker/0:1]');
  });
});

describe('processTable(ps が使えない土台)', () => {
  it('ps が無い・形が違う土台では、追跡を諦めて投げない(順番待ちと鍵は効いたまま)', () => {
    const t = createEscapeTracker({
      rootPid: 1,
      pgid: 1,
      list: () => {
        throw new Error('ps: 使えない(BusyBox など)');
      },
    });
    assert.equal(t.sample(), false, '投げない');
    assert.deepEqual(t.report(), { seen: 0, escaped: [], survivors: [] }, '報告は空になるだけ');
  });
});

describe('nextWatchMs(見張りの間隔の後退)', () => {
  it('変化が無ければ倍にして上限で止め、変化があれば最初へ戻す', () => {
    assert.equal(nextWatchMs(2_000, false, 2_000, 30_000), 4_000);
    assert.equal(nextWatchMs(4_000, false, 2_000, 30_000), 8_000);
    assert.equal(nextWatchMs(16_000, false, 2_000, 30_000), 30_000);
    assert.equal(nextWatchMs(30_000, false, 2_000, 30_000), 30_000);
    assert.equal(nextWatchMs(30_000, true, 2_000, 30_000), 2_000);
  });
});

describe('createEscapeTracker の sample が変化を返す', () => {
  /** @type {ProcRow[]} */
  const first = [
    { pid: 10, ppid: 1, pgid: 10, comm: 'sh', started: 'T1' },
    { pid: 11, ppid: 10, pgid: 10, comm: 'sleep', started: 'T1' },
  ];
  it('初回と、子孫が増えた回・グループが変わった回は true。同じ表なら false', () => {
    let table = first;
    const t = createEscapeTracker({ rootPid: 10, pgid: 10, list: () => table });
    assert.equal(t.sample(), true, '初回');
    assert.equal(t.sample(), false, '同じ表');
    table = [...first, { pid: 12, ppid: 10, pgid: 12, comm: 'perl', started: 'T1' }];
    assert.equal(t.sample(), true, '子孫が増えた');
    assert.equal(t.sample(), false);
    // 同じ pid のグループが変わった(抜けた)
    table = [first[0], { pid: 11, ppid: 10, pgid: 77, comm: 'sleep', started: 'T1' }, table[2]];
    assert.equal(t.sample(), true, 'グループが変わった');
  });

  it('ps が失敗した回は変化なしとして扱う(追跡は続ける)', () => {
    const t = createEscapeTracker({
      rootPid: 10,
      pgid: 10,
      list: () => {
        throw new Error('ps が失敗');
      },
    });
    assert.equal(t.sample(), false);
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
