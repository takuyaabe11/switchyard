// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAvailableMb, MemoryBook } from '../../src/core/memory.mjs';

describe('MemoryBook(ピークの RSS の実測)', () => {
  it('直近 3 回の最大を見込みにし、記録の無い・0 以下・数でないピークは数えない', () => {
    const b = new MemoryBook();
    assert.equal(b.expected('/r', 'p'), null);
    b.record('/r', 'p', null);
    b.record('/r', 'p', 0);
    b.record('/r', 'p', undefined);
    assert.equal(b.expected('/r', 'p'), null);
    for (const mb of [3000, 1000, 1200, 1100]) b.record('/r', 'p', mb);
    assert.equal(b.expected('/r', 'p'), 1200, '古い 3000 は窓の外');
    assert.equal(b.expected('/r', 'other'), null);
  });
});

describe('effectiveAvailableMb(空きメモリの見積もり)', () => {
  it('走行中のジョブが見込みのピークまでにまだ使っていない分を引く(使い終えた分・見込みの無いジョブは引かない)', () => {
    assert.equal(
      effectiveAvailableMb({
        availableMb: 8000,
        leases: [
          { memMb: 3000, rssMb: 500 },
          { memMb: 1000, rssMb: 1500 },
          { memMb: null, rssMb: 700 },
          { memMb: 2000, rssMb: null },
        ],
      }),
      8000 - 2500 - 2000,
    );
  });
});
