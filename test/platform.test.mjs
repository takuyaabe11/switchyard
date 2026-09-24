// @ts-check
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { findGitBash, fromBashPath, socketPath, toBashPath } from '../src/platform.mjs';
import { pathExportLine } from '../src/hooks/session.mjs';
import { join } from 'node:path';

describe('Windows と POSIX の違い(src/platform.mjs)', () => {
  it('Windows のパスを Git Bash の形にし、戻せる', () => {
    assert.equal(toBashPath('C:\\Users\\a b\\plugin\\shims'), '/c/Users/a b/plugin/shims');
    assert.equal(toBashPath('D:/x/y'), '/d/x/y');
    assert.equal(toBashPath('/home/a/shims'), '/home/a/shims');
    assert.equal(fromBashPath('/c/Users/a b/plugin/shims'), 'C:\\Users\\a b\\plugin\\shims');
    assert.equal(fromBashPath('/home/a'), '/home/a');
  });

  it('Windows の PATH の行は /c/… の形で書く(C:\\… のままだと : で PATH が切れる)', () => {
    assert.equal(pathExportLine('C:\\p\\switchyard', true), `export PATH='/c/p/switchyard/shims':"$PATH"`);
    assert.equal(pathExportLine('/p/switchyard', false), `export PATH='${join('/p/switchyard', 'shims')}':"$PATH"`);
  });

  it('デーモンの待ち受けは、POSIX は置き場所の socket、Windows は置き場所ごとの名前付きパイプ', () => {
    assert.match(socketPath('/home/a/.switchyard', 'linux'), /switchyardd\.sock$/);
    const a = socketPath('C:\\Users\\a\\.switchyard', 'win32');
    assert.match(a, /^\\\\\.\\pipe\\switchyardd-[0-9a-f]{16}$/);
    // 大文字小文字だけが違う置き場所は同じ(Windows のパスは大文字小文字を区別しない)。別の置き場所は別
    assert.equal(socketPath('c:\\users\\A\\.switchyard', 'win32'), a);
    assert.notEqual(socketPath('C:\\Users\\b\\.switchyard', 'win32'), a);
  });

  it('Git Bash を探す: 指定があればそれ、無ければ Program Files の Git。WSL の入口(System32\\bash.exe)は使わない', () => {
    const has = (/** @type {string[]} */ files) => (/** @type {string} */ p) => files.includes(p);
    assert.equal(findGitBash({ SWITCHYARD_BASH: 'X:\\bash.exe' }, has(['X:\\bash.exe'])), 'X:\\bash.exe');
    const pf = findGitBash({ ProgramFiles: 'C:\\Program Files' }, () => true);
    assert.ok(pf !== null && /Git[\\/]bin[\\/]bash\.exe$/.test(pf));
    assert.equal(findGitBash({ SWITCHYARD_BASH: 'C:\\Windows\\System32\\bash.exe' }, () => true), null);
    assert.equal(findGitBash({}, () => false), null);
  });
});
