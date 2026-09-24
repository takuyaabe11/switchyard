// @ts-check
// ポートが使用中で落ちた走行から、ポートの番号と、握っているプロセスを突き止める(src/hooks/ports.mjs)
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { detailOf, holdersOf, listeningInodes, parseEtime, parseLsof, parseNetstat, parseSs, PORT_IN_USE, portsFromText } from '../../src/hooks/ports.mjs';
import { PORT_IN_USE as REPLAY_PORT_IN_USE } from '../../src/replay/reruns.mjs';
import { waitFor } from '../../testkit/wait.mjs';

/** @type {Array<() => void>} */
let cleanups = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe('portsFromText(失敗の文面からポートの番号を取り出す)', () => {
  it('Node・Go・docker・Vite・Rails・Java の実際の文面から番号を取る', () => {
    assert.deepEqual(portsFromText("Error: listen EADDRINUSE: address already in use 0.0.0.0:47321\n    at Server.setupListenHandle"), [47321]);
    assert.deepEqual(portsFromText('Error: listen EADDRINUSE: address already in use :::3000'), [3000]);
    assert.deepEqual(portsFromText('listen tcp :8080: bind: address already in use'), [8080]);
    assert.deepEqual(portsFromText('Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:5432 failed: port is already allocated'), [5432]);
    assert.deepEqual(portsFromText('error when starting dev server:\nError: Port 5173 is already in use'), [5173]);
    assert.deepEqual(portsFromText('Address already in use - bind(2) for "127.0.0.1" port 3000 (Errno::EADDRINUSE)'), [3000]);
    assert.deepEqual(portsFromText('java.net.BindException: Address already in use\nWeb server failed to start. Port 8080 was already in use.'), [8080]);
    assert.deepEqual(portsFromText('listen EADDRINUSE: address already in use [::1]:4000'), [4000]);
  });

  it('文面に番号が無ければ(Python)、コマンドの --port・-p・PORT=・http.server から取る', () => {
    const py = 'OSError: [Errno 98] Address already in use';
    assert.deepEqual(portsFromText(py, 'python -m http.server 8000'), [8000]);
    assert.deepEqual(portsFromText(py, 'uvicorn app:app --port 9000'), [9000]);
    assert.deepEqual(portsFromText(py, 'flask run --port=5001'), [5001]);
    assert.deepEqual(portsFromText(py, 'PORT=4001 python serve.py'), [4001]);
    assert.deepEqual(portsFromText(py, 'python manage.py runserver'), []);
  });

  it('ポートの失敗でない行の番号(時刻・行番号・別のアドレス)は拾わない', () => {
    assert.deepEqual(portsFromText('12:34:56 connected to db at 10.0.0.1:5432\nall good'), []);
    assert.deepEqual(portsFromText('    at Server.listen (node:net:2102:7)\nError: listen EADDRINUSE: address already in use :::3000'), [3000]);
  });

  it('replay と同じ文言で、ポートの失敗を見分ける', () => {
    assert.equal(REPLAY_PORT_IN_USE, PORT_IN_USE);
  });
});

describe('握っているプロセスの読み方(道具ごとの出力)', () => {
  it('lsof -Fpc の pid と名前', () => {
    assert.deepEqual(parseLsof('p4321\ncnode\np99\ncdocker-proxy\n'), [
      { pid: 4321, name: 'node' },
      { pid: 99, name: 'docker-proxy' },
    ]);
    assert.deepEqual(parseLsof(''), []);
  });

  it('ss -ltnpH の users:(("名前",pid=…)) を、そのポートの行からだけ取る', () => {
    const out = [
      'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=123,fd=20))',
      'LISTEN 0 511 [::]:3000 [::]:* users:(("node",pid=123,fd=21))',
      'LISTEN 0 128 0.0.0.0:30000 0.0.0.0:* users:(("other",pid=9,fd=3))',
    ].join('\n');
    assert.deepEqual(parseSs(out, 3000), [{ pid: 123, name: 'node' }]);
  });

  it('/proc/net/tcp の待ち受け(st 0A)の inode を、ポートの 16 進で引く', () => {
    const table = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1114 1 0 100 0 0 10 0',
      '   1: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000     0        0 2222 1 0 100 0 0 10 0',
    ].join('\n');
    assert.deepEqual(listeningInodes(table, 3000), ['1114']);
    assert.deepEqual(listeningInodes(table, 3001), []);
  });

  it('netstat -ano(Windows)の LISTENING の pid を、そのポートからだけ取る', () => {
    const out = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4321',
      '  TCP    [::]:3000              [::]:0                 LISTENING       4321',
      '  TCP    127.0.0.1:3000         127.0.0.1:50000        ESTABLISHED     77',
      '  TCP    0.0.0.0:30000          0.0.0.0:0              LISTENING       8',
    ].join('\r\n');
    assert.deepEqual(parseNetstat(out, 3000), [4321]);
  });

  it('ps の etime を秒にする', () => {
    assert.equal(parseEtime('05:07'), 307);
    assert.equal(parseEtime('01:02:03'), 3723);
    assert.equal(parseEtime('2-01:02:03'), 2 * 86_400 + 3723);
    assert.equal(parseEtime('x'), null);
  });
});

describe('holdersOf・detailOf(実際に待ち受けているプロセスを突き止める)', () => {
  it('このテストが起こしたサーバーの pid と、そのコマンド・作業場所・走っている時間を返す', async () => {
    const child = spawn(process.execPath, ['-e', "const s=require('http').createServer().listen(0,()=>{console.log(s.address().port)}); setTimeout(()=>{}, 60000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
    cleanups.push(() => child.kill('SIGKILL'));
    let out = '';
    child.stdout?.on('data', (d) => {
      out += d;
    });
    await waitFor(() => /\d+\n/.test(out), 5_000);
    const port = Number(out.trim());
    const holders = holdersOf(port);
    assert.ok(holders.some((h) => h.pid === child.pid), `${port}: ${JSON.stringify(holders)}`);
    if (process.platform !== 'win32') {
      const d = detailOf(Number(child.pid));
      assert.match(String(d.command), /createServer/);
      assert.equal(d.cwd, process.cwd());
      assert.ok(d.elapsedSec !== null && d.elapsedSec >= 0);
    }
  });

  it('道具が無い・見つけられないときは次の道具へ進む: lsof → ss → /proc(Linux)。Windows は netstat と tasklist', () => {
    const ssOut = 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=123,fd=20))';
    /** @param {Record<string, string | null>} outs */
    const run = (outs) => (/** @type {string} */ file) => outs[file] ?? null;
    const proc = () => [{ pid: 7, name: 'from-proc' }];
    assert.deepEqual(holdersOf(3000, 'linux', { run: run({ lsof: 'p1\ncnode\n', ss: ssOut }), proc }), [{ pid: 1, name: 'node' }]);
    assert.deepEqual(holdersOf(3000, 'linux', { run: run({ lsof: '', ss: ssOut }), proc }), [{ pid: 123, name: 'node' }]);
    assert.deepEqual(holdersOf(3000, 'linux', { run: run({ ss: ssOut }), proc }), [{ pid: 123, name: 'node' }]);
    assert.deepEqual(holdersOf(3000, 'linux', { run: run({}), proc }), [{ pid: 7, name: 'from-proc' }]);
    // macOS には ss も /proc も無い
    assert.deepEqual(holdersOf(3000, 'darwin', { run: run({ ss: ssOut }), proc }), []);
    const netstat = '  TCP    [::]:3000              [::]:0                 LISTENING       4321';
    assert.deepEqual(holdersOf(3000, 'win32', { run: run({ netstat, tasklist: '"node.exe","4321","Console","1","50,000 K"' }), proc }), [{ pid: 4321, name: 'node.exe' }]);
  });

  it('誰も待ち受けていないポートは空', () => {
    assert.deepEqual(holdersOf(1), []);
  });
});
