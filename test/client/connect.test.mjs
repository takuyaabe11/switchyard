// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask, connectDaemon, DaemonUnavailableError } from '../../src/client/connect.mjs';
import { isClaudeSession, sessionId } from '../../src/client/session.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { tempHome } from '../../testkit/tmp.mjs';
import { waitFor } from '../../testkit/wait.mjs';

/** @type {string[]} 片付けるデーモンの home */
let homes = [];
afterEach(async () => {
  for (const home of homes) {
    const lock = pathsOf(home).lock;
    if (!existsSync(lock)) continue;
    const pid = Number(readFileSync(lock, 'utf8'));
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // 既に居ない
    }
    await waitFor(() => !existsSync(lock), 3_000);
  }
  homes = [];
});

describe('connectDaemon', () => {
  it('デーモンが居なくて自動起動しないなら DaemonUnavailableError', async () => {
    await assert.rejects(connectDaemon({ home: tempHome(), autoStart: false }), DaemonUnavailableError);
  });

  it('居なければデーモンを起動してつなぐ', async () => {
    const home = tempHome();
    homes.push(home);
    const conn = await connectDaemon({ home, timeoutMs: 5_000 });
    const m = await ask(conn, { t: 'status' }, (x) => x.t === 'status');
    assert.equal(typeof /** @type {Record<string, unknown>} */ (m.snapshot).capacity, 'number');
  });

  it('同時に 2 つが自動起動しても、デーモンは 1 つだけ立ち、両方つながる', async () => {
    const home = tempHome();
    homes.push(home);
    const [a, b] = await Promise.all([connectDaemon({ home, timeoutMs: 5_000 }), connectDaemon({ home, timeoutMs: 5_000 })]);
    const [ma, mb] = await Promise.all([ask(a, { t: 'status' }, (x) => x.t === 'status'), ask(b, { t: 'status' }, (x) => x.t === 'status')]);
    assert.equal(ma.t, 'status');
    assert.equal(mb.t, 'status');
    const pid = Number(readFileSync(pathsOf(home).lock, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);
  });

  it('自動起動するデーモンには、呼び出し元の入れ子の印を渡さない', async () => {
    const home = tempHome();
    const dir = mkdtempSync(join(tmpdir(), 'cfaked-'));
    const out = join(dir, 'env.json');
    const entry = join(dir, 'fake-daemon.mjs');
    // 受け取った環境を書いて終わるだけの、デーモンの代わり(接続は受けないので connectDaemon は時間切れで投げる)
    writeFileSync(
      entry,
      [
        "import { renameSync, writeFileSync } from 'node:fs';",
        `const out = ${JSON.stringify(out)};`,
        "const pick = (k) => process.env[k] ?? null;",
        "writeFileSync(out + '.tmp', JSON.stringify({ inJob: pick('CONDUCTOR_IN_JOB'), held: pick('CONDUCTOR_HELD_LOCKS'), job: pick('CONDUCTOR_JOB_ID'), home: pick('CONDUCTOR_HOME') }));",
        "renameSync(out + '.tmp', out);",
      ].join('\n'),
    );
    const env = { ...process.env, CONDUCTOR_IN_JOB: '1', CONDUCTOR_HELD_LOCKS: 'a,b', CONDUCTOR_JOB_ID: 'jparent' };
    await assert.rejects(connectDaemon({ home, env, timeoutMs: 300, daemonEntry: entry }), DaemonUnavailableError);
    await waitFor(() => existsSync(out), 3_000);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), { inJob: null, held: null, job: null, home });
  });

  it('ask は error の応答を投げる', async () => {
    const home = tempHome();
    homes.push(home);
    const conn = await connectDaemon({ home, timeoutMs: 5_000 });
    await assert.rejects(ask(conn, { t: 'nope' }, () => false), /知らないメッセージ/);
  });
});

describe('session', () => {
  it('CLAUDE_CODE_SESSION_ID の先頭 8 文字、無ければ human:<親の pid>', () => {
    assert.equal(sessionId({ CLAUDE_CODE_SESSION_ID: '5d014e12abcdef' }, 1), '5d014e12');
    assert.equal(sessionId({}, 4321), 'human:4321');
    assert.equal(isClaudeSession({ CLAUDE_CODE_SESSION_ID: 'x' }), true);
    assert.equal(isClaudeSession({}), false);
  });
});
