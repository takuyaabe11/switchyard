// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { runHook } from '../../src/hooks/main.mjs';
import { preToolUse, waitExpected } from '../../src/hooks/pretooluse.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { jobRequest } from '../../testkit/requests.mjs';
import { openClient } from '../../testkit/client.mjs';

/** @type {import('../../src/config/profiles.mjs').NamedProfile[]} */
const PROFILES = [{ name: 'unit', profile: { match: ['npm test*'], class: 'batch' } }];

/** hook の標準入力(Bash) @param {string} command */
const bash = (command) => JSON.stringify({ session_id: 's1', cwd: '/repo', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

describe('runHook(pre-tool-use)の記録(設計 §4.2・§9.2)', () => {
  it('背景へ回した判断と拒否した判断を hooks.jsonl に残し、何もしなかった分は書かない', async () => {
    const home = mkdtempSync(join(tmpdir(), 'chook-'));
    const opts = { env: { SWITCHYARD_HOME: home, SWITCHYARD_BACKGROUND: 'always' }, profilesFor: () => PROFILES, write: () => {} };
    await runHook('pre-tool-use', bash('npm test'), opts);
    await runHook('pre-tool-use', bash('/usr/local/bin/npm test'), opts);
    await runHook('pre-tool-use', bash('echo hi'), opts);
    const rows = readFileSync(pathsOf(home).hooks, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(
      rows.map((r) => [r.kind, r.decision, r.cmd, r.session, r.cwd, typeof r.at]),
      [
        ['hook', 'background', 'npm test', 's1', '/repo', 'number'],
        ['hook', 'deny', '/usr/local/bin/npm test', 's1', '/repo', 'number'],
      ],
    );
  });

  it('判定そのもの(preToolUse)は何も書かない — switchyard replay の空回しが記録を汚さないため', () => {
    const home = mkdtempSync(join(tmpdir(), 'chook-'));
    const out = preToolUse(JSON.parse(bash('npm test')), { env: { SWITCHYARD_HOME: home }, profilesFor: () => PROFILES });
    assert.notEqual(out, null);
    assert.equal(existsSync(pathsOf(home).hooks), false);
  });

  it('記録の置き場所へ書けなくても、判断はそのまま返す', async () => {
    /** @type {string[]} */
    const written = [];
    // SWITCHYARD_HOME をファイル(ディレクトリを作れない場所)にして、記録の書き込みだけを失敗させる
    const file = join(mkdtempSync(join(tmpdir(), 'chook-')), 'not-a-dir');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, '');
    await runHook('pre-tool-use', bash('npm test'), { env: { SWITCHYARD_HOME: file, SWITCHYARD_BACKGROUND: 'always' }, profilesFor: () => PROFILES, write: (s) => written.push(s) });
    assert.equal(written.length, 1);
    assert.match(written[0], /run_in_background/);
  });
});

describe('背景へ回す方針(SWITCHYARD_BACKGROUND)', () => {
  /** @type {import('../../src/protocol/messages.mjs').Snapshot} */
  const empty = { capacity: 4, used: 0, leases: [], waiting: [], unacked: {}, badRecords: 0, version: 'x' };
  /** @param {Partial<import('../../src/protocol/messages.mjs').LeaseView>} over @returns {import('../../src/protocol/messages.mjs').LeaseView} */
  const leaseView = (over) => ({ id: 'l', session: 's', class: 'batch', cmd: 'c', why: null, cpus: 2, locks: [], phase: 'running', recovering: false, sinceWall: 0, expectedMs: null, escapes: [], ...over });
  const batch = (/** @type {number} */ cpusMin, /** @type {string[]} */ locks = []) => ({ jobClass: /** @type {const} */ ('batch'), cpusMin, locks });

  it('waitExpected: 空きがあり、待ち列も計測も鍵の重なりも無ければ待たない', () => {
    assert.equal(waitExpected(empty, [batch(2)]), false);
    assert.equal(waitExpected({ ...empty, used: 2, leases: [leaseView({})] }, [batch(2)]), false);
  });

  it('waitExpected: CPU の空きが足りない・待ち列がある・計測が走る・鍵が使われている・計測を頼むのに走行がある、なら待つ', () => {
    const busy = { ...empty, used: 3, leases: [leaseView({ cpus: 3, locks: ['port:1'] })] };
    assert.equal(waitExpected(busy, [batch(2)]), true, 'CPU');
    assert.equal(waitExpected({ ...empty, waiting: [/** @type {any} */ ({ id: 'w' })] }, [batch(1)]), true, '待ち列');
    assert.equal(waitExpected({ ...empty, used: 1, leases: [leaseView({ class: 'measure', cpus: 1 })] }, [batch(1)]), true, '計測');
    assert.equal(waitExpected({ ...empty, used: 1, leases: [leaseView({ cpus: 1, locks: ['port:1'] })] }, [batch(1, ['port:1'])]), true, '鍵');
    assert.equal(waitExpected({ ...empty, used: 1, leases: [leaseView({ cpus: 1 })] }, [{ jobClass: 'measure', cpusMin: 1, locks: [] }]), true, '計測は単独');
  });

  it('waitExpected: デーモンが実測で縮める profile は、縮めた要求で見積もる(同じ repo の同じ profile だけ)', () => {
    const busy = { ...empty, used: 2, leases: [leaseView({ cpus: 2 })], sized: { [JSON.stringify(['/r', 'unit'])]: 0.8 } };
    const unit = { jobClass: /** @type {const} */ ('batch'), cpusMin: 4, locks: [], profile: 'unit' };
    assert.equal(waitExpected(busy, [unit], '/r'), false, '宣言は 4 コアだが、実測で 1 コアに縮めて入る');
    assert.equal(waitExpected(busy, [unit], '/other'), true, '別の repo は宣言どおり');
    assert.equal(waitExpected(busy, [{ ...unit, profile: 'e2e' }], '/r'), true, '別の profile は宣言どおり');
    assert.equal(waitExpected(busy, [unit]), true, 'repo が分からなければ宣言どおり');
  });

  it('auto(既定): デーモンが居ない・空いているなら前景のまま、容量が埋まっていれば背景へ回す。never は回さない', async () => {
    const home = mkdtempSync(join(tmpdir(), 'chook-'));
    /** @type {string[]} */
    let written = [];
    const run = async (/** @type {Record<string, string>} */ extra = {}) => {
      written = [];
      await runHook('pre-tool-use', bash('npm test'), { env: { SWITCHYARD_HOME: home, ...extra }, profilesFor: () => PROFILES, write: (s) => written.push(s) });
      return written.length === 0 ? null : JSON.parse(written[0]).hookSpecificOutput.updatedInput?.run_in_background;
    };
    assert.equal(await run(), null, 'デーモンが居ない');
    const d = await startDaemon({ home, capacity: 2, tickMs: 20 });
    try {
      assert.equal(await run(), null, '空いている');
      const c = await openClient(d.sock);
      c.send({ t: 'request', job: jobRequest({ cpus: { min: 2, max: 2 } }) });
      await c.next((m) => m.t === 'grant');
      assert.equal(await run(), true, '容量が埋まっている');
      assert.equal(await run({ SWITCHYARD_BACKGROUND: 'never' }), null, 'never');
      c.close();
    } finally {
      await d.close();
    }
  });
});
