// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, parseCpus, UsageError } from '../../src/cli/args.mjs';

describe('parseArgs', () => {
  it('run のオプションとコマンドを分ける', () => {
    assert.deepEqual(parseArgs(['run', '--profile', 'e2e', '--why', 'push 前', '--class', 'batch', '--cpus', '2..6', '--lock', 'a', '--lock', 'b', '--preempt', 'never', '--', 'npm', 'run', 'e2e']), {
      cmd: 'run',
      flags: { profile: 'e2e', why: 'push 前', class: 'batch', cpus: { min: 2, max: 6 }, locks: ['a', 'b'], preempt: 'never' },
      argv: ['npm', 'run', 'e2e'],
    });
  });

  it('-- の後ろはオプションとして読まない', () => {
    assert.deepEqual(parseArgs(['run', '--', 'node', '--test']), { cmd: 'run', flags: {}, argv: ['node', '--test'] });
  });

  it('run の誤りは UsageError', () => {
    assert.throws(() => parseArgs(['run', 'npm', 'test']), /-- が要る/);
    assert.throws(() => parseArgs(['run', '--']), /コマンドが無い/);
    assert.throws(() => parseArgs(['run', '--why', '--']), UsageError);
    assert.throws(() => parseArgs(['run', '--class', 'huge', '--', 'x']), /--class/);
    assert.throws(() => parseArgs(['run', '--preempt', 'stop', '--', 'x']), /--preempt/);
    assert.throws(() => parseArgs(['run', '--nope', '--', 'x']), /知らないオプション/);
  });

  it('top / why / ack / help', () => {
    assert.deepEqual(parseArgs(['top']), { cmd: 'top' });
    assert.deepEqual(parseArgs(['why', 'j1']), { cmd: 'why', jobId: 'j1' });
    assert.deepEqual(parseArgs(['ack', 'j1']), { cmd: 'ack', jobId: 'j1', session: null });
    assert.deepEqual(parseArgs(['ack', 'j1', '--session', 's9']), { cmd: 'ack', jobId: 'j1', session: 's9' });
    assert.deepEqual(parseArgs([]), { cmd: 'help' });
    assert.throws(() => parseArgs(['why']), UsageError);
    assert.throws(() => parseArgs(['fly']), /知らないサブコマンド/);
  });
});

describe('parseCpus', () => {
  it('4 と 2..10 を受け、それ以外は拒む', () => {
    assert.deepEqual(parseCpus('4'), { min: 4, max: 4 });
    assert.deepEqual(parseCpus('2..10'), { min: 2, max: 10 });
    for (const bad of ['0', '3..2', 'a', '2..', '..4', '1.5']) assert.throws(() => parseCpus(bad), UsageError, bad);
  });
});
