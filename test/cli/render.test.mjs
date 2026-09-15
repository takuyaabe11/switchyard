// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { duration, renderProbe, renderTop, renderWhy } from '../../src/cli/render.mjs';

/** @typedef {import('../../src/protocol/messages.mjs').Snapshot} Snapshot */
const T = Date.UTC(2026, 8, 15, 5, 0, 0);

/** @type {Snapshot} */
const snap = {
  capacity: 12,
  used: 3,
  leases: [{ id: 'jA', session: 's1', class: 'batch', cmd: 'npm test', why: 'push 前', cpus: 3, locks: ['port:4173'], phase: 'running', recovering: false, sinceWall: T - 120_000, expectedMs: null, escapes: [] }],
  waiting: [
    { id: 'jB', session: 's2', class: 'measure', cmd: 'npm run benchmark', why: null, cpus: { min: 1, max: 12 }, locks: [], recovering: false, sinceWall: T - 60_000, note: { jobId: 'jB', position: 1, reason: '走行中 1 本の終了を待つ(計測は単独で走る)', etaWall: null }, escapes: [] },
  ],
  unacked: { s3: [{ jobId: 'jC', kind: 'failed', code: 1, cmd: 'npm run build' }] },
  badRecords: 0,
};

describe('render', () => {
  it('duration', () => {
    assert.equal(duration(59_000), '59秒');
    assert.equal(duration(125_000), '2分');
    assert.equal(duration(3_720_000), '1時間2分');
  });

  it('top は使用量・走行・待ち・未確認を並べる', () => {
    assert.equal(
      renderTop(snap, T),
      [
        'CPU 3 / 12 使用中  走行 1 本  待ち 1 本',
        '走行:',
        '  jA [重] 走行 CPU 3 2分  npm test  (目的: push 前 / 鍵: port:4173)',
        '待ち:',
        '  1. jB [計測] npm run benchmark  1分待ち  理由: 走行中 1 本の終了を待つ(計測は単独で走る)',
        '未確認(conductor ack <job> で確認済みにする):',
        '  s3: jC failed(終了コード 1) npm run build',
        '',
      ].join('\n'),
    );
  });

  it('top は空なら、そう言う', () => {
    assert.match(renderTop({ ...snap, used: 0, leases: [], waiting: [], unacked: {} }, T), /走行も待ちも無い/);
  });

  it('why は走行・待ち・未確認・不明を答え分ける', () => {
    assert.deepEqual(renderWhy(snap, 'jA', T), { text: 'jA は走行中(CPU 3・2分)。\n', found: true });
    assert.deepEqual(renderWhy(snap, 'jB', T), { text: 'jB は待ち列の 1 番目(1分待ち)。理由: 走行中 1 本の終了を待つ(計測は単独で走る)。\n', found: true });
    assert.match(renderWhy(snap, 'jC', T).text, /jC は終わっている: failed\(終了コード 1\) npm run build/);
    assert.deepEqual(renderWhy(snap, 'jZ', T).found, false);
  });

  it('抜ける子の記録がある profile は、top と why でそう示す', () => {
    const withEscapes = { ...snap, leases: [{ ...snap.leases[0], escapes: ['chrome'] }], waiting: [{ ...snap.waiting[0], escapes: ['node'] }] };
    const top = renderTop(withEscapes, T);
    assert.match(top, /jA \[重\] 走行 CPU 3 2分  npm test  \(目的: push 前 \/ 鍵: port:4173 \/ 抜ける子: chrome\)/);
    assert.match(top, /理由: 走行中 1 本の終了を待つ\(計測は単独で走る\)  抜ける子: node/);
    assert.equal(
      renderWhy(withEscapes, 'jA', T).text,
      'jA は走行中(CPU 3・2分)。\nこの profile では過去に子がプロセスグループから抜けた(chrome)。信号と使用率の照合が届かない。\n',
    );
  });

  it('probe の結果を 4 行で示す', () => {
    assert.equal(
      renderProbe({ command: 'sh -c x', group: 77, seen: 3, escaped: [{ comm: 'perl', count: 1 }], survivors: [{ pid: 78, comm: 'perl', inGroup: false }] }),
      'コマンド: sh -c x\n観察した子孫: 3(プロセスグループ 77)\nグループから抜けた子: perl ×1\nSIGTERM の後も生きていた子: perl(pid 78・グループ外)(SIGKILL で片付けた)\n',
    );
    assert.match(renderProbe({ command: 'c', group: 1, seen: 1, escaped: [], survivors: [] }), /グループから抜けた子: なし\nSIGTERM の後も生きていた子: なし/);
  });
});
