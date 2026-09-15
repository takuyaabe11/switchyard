// @ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { simpleCommands } from '../../src/hooks/shell.mjs';

describe('simpleCommands(PreToolUse のためのコマンドの分け方。設計 §9.2)', () => {
  it('&& || ; | & と改行で単純コマンドに分け、語の引用符を外す', () => {
    assert.deepEqual(simpleCommands(`a b && c 'd e' || f "g h"; i | j & k\nl`), [['a', 'b'], ['c', 'd e'], ['f', 'g h'], ['i'], ['j'], ['k'], ['l']]);
  });

  it('引用符の中の区切りと空白は語の一部', () => {
    assert.deepEqual(simpleCommands(`echo "a; b" 'c && d'`), [['echo', 'a; b', 'c && d']]);
  });

  it('( … )・$( … )・逆引用符の中を、別の単純コマンドとして取り出す', () => {
    assert.deepEqual(simpleCommands('(npm test)'), [['npm', 'test']]);
    assert.deepEqual(simpleCommands('echo "x $(npm test) y"'), [['npm', 'test'], ['echo', 'x  y']]);
    assert.deepEqual(simpleCommands('echo `make all`'), [['make', 'all'], ['echo', '']]);
    assert.deepEqual(simpleCommands('a $(b $(c)) d'), [['c'], ['b', ''], ['a', '', 'd']]);
  });

  it('heredoc の本文は語にせず、中の区切りも見ない(引用した区切り語・<<- も)', () => {
    const commit = `git commit -m "$(cat <<'EOF'\nfix: a; bench\n\nnpm test\nEOF\n)"`;
    assert.deepEqual(simpleCommands(commit), [['cat'], ['git', 'commit', '-m', '']]);
    assert.deepEqual(simpleCommands('cat <<-END > f\n\tnpm test\n\tEND\nmake'), [['cat'], ['make']]);
    assert.deepEqual(simpleCommands('cat <<EOF\nnpm test\nEOF'), [['cat']]);
  });

  it('リダイレクトとその行き先は語にしない', () => {
    assert.deepEqual(simpleCommands('npm test > out.txt 2>&1'), [['npm', 'test']]);
    assert.deepEqual(simpleCommands('node x.mjs &> log; cat < in'), [['node', 'x.mjs'], ['cat']]);
    assert.deepEqual(simpleCommands('grep x <<< "npm test"'), [['grep', 'x']]);
  });

  it('語の頭の # からはコメント。語の途中の # は語の一部', () => {
    assert.deepEqual(simpleCommands('npm test # bench\nmake'), [['npm', 'test'], ['make']]);
    assert.deepEqual(simpleCommands('echo a#b'), [['echo', 'a#b']]);
  });

  it('逆斜線は次の 1 文字を語にし、逆斜線と改行は行の継続', () => {
    assert.deepEqual(simpleCommands('echo a\\;b'), [['echo', 'a;b']]);
    assert.deepEqual(simpleCommands('npm \\\ntest'), [['npm', 'test']]);
  });

  it('閉じていない引用符や括弧でも止まらずに終わる', () => {
    assert.deepEqual(simpleCommands('echo "abc'), [['echo', 'abc']]);
    assert.deepEqual(simpleCommands('(npm test'), [['npm', 'test']]);
    assert.deepEqual(simpleCommands(''), []);
  });
});
