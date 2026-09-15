// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLock, capacityFrom, defaultReserve, lockCapsFrom } from '../../src/daemon/main.mjs';
import { tempHome } from '../../testkit/tmp.mjs';

describe('daemon main', () => {
  it('予約コアは 2 割の切り上げ、容量は残り', () => {
    assert.equal(defaultReserve(15), 3);
    assert.equal(capacityFrom({}, 15, null), 12);
    assert.equal(capacityFrom({}, 1, null), 1);
  });

  it('config.json の reserve と、CONDUCTOR_CAPACITY の上書き', () => {
    assert.equal(capacityFrom({}, 15, { reserve: 5 }), 10);
    assert.equal(capacityFrom({ CONDUCTOR_CAPACITY: '3' }, 15, { reserve: 5 }), 3);
    assert.equal(capacityFrom({ CONDUCTOR_CAPACITY: 'x' }, 15, null), 12);
  });

  it('lockCaps は 1 以上の整数だけを採る', () => {
    assert.deepEqual(lockCapsFrom({ lockCaps: { gpu: 2, bad: 0, str: '3' } }), { gpu: 2 });
    assert.deepEqual(lockCapsFrom(null), {});
  });

  it('ロックは 1 つだけ取れ、持ち主が死んでいれば取り直せる', () => {
    const file = join(tempHome(), 'daemon.lock');
    assert.equal(acquireLock(file, 111, () => true, () => true), true);
    assert.equal(acquireLock(file, 222, () => true, () => true), false);
    assert.equal(acquireLock(file, 333, () => false, () => true), true);
    writeFileSync(file, 'garbage');
    assert.equal(acquireLock(file, 444, () => true, () => true), true);
  });

  it('持ち主の pid が生きていても conductord でなければ、使い回された pid として取り直せる(I1)', () => {
    const file = join(tempHome(), 'daemon.lock');
    assert.equal(acquireLock(file, 111, () => true, () => true), true);
    // pid 111 は生きているが、いま conductord として走っていない(使い回された)
    assert.equal(acquireLock(file, 222, () => true, () => false), true);
    // 生きていて conductord でもあれば、取り直さない
    assert.equal(acquireLock(file, 333, () => true, () => true), false);
  });
});
