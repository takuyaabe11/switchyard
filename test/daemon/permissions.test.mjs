// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { appendRecord } from '../../src/daemon/store.mjs';
import { POSIX_ONLY } from '../../testkit/platform.mjs';

/** @param {string} p */
const mode = (p) => statSync(p).mode & 0o777;

describe('記録の権限(コマンドの全文が入るので、持ち主だけが読める)', { skip: POSIX_ONLY }, () => {
  it('記録を書くと、置き場所は 0700・ファイルは 0600 で作られる', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'cperm-')), 'home');
    appendRecord(pathsOf(home).events, { kind: 'x', cmd: 'deploy --token=secret' });
    assert.equal(mode(home), 0o700);
    assert.equal(mode(pathsOf(home).events), 0o600);
  });

  it('0.7.0 以前に 755 / 644 で作った置き場所と記録を、デーモンの起動時に締め直す', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'cperm-')), 'home');
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    writeFileSync(pathsOf(home).events, '', { mode: 0o644 });
    writeFileSync(pathsOf(home).hooks, '', { mode: 0o644 });
    chmodSync(pathsOf(home).events, 0o644);
    chmodSync(pathsOf(home).hooks, 0o644);
    const d = await startDaemon({ home, capacity: 1, tickMs: 50 });
    try {
      assert.equal(mode(home), 0o700);
      assert.equal(mode(pathsOf(home).events), 0o600);
      assert.equal(mode(pathsOf(home).hooks), 0o600);
      assert.equal(mode(pathsOf(home).state), 0o600);
    } finally {
      await d.close();
    }
  });
});
