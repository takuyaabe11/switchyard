# verifiedGroup の拒否枝の門番の検出力(switchyard 1a・最終レビュー I3)

- 実行: `npm run mutate:group`(原本は触らず、一時ディレクトリの写しに 1 つずつ入れる)
- 日時と環境: Tue Sep 15 15:11:15 JST 2026 / Darwin 25.6.0 / Node v24.16.0(再レビューの残りの修正で再実行。group.mjs 自体は今回変更していない)
- 復元後の原本: `npm test` の `ℹ tests` / `ℹ pass` / `ℹ fail` の 3 行を貼る

```
ℹ tests 173
ℹ pass 173
ℹ fail 0
```

## 変異ごとの結果

```
== G1 孫(子の pgid ≠ 子の pid)の拒否を外す | src/run/group.mjs | 赤 | tests 8 / fail 1 / pass 7
   壊した行: if (pgid === ownPgid) return null;
   赤: 孫の pid(自分のグループの長でない)を渡すと拒む(I3)
== G2 自分のグループと同じ pgid の拒否を外す | src/run/group.mjs | 赤 | tests 8 / fail 1 / pass 7
   壊した行: if (pgid !== childPid) return null;
   赤: 子の pgid が自分の pgid と同じなら拒む(I3)
全部の変異が赤になった
```

## 背景

最終レビュー I3 は、`verifiedGroup` の拒否する 2 つの枝(子の pgid ≠ 子の pid / 子の pgid = 自分の pgid)を通るテストが無く、`scripts/mutate.mjs` にも対応する変異が無いと指摘した。§12 の事故(`setsid ... &` の子が呼び出し元の pgid に残り、呼び出し元のシェルを止めた)を起動時に弾く守りそのものなので、`test/run/group.test.mjs` に 2 本足した(`verifiedGroup(pid, pid)` → null / `sh -c 'sleep 5 & wait'` の孫の pid → null)。この 2 本は、直し前の `src/run/group.mjs` を一切変更せずに追加しただけで既に緑だった(元のコードの拒否ロジック自体は正しく実装済みで、テストが無かっただけ)。そのため「テストを足しただけで検出力の証明が無い」形にならないよう、この記録とは別に、足した各テストを個別に(手で 1 行ずつ壊して)赤くなることを確認した上で、`scripts/mutate.mjs` に `group` 組(G1・G2)を機械的な検出力の記録として追加した。

## 手での確認(1 行ずつ壊す。コミットはしていない)

- `if (pgid !== childPid || pgid === ownPgid) return null;` を `if (pgid === ownPgid) return null;` に変更(childPid の照合を外す)→「孫の pid(自分のグループの長でない)を渡すと拒む(I3)」が `AssertionError: 61355 !== null` で赤 → 復元後に緑を確認。
- 同じ行を `if (pgid !== childPid) return null;` に変更(ownPgid の照合を外す)→「子の pgid が自分の pgid と同じなら拒む(I3)」が `AssertionError: 61422 !== null` で赤 → 復元後に緑を確認。

## 実行した環境

```
$ uname -sr
Darwin 25.6.0
$ node --version
v24.16.0
```
