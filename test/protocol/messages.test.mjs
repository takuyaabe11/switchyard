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
});
