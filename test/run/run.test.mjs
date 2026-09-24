// @ts-check
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageError } from '../../src/cli/args.mjs';
import { connectDaemon, DaemonUnavailableError } from '../../src/client/connect.mjs';
import { pathsOf } from '../../src/daemon/paths.mjs';
import { startDaemon } from '../../src/daemon/server.mjs';
import { buildRequest, runJob } from '../../src/run/run.mjs';
import { killGroupLeftovers, pidsInGroup } from '../../testkit/procs.mjs';
import { tempHome } from '../../testkit/tmp.mjs';
import { waitFor } from '../../testkit/wait.mjs';

/** @type {Array<() => Promise<unknown>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

/** @param {Partial<import('../../src/daemon/server.mjs').DaemonOptions>} [over] */
async function daemon(over = {}) {
  const home = over.home ?? tempHome();
  const d = await startDaemon({ capacity: 4, tickMs: 20, ...over, home });
  cleanups.push(() => d.close());
  return { d, home };
}

/** 自動起動しない接続(テストのデーモンと取り合わないように) @type {typeof connectDaemon} */
const noAutoStart = (o) => connectDaemon({ ...o, autoStart: false });

/** @param {Record<string, unknown>} profiles */
function project(profiles) {
  const dir = mkdtempSync(join(tmpdir(), 'cproj-'));
  writeFileSync(join(dir, 'switchyard.json'), JSON.stringify({ profiles }));
  return dir;
}

const node = process.execPath;

/**
 * そのプロセスグループの子が停止(状態 T)しているか。
 * `ps -g` は土台で意味が違う(macOS はプロセスグループ、Linux の procps は実効グループ名)ので使わない。
 * 全部を出して pgid で絞る形にする。
 * @param {number} pgid
 */
function stopped(pgid) {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' });
    const states = out
      .trim()
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((w) => Number(w[0]) === pgid)
      .map((w) => w[1] ?? '');
    return states.length > 0 && states.every((st) => st.startsWith('T'));
  } catch {
    return false;
  }
}

describe('buildRequest', () => {
  it('--profile の性格を使い、引数で上書きし、鍵は足し合わせる', () => {
    const cwd = project({ x: { match: ['never'], class: 'measure', cpus: { min: 2, max: 3 }, locks: ['a'], preempt: 'never' } });
    const r = buildRequest({ argv: ['echo', 'hi'], flags: { profile: 'x', locks: ['b', 'a'], why: '目的' }, env: { CLAUDE_CODE_SESSION_ID: 'abcdefghij' }, cwd });
    assert.deepEqual(r.job, { session: 'abcdefgh', repo: cwd, profile: 'x', cmd: 'echo hi', class: 'measure', cpus: { min: 2, max: 3 }, locks: ['a', 'b'], preempt: 'never', why: '目的' });
  });

  it('git の worktree では、学習の鍵として本体の根を family に載せる(本体では載せない)', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cfam-')));
    const main = join(base, 'app');
    const git = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: main, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    execFileSync('mkdir', ['-p', main]);
    git(['init', '-q']);
    writeFileSync(join(main, 'a'), 'a');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'x']);
    git(['worktree', 'add', '-q', join(base, 'app-wt'), '-b', 'wt']);
    const wt = buildRequest({ argv: ['npm', 'test'], flags: {}, env: {}, cwd: join(base, 'app-wt') });
    assert.deepEqual([wt.job.repo, wt.job.family], [join(base, 'app-wt'), main]);
    assert.equal(buildRequest({ argv: ['npm', 'test'], flags: {}, env: {}, cwd: main }).job.family, undefined);
  });

  it('どれにも当たらなければ batch・CPU 1・profile 名はコマンドの頭 2 語', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const r = buildRequest({ argv: ['git', 'status', '-s'], flags: {}, env: {}, cwd });
    assert.deepEqual([r.job.class, r.job.cpus, r.job.profile, r.profile], ['batch', { min: 1, max: 1 }, 'cmd:git status', null]);
  });

  it('--cpus 0..0 に鍵が 1 本も無ければ(profile の鍵を足しても)使い方の誤りとして投げる。入れ子で祖先の鍵を外して空になるのは誤りではない', () => {
    const cwd = project({ nolock: { match: ['never'], class: 'quick' }, locked: { match: ['never'], class: 'quick', locks: ['p'] } });
    const zero = { min: 0, max: 0 };
    assert.throws(() => buildRequest({ argv: ['x'], flags: { cpus: zero, profile: 'nolock' }, env: {}, cwd }), (e) => e instanceof UsageError && /鍵が 1 本以上要る/.test(e.message));
    assert.deepEqual(buildRequest({ argv: ['x'], flags: { cpus: zero, profile: 'locked' }, env: {}, cwd }).job.locks, ['p']);
    assert.deepEqual(buildRequest({ argv: ['x'], flags: { cpus: zero, profile: 'locked' }, env: { SWITCHYARD_HELD_LOCKS: 'p' }, cwd }).job.locks, []);
  });

  it('無い profile を指定したら投げる', () => {
    assert.throws(() => buildRequest({ argv: ['x'], flags: { profile: 'nope' }, env: {}, cwd: mkdtempSync(join(tmpdir(), 'cproj-')) }), /profile nope が見つからない/);
  });
});

describe('runJob', () => {
  it('割り振られた CPU を雛形で子へ渡し、子の終了コードを返す', async () => {
    const { d, home } = await daemon();
    const cwd = project({ x: { match: ['never'], class: 'batch', cpus: { min: 2, max: 3 }, env: { N: '{cpus}' } } });
    /** @type {string[]} */
    const lines = [];
    const code = await runJob({
      argv: [node, '-e', 'process.exit(Number(process.env.N) * 10 + Number(process.env.SWITCHYARD_CPUS))'],
      flags: { profile: 'x' },
      home,
      cwd,
      out: (l) => lines.push(l),
      connect: noAutoStart,
    });
    assert.equal(code, 33);
    assert.equal(d.getState().leases.length, 0);
    assert.ok(lines.some((l) => l.includes('CPU 3')), lines.join('\n'));
    const history = readFileSync(pathsOf(home).events, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'history');
    assert.deepEqual(history.map((h) => [h.profile, h.code]), [['x', 33]]);
  });

  it('preempt: pause を宣言したジョブは、計測が先頭に立つと本当に止まり、計測の後で動き出す(設計 §6.7)', async () => {
    const { d, home } = await daemon();
    const cwd = project({
      long: { match: ['never'], class: 'batch', cpus: { min: 1, max: 1 }, preempt: 'pause' },
      bench: { match: ['never'], class: 'measure', cpus: { min: 1, max: 1 } },
    });
    /** @type {string[]} */
    const lines = [];
    // 走り続ける子(SIGCONT されるまで進まないことを、経過時間ではなく状態 T で見る)
    const running = runJob({
      argv: ['sh', '-c', 'sleep 30 & wait'],
      flags: { profile: 'long' },
      home,
      cwd,
      out: (l) => lines.push(l),
      connect: noAutoStart,
    });
    // pgid は started の報告で入るので、埋まるまで待つ(埋まる前に読むと 0 になり、-0 は自分のグループを指す)
    await waitFor(() => (d.getState().leases[0]?.pgid ?? 0) > 1);
    const pgid = Number(d.getState().leases[0].pgid);

    // 計測を投げると、走行中の pause 宣言のジョブが止まり、計測はその場で入場する
    const measure = runJob({ argv: [node, '-e', ''], flags: { profile: 'bench' }, home, cwd, out: () => {}, connect: noAutoStart });
    await waitFor(() => d.getState().leases.some((l) => l.held === 'pause'));
    await waitFor(() => stopped(pgid), 3_000);
    assert.equal(stopped(pgid), true, '子のプロセスグループが T(停止)になっている');
    assert.ok(lines.some((l) => l.includes('SIGSTOP')), lines.join('\n'));

    assert.equal(await measure, 0);
    // 計測が終われば戻る
    await waitFor(() => !stopped(pgid), 3_000);
    assert.ok(lines.some((l) => l.includes('走行に戻る')), lines.join('\n'));
    process.kill(-pgid, 'SIGKILL');
    await running;
  });

  it('preempt: never(既定)のジョブは止められない', async () => {
    const { d, home } = await daemon();
    const cwd = project({
      long: { match: ['never'], class: 'batch', cpus: { min: 1, max: 1 } },
      bench: { match: ['never'], class: 'measure', cpus: { min: 1, max: 1 } },
    });
    const running = runJob({ argv: ['sh', '-c', 'sleep 30 & wait'], flags: { profile: 'long' }, home, cwd, out: () => {}, connect: noAutoStart });
    await waitFor(() => (d.getState().leases[0]?.pgid ?? 0) > 1);
    const pgid = Number(d.getState().leases[0].pgid);
    const measure = runJob({ argv: [node, '-e', ''], flags: { profile: 'bench' }, home, cwd, out: () => {}, connect: noAutoStart });
    await waitFor(() => d.getState().waiting.length === 1);
    assert.equal(d.getState().leases.some((l) => l.held !== undefined), false, '止めない');
    assert.equal(stopped(pgid), false);
    process.kill(-pgid, 'SIGKILL');
    await running;
    assert.equal(await measure, 0, '相手が終われば計測は入場する');
  });

  it('同じ鍵を持つ 2 本は、重ならずに順に走る', async () => {
    const { home } = await daemon();
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const log = join(cwd, 'spans.txt');
    const script = (/** @type {string} */ name) =>
      `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)}, '${name} start '+Date.now()+'\\n');setTimeout(()=>{fs.appendFileSync(${JSON.stringify(log)}, '${name} end '+Date.now()+'\\n')},200)`;
    const run = (/** @type {string} */ name) => runJob({ argv: [node, '-e', script(name)], flags: { locks: ['L'] }, home, cwd, out: () => {}, connect: noAutoStart });
    const codes = await Promise.all([run('a'), run('b')]);
    assert.deepEqual(codes, [0, 0]);
    /** @type {Record<string, number>} */
    const t = {};
    for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
      const [name, what, at] = line.split(' ');
      t[`${name}.${what}`] = Number(at);
    }
    const [first, second] = t['a.start'] < t['b.start'] ? ['a', 'b'] : ['b', 'a'];
    assert.ok(t[`${second}.start`] >= t[`${first}.end`], JSON.stringify(t));
  });

  it('待っている間に SIGTERM を受けたら、待つのをやめて 143 を返し、待ち列から消える', async () => {
    const { d, home } = await daemon({ capacity: 1 });
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const blocker = runJob({ argv: [node, '-e', 'setTimeout(()=>{}, 1500)'], flags: {}, home, cwd, out: () => {}, connect: noAutoStart });
    await waitFor(() => d.getState().leases.length === 1);
    const signals = new EventEmitter();
    const waiting = runJob({ argv: [node, '-e', ''], flags: {}, home, cwd, out: () => {}, connect: noAutoStart, signals });
    await waitFor(() => d.getState().waiting.length === 1);
    signals.emit('SIGTERM');
    assert.equal(await waiting, 143);
    await waitFor(() => d.getState().waiting.length === 0);
    assert.equal(await blocker, 0);
  });

  it('走行中に SIGTERM を受けたら子のグループへ転送し、killed として記録する', async () => {
    const { d, home } = await daemon();
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    const signals = new EventEmitter();
    const running = runJob({
      argv: ['sh', '-c', 'sleep 30 & wait'],
      flags: {},
      home,
      cwd,
      out: () => {},
      connect: noAutoStart,
      signals,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'sessKill1' },
    });
    await waitFor(() => d.getState().leases[0]?.phase === 'running');
    signals.emit('SIGTERM');
    assert.equal(await running, 143);
    await waitFor(() => (d.getState().unacked.sessKill ?? []).length === 1);
    assert.equal(d.getState().unacked.sessKill[0].kind, 'killed');
  });

  it('SIGTERM の後に生まれた子も、グループごと終わらせてから終了を返す', async () => {
    const { d, home } = await daemon();
    const signals = new EventEmitter();
    const running = runJob({
      argv: ['sh', '-c', 'trap "sleep 30 & exit 0" TERM; sleep 30 & wait'],
      flags: {},
      home,
      cwd: mkdtempSync(join(tmpdir(), 'cproj-')),
      out: () => {},
      connect: noAutoStart,
      signals,
      killGraceMs: 500,
    });
    await waitFor(() => d.getState().leases[0]?.phase === 'running');
    const pgid = /** @type {number} */ (d.getState().leases[0].pgid);
    try {
      await waitFor(() => pidsInGroup(pgid).length >= 2);
      signals.emit('SIGTERM');
      await running;
      assert.deepEqual(pidsInGroup(pgid), []);
    } finally {
      killGroupLeftovers(pgid);
    }
  });

  it('実行中にプロセスグループから抜けた子を検出し、表示してデーモンに記録させる', async () => {
    const { home } = await daemon();
    /** @type {string[]} */
    const lines = [];
    const code = await runJob({
      // 抜けるのを 0.3 秒遅らせる。起動直後の 1 回の観察では捕まらず、走行中の観察でしか捕まらない入力にする
      // (perl の sleep は整数の秒だけを受け付ける。0.5 は 0 になって即座に終わる)
      argv: ['sh', '-c', 'sleep 0.3; perl -e "use POSIX; POSIX::setsid(); sleep 1" & wait'],
      flags: {},
      home,
      cwd: mkdtempSync(join(tmpdir(), 'cproj-')),
      out: (l) => lines.push(l),
      connect: noAutoStart,
      watchMs: 50,
    });
    assert.equal(code, 0);
    assert.ok(lines.includes('[switchyard] プロセスグループから抜けた子: perl ×1(信号と使用率の照合が届かない)'), lines.join('\n'));
    await waitFor(() => readFileSync(pathsOf(home).events, 'utf8').includes('"kind":"escape"'));
  });

  it('普通に終わった後もグループに残る子を、終了後も生きている子として表示する', async () => {
    const { d, home } = await daemon();
    /** @type {string[]} */
    const lines = [];
    let pgid = 0;
    const running = runJob({
      argv: ['sh', '-c', 'sleep 30 & sleep 0.3'],
      flags: {},
      home,
      cwd: mkdtempSync(join(tmpdir(), 'cproj-')),
      out: (l) => lines.push(l),
      connect: noAutoStart,
      watchMs: 50,
    });
    await waitFor(() => d.getState().leases[0]?.phase === 'running');
    pgid = /** @type {number} */ (d.getState().leases[0].pgid);
    try {
      assert.equal(await running, 0);
      assert.ok(lines.some((l) => /^\[switchyard\] 終了後も生きている子: sleep\(pid \d+・グループ内\)$/.test(l)), lines.join('\n'));
    } finally {
      killGroupLeftovers(pgid);
    }
  });

  it('信号を短時間に 2 回受けても、SIGKILL までの猶予は最初の転送から測る(R5)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cproj-'));
    const script = join(dir, 'repeat-signal-timing.mjs');
    const root = new URL('../../', import.meta.url);
    const at = (/** @type {string} */ rel) => JSON.stringify(new URL(rel, root).href);
    writeFileSync(
      script,
      [
        `import { runJob } from ${at('src/run/run.mjs')};`,
        `import { DaemonUnavailableError } from ${at('src/client/connect.mjs')};`,
        "import { EventEmitter } from 'node:events';",
        "import { mkdtempSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        "const signals = new EventEmitter();",
        // デーモンは要らない(pgid を確かめられる経路の onSignal だけを見たい)。すぐ管理なしへ落ちる
        "const connect = async () => { throw new DaemonUnavailableError('R5 テスト'); };",
        "const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));",
        // 子は SIGTERM を捕まえて 300ms 後に終わる(猶予 3000ms より十分短い)
        "const p = runJob({ argv: ['sh', '-c', 'trap \"sleep 0.3; exit 0\" TERM; sleep 30 & wait'], flags: {}, home: cwd, cwd, out: () => {}, connect, signals, killGraceMs: 3000 });",
        // 測るのは「最初の転送から終わるまで」。node の起動時間を混ぜると、機械が混んだだけで破れる
        "let firstAt = 0;",
        "setTimeout(() => { firstAt = Date.now(); signals.emit('SIGTERM'); }, 150);",
        "setTimeout(() => signals.emit('SIGTERM'), 200);", // 50ms space
        "const code = await p;",
        "console.log('code=' + code + ' ms=' + (Date.now() - firstAt));",
      ].join('\n'),
    );
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, [script], { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    assert.match(String(out), /code=0/);
    const ms = Number(/ms=(\d+)/.exec(String(out))?.[1] ?? NaN);
    // 子は SIGTERM を捕まえて 300ms で終わる。猶予が 2 度目の信号で始まり直していれば 3000ms 近くになる
    assert.ok(ms < 1_500, `最初の転送から ${ms}ms かかった(killGraceMs 3000ms に引きずられている): ${out}`);
  });

  it('再接続を待っている間に子が終わったら、待ちのタイマーでプロセスの終了を遅らせない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cproj-'));
    const script = join(dir, 'exit-timing.mjs');
    const root = new URL('../../', import.meta.url);
    const at = (/** @type {string} */ rel) => JSON.stringify(new URL(rel, root).href);
    writeFileSync(
      script,
      [
        `import { startDaemon } from ${at('src/daemon/server.mjs')};`,
        `import { connectDaemon } from ${at('src/client/connect.mjs')};`,
        `import { runJob } from ${at('src/run/run.mjs')};`,
        "import { mkdtempSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        "const home = mkdtempSync(join(tmpdir(), 'cd-'));",
        'const d = await startDaemon({ home, capacity: 2, tickMs: 20 });',
        "const p = runJob({ argv: [process.execPath, '-e', 'setTimeout(() => {}, 300)'], flags: {}, home, cwd: home, out: () => {}, connect: (o) => connectDaemon({ ...o, autoStart: false }), reconnectMs: 4000 });",
        "while (d.getState().leases[0]?.phase !== 'running') await new Promise((r) => setTimeout(r, 10));",
        'await d.close();',
        "console.log('code=' + (await p));",
      ].join('\n'),
    );
    const started = Date.now();
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, [script], { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const elapsed = Date.now() - started;
    assert.match(String(out), /code=0/);
    assert.ok(elapsed < 3_000, `プロセスの終了までに ${elapsed}ms かかった(再接続の待ち 4000ms に引きずられている)`);
  });

  it('接続を待つ間に SIGTERM を受けて終わったら、子を起動せず、管理なしの表示も出さない(C2・catch の経路)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cproj-'));
    const marker = join(dir, 'ran.marker');
    const markerScript = join(dir, 'write-marker.mjs');
    writeFileSync(markerScript, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '');\n`);
    const signals = new EventEmitter();
    /** @type {typeof connectDaemon} */
    const slowFail = () => new Promise((_resolve, reject) => setTimeout(() => reject(new DaemonUnavailableError('テスト')), 200));
    /** @type {string[]} */
    const lines = [];
    setTimeout(() => signals.emit('SIGTERM'), 50);
    const code = await runJob({ argv: [node, markerScript], flags: {}, home: tempHome(), cwd: dir, out: (l) => lines.push(l), connect: slowFail, signals });
    assert.equal(code, 143);
    // catch が届くのは接続の 200ms 後。そこから十分待っても、子が起動せず「管理なしで実行する」の表示も出ないことを確かめる
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(existsSync(marker), false, '止めたはずのジョブが子を起動した');
    assert.ok(!lines.some((l) => l.includes('管理なしで実行する')), lines.join('\n'));
  });

  it('接続がつながった直後に SIGTERM で終わっていたら、子を起動せず、包みのプロセスも残らない(C2・then の経路)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cproj-'));
    const marker = join(dir, 'ran.marker');
    const markerScript = join(dir, 'write-marker.mjs');
    writeFileSync(markerScript, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '');\n`);
    const driver = join(dir, 'signal-then-timing.mjs');
    const root = new URL('../../', import.meta.url);
    const at = (/** @type {string} */ rel) => JSON.stringify(new URL(rel, root).href);
    writeFileSync(
      driver,
      [
        `import { startDaemon } from ${at('src/daemon/server.mjs')};`,
        `import { connectDaemon } from ${at('src/client/connect.mjs')};`,
        `import { runJob } from ${at('src/run/run.mjs')};`,
        "import { EventEmitter } from 'node:events';",
        "import { mkdtempSync } from 'node:fs';",
        "import { tmpdir } from 'node:os';",
        "import { join } from 'node:path';",
        "const home = mkdtempSync(join(tmpdir(), 'cd-'));",
        'const d = await startDaemon({ home, capacity: 2, tickMs: 20 });',
        'const signals = new EventEmitter();',
        // 本物の接続はすぐ成立するが、runJob へ渡す解決は 200ms 遅らせる(SIGTERM が先に届く窓を作る)
        'const delayed = (o) => new Promise((resolve, reject) => {',
        '  connectDaemon({ ...o, autoStart: false }).then((c) => setTimeout(() => resolve(c), 200), (e) => setTimeout(() => reject(e), 200));',
        '});',
        "setTimeout(() => signals.emit('SIGTERM'), 50);",
        `const p = runJob({ argv: [process.execPath, ${JSON.stringify(markerScript)}], flags: {}, home, cwd: home, out: () => {}, connect: delayed, signals });`,
        "console.log('code=' + (await p));",
        // 接続の解決(200ms 遅れ)が確実に届いた後まで待つ。届いた分の request がデーモンへ向かっていれば、waiting/leases に残っているはず
        'await new Promise((r) => setTimeout(r, 400));',
        "console.log('state=' + JSON.stringify([d.getState().leases.length, d.getState().waiting.length]));",
        'await d.close();',
      ].join('\n'),
    );
    const started = Date.now();
    const out = await new Promise((resolve, reject) => {
      execFile(process.execPath, [driver], { timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const elapsed = Date.now() - started;
    assert.match(String(out), /code=143/);
    assert.ok(elapsed < 3_000, `スクリプトの終了までに ${elapsed}ms かかった(${out})`);
    assert.equal(existsSync(marker), false, '止めたはずのジョブが子を起動した');
    // 既に終わったジョブの request が、遅れて届いた接続からデーモンへ紛れ込んでいないこと
    assert.match(String(out), /state=\[0,0\]/, String(out));
  });

  it('デーモンに届かなければ、管理なしで実行し、そう表示する', async () => {
    /** @type {string[]} */
    const lines = [];
    const code = await runJob({
      argv: [node, '-e', 'process.exit(Number(process.env.SWITCHYARD_CPUS))'],
      flags: { cpus: { min: 2, max: 6 } },
      home: tempHome(),
      cwd: mkdtempSync(join(tmpdir(), 'cproj-')),
      out: (l) => lines.push(l),
      connect: async () => {
        throw new DaemonUnavailableError('テスト');
      },
    });
    assert.equal(code, 2);
    assert.ok(lines.some((l) => l.includes('管理なしで実行する')), lines.join('\n'));
  });

  it('走行中にデーモンが入れ替わっても子は走り続け、resume でリースを取り戻す', async () => {
    const home = tempHome();
    const first = await startDaemon({ home, capacity: 4, tickMs: 20 });
    const cwd = mkdtempSync(join(tmpdir(), 'cproj-'));
    /** @type {string[]} */
    const lines = [];
    const running = runJob({ argv: [node, '-e', 'setTimeout(()=>{}, 1200)'], flags: {}, home, cwd, out: (l) => lines.push(l), connect: noAutoStart, reconnectMs: 50 });
    await waitFor(() => first.getState().leases[0]?.phase === 'running');
    const id = first.getState().leases[0].job.id;
    await first.close();
    const { d: second } = await daemon({ home });
    await waitFor(() => second.getState().leases.some((l) => l.job.id === id && !l.recovering), 3_000);
    assert.equal(await running, 0);
    await waitFor(() => second.getState().leases.length === 0);
    assert.ok(lines.some((l) => l.includes('つなぎ直した')), lines.join('\n'));
  });

  it('入れ替わったデーモンがジョブを知らなければ、管理なしで走り続ける', async () => {
    const home = tempHome();
    const first = await startDaemon({ home, capacity: 4, tickMs: 20 });
    /** @type {string[]} */
    const lines = [];
    const running = runJob({ argv: [node, '-e', 'setTimeout(()=>{}, 800)'], flags: {}, home, cwd: mkdtempSync(join(tmpdir(), 'cproj-')), out: (l) => lines.push(l), connect: noAutoStart, reconnectMs: 50 });
    await waitFor(() => first.getState().leases[0]?.phase === 'running');
    await first.close();
    rmSync(pathsOf(home).state);
    await daemon({ home });
    assert.equal(await running, 0);
    assert.ok(lines.some((l) => l.includes('管理なしで走り続ける')), lines.join('\n'));
  });
});
