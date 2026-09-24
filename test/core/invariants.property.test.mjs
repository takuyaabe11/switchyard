// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { checkInvariants } from '../../testkit/invariants.mjs';
import { lease, MIN, state, waiting } from '../../testkit/fixtures.mjs';
import { simulate } from '../../testkit/simulate.mjs';

/** @typedef {import('../../testkit/simulate.mjs').Scenario} Scenario */

/** @type {fc.Arbitrary<Scenario>} */
const scenario = fc
  .record({
    capacity: fc.integer({ min: 1, max: 8 }),
    spare: fc.option(fc.integer({ min: 0, max: 4 }), { nil: null }),
    // 空きメモリは出来事によらず一定(走行が終わっても戻らない、いちばん厳しい形)
    memory: fc.option(fc.record({ availableMb: fc.integer({ min: 0, max: 8000 }), floorMb: fc.integer({ min: 0, max: 4000 }) }), { nil: null }),
    qCap: fc.integer({ min: 1, max: 2 }),
    jobs: fc.array(
      fc.record({
        arriveMin: fc.integer({ min: 0, max: 30 }),
        runMin: fc.integer({ min: 1, max: 20 }),
        code: fc.constantFrom(0, 0, 0, 1),
        cls: fc.constantFrom(/** @type {const} */ ('quick'), 'batch', 'batch', 'measure'),
        min: fc.integer({ min: 1, max: 10 }),
        extra: fc.integer({ min: 0, max: 6 }),
        locks: fc.subarray(['p', 'q', 'p']),
        expectedMin: fc.option(fc.integer({ min: 1, max: 25 }), { nil: null }),
        memMb: fc.option(fc.integer({ min: 100, max: 6000 }), { nil: null }),
        // 4 本に 1 本は鍵だけのジョブ(CPU 0..0・鍵 1 本以上。設計 §5.2)
        lockOnly: fc.constantFrom(false, false, false, true),
        // 鍵だけのジョブを指せば、その親の子(設計 §6.2)。到着の時刻しだいで、親が居るときも居ないときもある
        parentPick: fc.option(fc.nat({ max: 11 }), { nil: null }),
      }),
      { minLength: 1, maxLength: 12 },
    ),
  })
  .map((raw) => ({
    capacity: raw.capacity,
    spare: raw.spare,
    memory: raw.memory,
    lockCaps: { p: 1, q: raw.qCap },
    jobs: raw.jobs.map((j, i) => {
      const pick = j.parentPick;
      const parent = pick !== null && pick !== i && raw.jobs[pick]?.lockOnly === true ? `j${pick}` : null;
      return {
        id: `j${i}`,
        arriveAt: j.arriveMin * MIN,
        runMs: j.runMin * MIN,
        code: j.code,
        spec: j.lockOnly
          ? {
              class: /** @type {const} */ ('quick'),
              cpus: { min: 0, max: 0 },
              locks: j.locks.length > 0 ? j.locks : ['p'],
              expectedMs: j.expectedMin === null ? null : j.expectedMin * MIN,
              cmd: `lock ${i}`,
            }
          : {
              class: j.cls,
              cpus: { min: j.min, max: j.min + j.extra },
              locks: j.locks,
              expectedMs: j.expectedMin === null ? null : j.expectedMin * MIN,
              cmd: `cmd ${i}`,
              memMb: j.memMb,
              ...(parent !== null ? { parent } : {}),
            },
      };
    }),
  }));

describe('不変条件(性質テスト)', () => {
  it('どんな到着の列でも I1〜I3・I6 を破らず、全ジョブが上限時刻までに終わる(I5)', () => {
    fc.assert(
      fc.property(scenario, (sc) => {
        // 破れたら simulate が条件名つきで投げる
        assert.equal(simulate(sc).finished, sc.jobs.length);
      }),
      { numRuns: 500 },
    );
  });

  it('同じ入力なら入場の順番は毎回同じ(決定的)', () => {
    fc.assert(
      fc.property(scenario, (sc) => {
        assert.deepEqual(simulate(sc).grantOrder, simulate(sc).grantOrder);
      }),
      { numRuns: 100 },
    );
  });
});

describe('検査器そのものの検出力', () => {
  it('I1: 容量超えを検出する', () => {
    assert.throws(() => checkInvariants(state({ capacity: 2, leases: [lease({ id: 'a', cpus: { min: 1, max: 3 } }, { cpus: 3 })] })), /I1/);
  });
  it('I1: 親の子として入場したリースは合計から除き(親が先に居なくなっても)、それ以外の容量超えは検出する', () => {
    const parent = lease({ id: 'g', class: 'quick', cpus: { min: 0, max: 0 }, locks: ['g'] }, { cpus: 0 });
    const x = lease({ id: 'x', cpus: { min: 2, max: 2 } }, { cpus: 2 });
    assert.doesNotThrow(() => checkInvariants(state({ capacity: 2, leases: [parent, x, lease({ id: 'c', parent: 'g' }, { cpus: 1, lockChild: true })] })));
    assert.doesNotThrow(() => checkInvariants(state({ capacity: 2, leases: [x, lease({ id: 'c', parent: 'g' }, { cpus: 1, lockChild: true })] })));
    assert.throws(() => checkInvariants(state({ capacity: 2, leases: [parent, x, lease({ id: 'c', parent: 'g' }, { cpus: 1 })] })), /I1/);
  });
  it('I2: 鍵の容量超えを検出する', () => {
    assert.throws(() => checkInvariants(state({ leases: [lease({ id: 'a', locks: ['p'] }), lease({ id: 'b', locks: ['p'] })] })), /I2/);
  });
  it('I3: 計測との同時走行を検出する', () => {
    assert.throws(() => checkInvariants(state({ leases: [lease({ id: 'm', class: 'measure' }), lease({ id: 'b' })] })), /I3/);
  });
  it('I3: 鍵だけのリース(cpus 0)は計測と並んでも投げない', () => {
    assert.doesNotThrow(() =>
      checkInvariants(state({ leases: [lease({ id: 'm', class: 'measure' }), lease({ id: 'g', class: 'quick', cpus: { min: 0, max: 0 }, locks: ['g'] }, { cpus: 0 })] })),
    );
  });
  it('cpus の範囲外を検出する', () => {
    assert.throws(() => checkInvariants(state({ leases: [lease({ id: 'a', cpus: { min: 2, max: 4 } }, { cpus: 1 })] })), /範囲外/);
  });
  it('I6: 待ちとリースの重複を検出する', () => {
    assert.throws(() => checkInvariants(state({ waiting: [waiting({ id: 'a' })], leases: [lease({ id: 'a' })] })), /I6/);
  });
  it('正しい状態では投げない', () => {
    assert.doesNotThrow(() => checkInvariants(state({ capacity: 4, leases: [lease({ id: 'a', locks: ['p'] }, { cpus: 1 })], waiting: [waiting({ id: 'b', locks: ['p'] })] })));
  });
});
