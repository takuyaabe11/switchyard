// @ts-check
// 実測の空きへの詰め込み(schedule の spare)。宣言の空きに入らない先頭の batch を、実測の空きに cpus.min が収まれば 1 本だけ入れる。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { schedule } from '../../src/core/schedule.mjs';
import { grants, lease, state, waiting } from '../../testkit/fixtures.mjs';

/** 容量 4 を 1 本が使い切っている盤面 @param {import('../../testkit/fixtures.mjs').Waiting[]} w @param {Partial<import('../../src/core/types.mjs').State>} [over] */
const full = (w, over = {}) => state({ capacity: 4, leases: [lease({ id: 'x' }, { cpus: 4 })], waiting: w, ...over });

describe('schedule: 実測の空きへの詰め込み', () => {
  it('宣言の空きが無くても、実測の空きに cpus.min が収まれば min で入れ、余りを配らず、印を付ける', () => {
    const r = schedule(full([waiting({ id: 'a', cpus: { min: 2, max: 4 } })]), 0, { spare: 2.5 });
    assert.deepEqual(grants(r.actions), [['a', 2]]);
    assert.deepEqual(r.actions.find((a) => a.type === 'grant'), { type: 'grant', jobId: 'a', cpus: 2, overcommit: true });
    assert.equal(r.state.leases.find((l) => l.job.id === 'a')?.overcommit, true);
  });

  it('1 回に 1 本まで(入れた走行が立ち上がる前に、同じ空きで次を入れない)', () => {
    const r = schedule(full([waiting({ id: 'a' }, 0), waiting({ id: 'b' }, 1)]), 10, { spare: 3 });
    assert.deepEqual(grants(r.actions), [['a', 1]]);
    assert.equal(r.state.waiting.length, 1);
  });

  it('実測の空きが足りない・測れていない(null)・渡されないなら入れない', () => {
    for (const opts of [{ spare: 1.9 }, { spare: null }, {}]) {
      const r = schedule(full([waiting({ id: 'a', cpus: { min: 2, max: 2 } })]), 0, opts);
      assert.deepEqual(grants(r.actions), [], JSON.stringify(opts));
    }
  });

  it('計測は詰め込まない。計測の走行中と、計測が先に待っている間は、batch も詰め込まない', () => {
    const m = schedule(full([waiting({ id: 'm', class: 'measure' })]), 0, { spare: 4 });
    assert.deepEqual(grants(m.actions), []);
    const running = schedule(state({ capacity: 4, leases: [lease({ id: 'x', class: 'measure' }, { cpus: 4 })], waiting: [waiting({ id: 'a' })] }), 0, { spare: 4 });
    assert.deepEqual(grants(running.actions), []);
    const behind = schedule(full([waiting({ id: 'm', class: 'measure' }, 0), waiting({ id: 'a' }, 1)]), 10, { spare: 4 });
    assert.deepEqual(grants(behind.actions), []);
  });

  it('鍵が空いていなければ詰め込まない', () => {
    const r = schedule(
      state({ capacity: 4, leases: [lease({ id: 'x', locks: ['port'] }, { cpus: 4 })], waiting: [waiting({ id: 'a', locks: ['port'] })] }),
      0,
      { spare: 4 },
    );
    assert.deepEqual(grants(r.actions), []);
  });

  it('宣言の空きに入るものは普段どおり入れ、詰め込みの印を付けない', () => {
    const r = schedule(state({ capacity: 4, waiting: [waiting({ id: 'a', cpus: { min: 1, max: 4 } })] }), 0, { spare: 4 });
    assert.deepEqual(r.actions.find((a) => a.type === 'grant'), { type: 'grant', jobId: 'a', cpus: 4 });
  });

  it('詰め込んだリースは宣言の空きの計算に数え、その後の普通の入場を容量の中に保つ', () => {
    // 容量 4 を x が 3・詰め込んだ y が 2 使っている: 宣言の空きは無いので、次の a は(spare が無ければ)待つ
    const r = schedule(
      state({ capacity: 4, leases: [lease({ id: 'x' }, { cpus: 3 }), lease({ id: 'y' }, { cpus: 2, overcommit: true })], waiting: [waiting({ id: 'a' })] }),
      0,
    );
    assert.deepEqual(grants(r.actions), []);
  });
});
