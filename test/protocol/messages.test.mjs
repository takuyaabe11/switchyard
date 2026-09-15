// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobRequest } from '../../src/protocol/messages.mjs';
import { jobRequest } from '../../testkit/requests.mjs';

describe('parseJobRequest', () => {
  it('鍵だけのジョブ(cpus 0..0 と鍵 1 本以上)を受け付ける', () => {
    const req = jobRequest({ class: 'quick', cpus: { min: 0, max: 0 }, locks: ['git-index:/r/.git'] });
    assert.deepEqual(parseJobRequest(req), req);
  });

  it('cpus 0..0 で鍵が無ければ投げる', () => {
    assert.throws(() => parseJobRequest(jobRequest({ cpus: { min: 0, max: 0 }, locks: [] })), /鍵だけのジョブは、job.locks を 1 本以上持つ/);
  });

  it('0..N や min 0 だけの幅は投げる', () => {
    assert.throws(() => parseJobRequest(jobRequest({ cpus: { min: 0, max: 2 }, locks: ['a'] })), /job.cpus は/);
    assert.throws(() => parseJobRequest(jobRequest({ cpus: { min: 2, max: 1 } })), /job.cpus は/);
  });

  it('parent(鍵だけの親のジョブの id)は、文字列ならそのまま載せ、省略・null なら載せない(設計 §4.3 の 7)', () => {
    assert.equal(parseJobRequest(jobRequest({ parent: 'j7' })).parent, 'j7');
    assert.equal('parent' in parseJobRequest(jobRequest()), false);
    assert.equal('parent' in parseJobRequest({ ...jobRequest(), parent: null }), false);
  });

  it('parent が空の文字列や文字列以外なら投げる', () => {
    assert.throws(() => parseJobRequest(jobRequest({ parent: '' })), /job.parent は空でない文字列か null/);
    assert.throws(() => parseJobRequest({ ...jobRequest(), parent: 7 }), /job.parent は空でない文字列か null/);
  });
});
