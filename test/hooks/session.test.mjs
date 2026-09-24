// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDaemon, DaemonUnavailableError } from '../../src/client/connect.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { runHook } from '../../src/hooks/main.mjs';
import { compareVersions, deadShimPaths, pathExportLine, pruneShimLines, sessionStart, stop, updateNotice } from '../../src/hooks/session.mjs';
import { openClient } from '../../testkit/client.mjs';
import { jobRequest } from '../../testkit/requests.mjs';
import { tempHome } from '../../testkit/tmp.mjs';

/** 更新の確認で外へ問わない(既定で有効なので、テストでは差し替える) */
const noUpdate = async () => null;

const HOOK_BIN = fileURLToPath(new URL('../../bin/switchyard-hook.mjs', import.meta.url));

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function daemon() {
  const home = tempHome();
  const d = await startDaemon({ home, capacity: 4, tickMs: 20 });
  cleanups.push(() => d.close());
  return { d, home };
}

/** 自動起動しない接続 @type {typeof connectDaemon} */
const noAutoStart = (o) => connectDaemon({ ...o, autoStart: false });

/** @type {typeof connectDaemon} */
const unavailable = async () => {
  throw new DaemonUnavailableError('テスト');
};

const envFileIn = () => join(mkdtempSync(join(tmpdir(), 'cenv-')), 'env.sh');

/** env ファイルを読み込んだ sh の PATH @param {string} file */
const pathAfterSourcing = (file) => execFileSync('/bin/sh', ['-c', `. "${file}"; printf %s "$PATH"`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });

/** セッション sessStop に、終了コード 1 で終わったジョブを 1 本作る @param {string} sock */
async function failedJob(sock) {
  const c = await openClient(sock);
  cleanups.push(() => c.close());
  c.send({ t: 'request', job: jobRequest({ session: 'sessStop', cmd: 'npm test' }) });
  const acc = await c.next((m) => m.t === 'accepted');
  await c.next((m) => m.t === 'grant');
  c.send({ t: 'started', jobId: acc.jobId, pid: process.pid, pgid: null });
  c.send({ t: 'exit', jobId: acc.jobId, code: 1, killedByCaller: false, durationMs: 5 });
  await c.next((m) => m.t === 'ok');
  return String(acc.jobId);
}

describe('新しい版の知らせ(既定で無効。SWITCHYARD_UPDATE_CHECK=1 で問う)', () => {
  it('compareVersions は数の並びで比べる', () => {
    assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
    assert.ok(compareVersions('1.0.0', '1.0.0') === 0);
    assert.ok(compareVersions('0.5.0', '0.6.0') < 0);
  });

  it('既定と 0 では外へ問わない。1 なら新しいときだけ知らせ、1 日は控えを使う。問えなければ黙る', async () => {
    const home = tempHome();
    let asked = 0;
    const fetchLatest = async () => {
      asked += 1;
      return '9.0.0';
    };
    assert.equal(await updateNotice({ env: { SWITCHYARD_HOME: home, SWITCHYARD_UPDATE_CHECK: '0' }, version: '0.6.0', fetchLatest }), null);
    assert.equal(await updateNotice({ env: { SWITCHYARD_HOME: home }, version: '0.6.0', fetchLatest }), null);
    assert.equal(asked, 0, '既定と 0 では外へ出ない');
    const env = { SWITCHYARD_HOME: home, SWITCHYARD_UPDATE_CHECK: '1' };
    assert.match(String(await updateNotice({ env, version: '0.6.0', fetchLatest, now: () => 1_000 })), /9\.0\.0/);
    assert.match(String(await updateNotice({ env, version: '0.6.0', fetchLatest, now: () => 2_000 })), /9\.0\.0/);
    assert.equal(asked, 1, '1 日の間は控えを使う');
    await updateNotice({ env, version: '0.6.0', fetchLatest, now: () => 1_000 + 86_400_001 });
    assert.equal(asked, 2, '1 日たてば問い直す');
    assert.equal(await updateNotice({ env, version: '9.0.0', fetchLatest, now: () => 3_000 }), null, '同じ版なら知らせない');
    const failing = async () => {
      throw new Error('offline');
    };
    assert.equal(await updateNotice({ env: { SWITCHYARD_HOME: tempHome(), SWITCHYARD_UPDATE_CHECK: '1' }, version: '0.6.0', fetchLatest: failing }), null);
  });
});

describe('deadShimPaths(PATH に残った死んだ shims)', () => {
  it('指す先が無い shims の行だけを挙げる', () => {
    const live = pathExportLine(fileURLToPath(new URL('../../', import.meta.url)));
    const text = [live, "export PATH='/nowhere/dev/conductor/shims':\"$PATH\"", 'export PATH=/usr/bin:"$PATH"', ''].join('\n');
    assert.deepEqual(deadShimPaths(text), ['/nowhere/dev/conductor/shims']);
  });

  it('同じ行が 2 度あっても 1 つだけ挙げる', () => {
    const line = "export PATH='/nowhere/x/shims':\"$PATH\"";
    assert.deepEqual(deadShimPaths([line, line].join('\n')), ['/nowhere/x/shims']);
  });

  it('shims の行が無ければ空', () => {
    assert.deepEqual(deadShimPaths('export FOO=1\n'), []);
  });
});

describe('pruneShimLines', () => {
  it('挙げた shims の行だけを外し、他の行は 1 文字も変えない', () => {
    const other = "export PATH='/other/plugin/shims':\"$PATH\"";
    const text = ["export FOO=1", "export PATH='/dead/shims':\"$PATH\"", other, ''].join('\n');
    assert.equal(pruneShimLines(text, ['/dead/shims']), ['export FOO=1', other, ''].join('\n'));
  });
});

describe('sessionStart の PATH の知らせ', () => {
  it('死んだ shims の行を env ファイルから外し、そう知らせる', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchyard-env-'));
    const envFile = join(dir, 'env.sh');
    const keep = 'export OTHER=1';
    writeFileSync(envFile, `export PATH='/nowhere/dev/conductor/shims':"$PATH"\n${keep}\n`);
    const lines = await sessionStart({}, { fetchLatest: noUpdate,
      env: { CLAUDE_ENV_FILE: envFile, SWITCHYARD_HOME: dir },
      connect: () => Promise.reject(new DaemonUnavailableError('居ない')),
    });
    assert.ok(lines.some((l) => l.includes('もう無い shims') && l.includes('/nowhere/dev/conductor/shims')), lines.join('\n'));
    const after = readFileSync(envFile, 'utf8');
    assert.equal(after.includes('/nowhere/dev/conductor/shims'), false, '死んだ行は消える');
    assert.ok(after.includes(keep), '他の行は残る');
    assert.ok(after.includes(pathExportLine(fileURLToPath(new URL('../../', import.meta.url)))), 'いまの shims の行は足される');
  });

  it('版が上がって置き場が変わっても、行が積み上がらない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchyard-env-'));
    const envFile = join(dir, 'env.sh');
    // 消えた古い版の置き場を 3 世代ぶん
    writeFileSync(envFile, ['0.1.0', '0.2.0', '0.3.0'].map((v) => `export PATH='/gone/cache/switchyard/${v}/shims':"$PATH"`).join('\n') + '\n');
    await sessionStart({}, { fetchLatest: noUpdate,
      env: { CLAUDE_ENV_FILE: envFile, SWITCHYARD_HOME: dir },
      connect: () => Promise.reject(new DaemonUnavailableError('居ない')),
    });
    const shimLines = readFileSync(envFile, 'utf8').split('\n').filter((l) => l.includes('/shims'));
    assert.equal(shimLines.length, 1, `shims の行は 1 本だけ残る: ${shimLines.join(' | ')}`);
  });

  it('生きている行だけなら知らせない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'switchyard-env-'));
    const envFile = join(dir, 'env.sh');
    writeFileSync(envFile, `${pathExportLine(fileURLToPath(new URL('../../', import.meta.url)))}\n`);
    const lines = await sessionStart({}, { fetchLatest: noUpdate,
      env: { CLAUDE_ENV_FILE: envFile, SWITCHYARD_HOME: dir },
      connect: () => Promise.reject(new DaemonUnavailableError('居ない')),
    });
    assert.equal(lines.some((l) => l.includes('もう無い shims')), false, lines.join('\n'));
  });
});

describe('SessionStart(設計 §9.2)', () => {
  it('shims を PATH の先頭へ足す行を CLAUDE_ENV_FILE に 1 度だけ書き、知らせることが無ければ何も返さない', async () => {
    const { home } = await daemon();
    const file = envFileIn();
    const env = { SWITCHYARD_HOME: home, CLAUDE_ENV_FILE: file };
    assert.deepEqual(await sessionStart({ source: 'startup' }, { fetchLatest: noUpdate, env, connect: noAutoStart, root: '/p/r' }), []);
    assert.deepEqual(await sessionStart({ source: 'compact' }, { fetchLatest: noUpdate, env, connect: noAutoStart, root: '/p/r' }), []);
    assert.equal(readFileSync(file, 'utf8'), `export PATH='/p/r/shims':"$PATH"\n`);
    assert.equal(pathAfterSourcing(file), '/p/r/shims:/usr/bin:/bin');
  });

  it('パスに単一引用符があっても、PATH の書き方が壊れない', () => {
    const file = envFileIn();
    execFileSync('/bin/sh', ['-c', `cat > "${file}"`], { input: `${pathExportLine("/a'b")}\n` });
    assert.equal(pathAfterSourcing(file), "/a'b/shims:/usr/bin:/bin");
  });

  it('CLAUDE_ENV_FILE が無ければ、管理されないことを 1 行で知らせる', async () => {
    const { home } = await daemon();
    const lines = await sessionStart({}, { fetchLatest: noUpdate, env: { SWITCHYARD_HOME: home }, connect: noAutoStart });
    assert.ok(lines.some((l) => l.includes('CLAUDE_ENV_FILE が無い')), lines.join('\n'));
  });

  it('計測が走っていれば、重い走行が待ちになることを知らせる', async () => {
    const { d, home } = await daemon();
    const c = await openClient(d.sock);
    cleanups.push(() => c.close());
    c.send({ t: 'request', job: jobRequest({ class: 'measure', cmd: 'npm run bench' }) });
    await c.next((m) => m.t === 'grant');
    const lines = await sessionStart({}, { fetchLatest: noUpdate, env: { SWITCHYARD_HOME: home, CLAUDE_ENV_FILE: envFileIn() }, connect: noAutoStart });
    assert.ok(lines.some((l) => l.includes('計測') && l.includes('npm run bench')), lines.join('\n'));
  });

  it('デーモンの版が plugin の版と違えば知らせる', async () => {
    const { home } = await daemon();
    const lines = await sessionStart({}, { fetchLatest: noUpdate, env: { SWITCHYARD_HOME: home, CLAUDE_ENV_FILE: envFileIn() }, connect: noAutoStart, version: '0.0.0-other' });
    assert.ok(lines.some((l) => l.includes('plugin の版 0.0.0-other')), lines.join('\n'));
  });

  it('版を名乗らない古いデーモン(1a)には、版を「0.1.0 以前」として知らせる(undefined と出さない)', async () => {
    const home = tempHome();
    /** @type {Set<import('node:net').Socket>} */
    const sockets = new Set();
    // snapshot に version の無い 1a のデーモンの代わり
    const old = createServer((conn) => {
      sockets.add(conn);
      conn.on('close', () => sockets.delete(conn));
      conn.on('data', () => conn.write(`${JSON.stringify({ t: 'status', snapshot: { capacity: 4, used: 0, leases: [], waiting: [], unacked: {}, badRecords: 0 } })}\n`));
    });
    await new Promise((resolve) => old.listen(pathsOf(home).sock, () => resolve(undefined)));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          for (const s of sockets) s.destroy();
          old.close(() => resolve(undefined));
        }),
    );
    const lines = await sessionStart({}, { fetchLatest: noUpdate, env: { SWITCHYARD_HOME: home, CLAUDE_ENV_FILE: envFileIn() }, connect: noAutoStart, version: '0.2.0' });
    assert.ok(lines.some((l) => l.includes('版 0.1.0 以前') && l.includes('plugin の版 0.2.0')), lines.join('\n'));
    assert.ok(!lines.some((l) => l.includes('undefined')), lines.join('\n'));
  });

  it('デーモンに届かなければ、管理なしで走ることを知らせる', async () => {
    const lines = await sessionStart({}, { fetchLatest: noUpdate, env: { SWITCHYARD_HOME: tempHome(), CLAUDE_ENV_FILE: envFileIn() }, connect: unavailable });
    assert.ok(lines.some((l) => l.includes('デーモンに届かない')), lines.join('\n'));
  });

  it('SWITCHYARD_THINKER=1 なら何もしない(ファイルにも書かない)', async () => {
    const file = envFileIn();
    assert.deepEqual(await sessionStart({}, { fetchLatest: noUpdate, env: { SWITCHYARD_THINKER: '1', CLAUDE_ENV_FILE: file }, connect: unavailable }), []);
    assert.equal(existsSync(file), false);
  });
});

describe('Stop(設計 §9.2)', () => {
  it('既定: 差し戻さず、まだ知らせていない失敗だけを人に知らせる(systemMessage)。同じジョブは 2 度知らせない', async () => {
    const { d, home } = await daemon();
    const jobId = await failedJob(d.sock);
    const call = () => stop({ session_id: 'sessStop-1234', stop_hook_active: false }, { env: { SWITCHYARD_HOME: home }, connect: noAutoStart });
    const out = /** @type {any} */ (await call());
    assert.equal(out.decision, undefined);
    assert.ok(out.systemMessage.includes(`${jobId} 失敗(終了コード 1): npm test`), out.systemMessage);
    assert.ok(out.systemMessage.includes('SWITCHYARD_STOP=block'), out.systemMessage);
    assert.equal(await call(), null, '2 度目のターンの終わりには出さない');
    const other = /** @type {any} */ (await stop({ session_id: 'sessStop-1234' }, { env: { SWITCHYARD_HOME: home, SWITCHYARD_OFF: '1' }, connect: noAutoStart }));
    assert.equal(other, null, 'SWITCHYARD_OFF=1 なら何もしない');
  });

  it('SWITCHYARD_STOP=block なら、ack されていない失敗があれば decision: block で差し戻す', async () => {
    const { d, home } = await daemon();
    const jobId = await failedJob(d.sock);
    const out = /** @type {any} */ (await stop({ session_id: 'sessStop-1234', stop_hook_active: false }, { env: { SWITCHYARD_HOME: home, SWITCHYARD_STOP: 'block' }, connect: noAutoStart }));
    assert.equal(out.decision, 'block');
    assert.ok(out.reason.includes(`${jobId} 失敗(終了コード 1): npm test`), out.reason);
    assert.ok(out.reason.includes('switchyard ack <job>'), out.reason);
  });

  it('stop_hook_active が true なら差し戻さない(2 度目の停止は通す)', async () => {
    const { d, home } = await daemon();
    await failedJob(d.sock);
    assert.equal(await stop({ session_id: 'sessStop-1234', stop_hook_active: true }, { env: { SWITCHYARD_HOME: home, SWITCHYARD_STOP: 'block' }, connect: noAutoStart }), null);
  });

  it('他のセッションの失敗では差し戻さない', async () => {
    const { d, home } = await daemon();
    await failedJob(d.sock);
    assert.equal(await stop({ session_id: 'otherSes-1234', stop_hook_active: false }, { env: { SWITCHYARD_HOME: home }, connect: noAutoStart }), null);
  });

  it('デーモンに届かなければ通す', async () => {
    assert.equal(await stop({ session_id: 'sessStop-1234' }, { env: { SWITCHYARD_HOME: tempHome() }, connect: unavailable }), null);
  });
});

describe('hook の入口', () => {
  it('pre-tool-use は判定の JSON を書き、判定が無ければ何も書かない', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    /** @type {string[]} */
    const written = [];
    // 記録の置き場所は一時のものを渡す(渡さないと実際の ~/.switchyard/hooks.jsonl へ書く)
    const opts = { write: (/** @type {string} */ s) => written.push(s), env: { SWITCHYARD_HOME: tempHome(), SWITCHYARD_BACKGROUND: 'always' } };
    await runHook('pre-tool-use', JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command: 'npm install' } }), opts);
    // deepEqual(written, []) だと型が空の配列に絞られ、次の push が型検査で通らない
    assert.equal(written.length, 0);
    await runHook('pre-tool-use', JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command: 'npm test' } }), opts);
    assert.equal(JSON.parse(written[0]).hookSpecificOutput.updatedInput.run_in_background, true);
  });

  it('bin/switchyard-hook.mjs は知らない hook で 1 行出して、止めない失敗(終了コード 1)で終わる', async () => {
    /** @type {{ code: unknown, stderr: string }} */
    const r = await new Promise((resolve) => {
      const child = execFile(process.execPath, [HOOK_BIN, 'nope'], (err, _stdout, stderr) => resolve({ code: err === null ? 0 : err.code, stderr }));
      child.stdin?.end('{}');
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /知らない hook: nope/);
  });
});
