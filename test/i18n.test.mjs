// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lang, langOf, setLang, t } from '../src/i18n.mjs';
import { schedule } from '../src/core/schedule.mjs';
import { preToolUse } from '../src/hooks/pretooluse.mjs';
import { stop } from '../src/hooks/session.mjs';
import { renderTop } from '../src/cli/render.mjs';
import { formatReport, reasonKind, summarize } from '../src/report/report.mjs';
import { lease, state, waiting } from '../testkit/fixtures.mjs';

const before = lang();
afterEach(() => setLang(before));

describe('言語(i18n)', () => {
  it('SWITCHYARD_LANG が最優先、次に LC_ALL → LC_MESSAGES → LANG が ja で始まるか。それ以外は英語', () => {
    assert.equal(langOf({}), 'en');
    assert.equal(langOf({ LANG: 'ja_JP.UTF-8' }), 'ja');
    assert.equal(langOf({ LANG: 'ja_JP.UTF-8', LC_ALL: 'C' }), 'en');
    assert.equal(langOf({ LC_MESSAGES: 'ja_JP' }), 'ja');
    assert.equal(langOf({ LANG: 'en_US.UTF-8', SWITCHYARD_LANG: 'ja' }), 'ja');
    assert.equal(langOf({ LANG: 'ja_JP.UTF-8', SWITCHYARD_LANG: 'en' }), 'en');
    assert.equal(langOf({ SWITCHYARD_LANG: 'fr', LANG: 'ja_JP' }), 'ja', '知らない値は無視する');
  });

  it('t はいまの言語の文言を選ぶ', () => {
    setLang('en');
    assert.equal(t('日本語', 'English'), 'English');
    setLang('ja');
    assert.equal(t('日本語', 'English'), '日本語');
  });

  it('英語でも、待ちの理由・拒否の理由・Stop の差し戻し・top に日本語が混じらない', async () => {
    setLang('en');
    const jp = /[぀-ヿ一-鿿]/;
    const r = schedule(state({ capacity: 2, leases: [lease({ id: 'a', locks: ['k'] }, { cpus: 2 })], waiting: [waiting({ id: 'b', locks: ['k'] }), waiting({ id: 'c' }, 1)] }), 0);
    for (const n of Object.values(r.state.notes)) assert.doesNotMatch(n.reason, jp, n.reason);
    const deny = /** @type {any} */ (preToolUse({ tool_name: 'Bash', cwd: '/', tool_input: { command: '/usr/bin/npm test' } }, { profilesFor: () => [{ name: 'u', profile: { match: ['npm test'], class: 'batch' } }] }));
    assert.doesNotMatch(deny.hookSpecificOutput.permissionDecisionReason, jp);
    const out = await stop(
      { session_id: 'abcdefgh-1' },
      {
        env: { SWITCHYARD_HOME: '/tmp/none', SWITCHYARD_STOP: 'block' },
        connect: /** @type {any} */ (async () => {
          const { EventEmitter } = await import('node:events');
          const sock = Object.assign(new EventEmitter(), {
            destroyed: false,
            setEncoding() {},
            write() {
              setImmediate(() => sock.emit('data', `${JSON.stringify({ t: 'unacked', jobs: [{ jobId: 'j1', kind: 'failed', code: 1, cmd: 'npm test' }] })}\n`));
            },
            destroy() {},
          });
          return sock;
        }),
      },
    );
    assert.doesNotMatch(String(out?.reason), jp);
    assert.match(String(out?.reason), /Re-running the same command successfully/);
    const top = renderTop({ capacity: 2, used: 2, leases: [], waiting: [], unacked: { s: [{ jobId: 'j', kind: 'failed', code: 1, cmd: 'x' }] }, badRecords: 0, version: 'x' }, 0);
    assert.doesNotMatch(top, jp);
  });

  it('report は英語の理由も種別に分け、英語でも日本語が混じらない', () => {
    for (const [ja, en, kind] of [
      ['計測 m の走行中は入場しない', 'no admission while measurement m runs', 'measure'],
      ['鍵 k を a が保持', 'lock k held by a', 'lock'],
      ['CPU 不足(空き 0 / 必要 2)', 'not enough CPU (free 0 / needs 2)', 'cpu'],
      ['先頭 a の後ろ(後ろ詰めの見込みなし)', 'behind head a (not expected to finish before it)', 'behind'],
    ]) {
      assert.equal(reasonKind(ja), kind, ja);
      assert.equal(reasonKind(en), kind, en);
    }
    setLang('en');
    assert.doesNotMatch(formatReport(summarize({ events: [] }), { repoPrefix: '/r', sinceDays: 3 }), /[぀-ヿ一-鿿]/);
  });
});
