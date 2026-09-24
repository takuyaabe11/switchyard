// @ts-check
// メモリを見た受け入れ(schedule の memory)。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../../src/core/schedule.mjs';
import { grants, lease, state, waiting } from '../../testkit/fixtures.mjs';

const running = () => [lease({ id: 'x' }, { cpus: 1 })];

describe('schedule: メモリを見た受け入れ', () => {
  it('CPU が空いていても、重ねると空きメモリが下限を割るなら待たせ、理由を付ける', () => {
    const r = schedule(state({ capacity: 8, leases: running(), waiting: [waiting({ id: 'a', memMb: 3000 })] }), 0, { memory: { availableMb: 4000, floorMb: 1600 } });
    assert.deepEqual(grants(r.actions), []);
    assert.equal(r.state.notes.a.reason, 'メモリ不足(空き 4000MB・見込み 3000MB・残す 1600MB)');
  });

  it('何も走っていなければ、メモリが足りなくても入れる(永久に待たせない)', () => {
    const r = schedule(state({ capacity: 8, waiting: [waiting({ id: 'a', memMb: 9000 })] }), 0, { memory: { availableMb: 1000, floorMb: 1600 } });
    assert.deepEqual(grants(r.actions), [['a', 1]]);
  });

  it('収まれば入れる。同じ回に入れたジョブの見込みも引いて、次を判断する', () => {
    const r = schedule(
      state({ capacity: 8, leases: running(), waiting: [waiting({ id: 'a', memMb: 2500 }, 0), waiting({ id: 'b', memMb: 2500 }, 1)] }),
      10,
      { memory: { availableMb: 5000, floorMb: 1000 } },
    );
    assert.deepEqual(grants(r.actions), [['a', 1]]);
    assert.equal(r.state.notes.b.reason, 'メモリ不足(空き 2500MB・見込み 2500MB・残す 1000MB)');
  });

  it('見込みの無いジョブも、空きが既に下限を割っていれば重ねない', () => {
    const r = schedule(state({ capacity: 8, leases: running(), waiting: [waiting({ id: 'a' })] }), 0, { memory: { availableMb: 500, floorMb: 1000 } });
    assert.deepEqual(grants(r.actions), []);
    const ok = schedule(state({ capacity: 8, leases: running(), waiting: [waiting({ id: 'a' })] }), 0, { memory: { availableMb: 5000, floorMb: 1000 } });
    assert.deepEqual(grants(ok.actions), [['a', 1]]);
  });

  it('実測の CPU の空きへの詰め込みも、メモリの下限を割るなら入れない', () => {
    const full = state({ capacity: 4, leases: [lease({ id: 'x' }, { cpus: 4 })], waiting: [waiting({ id: 'a', memMb: 3000 })] });
    assert.deepEqual(grants(schedule(full, 0, { spare: 3, memory: { availableMb: 4000, floorMb: 1600 } }).actions), []);
    assert.deepEqual(grants(schedule(full, 0, { spare: 3, memory: { availableMb: 8000, floorMb: 1600 } }).actions), [['a', 1]]);
  });

  it('memory を渡さなければ、見込みがあっても見ない', () => {
    const r = schedule(state({ capacity: 8, leases: running(), waiting: [waiting({ id: 'a', memMb: 99_999 })] }), 0);
    assert.deepEqual(grants(r.actions), [['a', 1]]);
  });
});
