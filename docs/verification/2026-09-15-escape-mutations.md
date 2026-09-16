# 子のプロセスグループ離脱の検出の門番の検出力(switchyard 1a)

- 実行: `npm run mutate:escape`(原本は触らず、一時ディレクトリの写しに 1 つずつ入れる)
- 日時と環境: Tue Sep 15 15:11:15 JST 2026 / Darwin 25.6.0 / Node v24.16.0(最終レビューの再レビューの残りの修正で再実行)
- 復元後の原本: `npm test` の `ℹ tests` / `ℹ pass` / `ℹ fail` の 3 行を貼る

```
ℹ tests 173
ℹ pass 173
ℹ fail 0
```

## 変異ごとの結果

```
== E1 グループの違いを見ない | src/run/watch.mjs | 赤 | tests 52 / fail 7 / pass 45
   壊した行: for (const [, v] of seen) if (v.pgid !== v.pgid) counts.set
   赤: probe はグループから抜ける子を報告する
   赤: setsid してグループから抜ける子を検出し、SIGTERM の後の生き残りとして出し、片付ける
   赤: 実行中にプロセスグループから抜けた子を検出し、表示してデーモンに記録させる
   赤: グループの違う子孫を名前ごとに数え、無関係なプロセスは数えない
   赤: 親が終わって親子関係が切れた後に抜けた子も、開始時刻が同じなら数える
   赤: 終わりかけの子を ps が (perl) のように括弧つきで出しても、同じ名前として数える
   赤: ps が失敗しても投げず、それまでに見たものを保つ
== E2 走行中に子孫を見ない | src/run/run.mjs | 赤 | tests 52 / fail 1 / pass 51
   壊した行: watchTimer = null;
   赤: 実行中にプロセスグループから抜けた子を検出し、表示してデーモンに記録させる
== E3 使い回された pid を同じ子とみなす(開始時刻を照合しない) | src/run/watch.mjs | 赤 | tests 52 / fail 1 / pass 51
   壊した行: const orphanedSame = known !== undefined;
   赤: 使い回された pid(開始時刻が違う)を、前に見た子と取り違えない(I2)
== E4 デーモンが抜けた子の名前を覚えない | src/daemon/server.mjs | 赤 | tests 52 / fail 1 / pass 51
   壊した行: (行を消した)
   赤: exit に付いた抜けた子を記録し、同じ repo と profile の後の要求に表示し、再起動しても覚えている
全部の変異が赤になった
```

## 2026-09-15(再レビューの残りの修正・R1)で分かったこと

再レビューが、I2 の差分が持ち込んだ回帰を指摘した: `processTable()` の 1 行解析が `comm` を最後の 1 語だけにしていたため、実行ファイルのパスに空白を含むと(この機械の `ps -A` 521 行のうち 65 行が該当)名前が壊れていた。直し方は (1) `execFileSync` に `LC_ALL: 'C'` を渡して `lstart` を 5 語に固定する(ja ロケールでは 4 語になり、実測で確かめた) (2) 1 行の解析を `parsePsLine`(`ProcRow | null` を返す)として切り出し、`started = parts.slice(3, 8).join(' ')` / `comm = parts.slice(8).join(' ')` にする。E1〜E4 はどれも `parsePsLine` の外側のロジック(`createEscapeTracker` の `sample`/`report`)を対象にしているので、`from` の変更は不要だった(実際、E3 の `from` はこの回で変わっていない)。テスト数が 48 → 52 に増えたのは `test/run/watch.test.mjs` に `parsePsLine` の単体テスト 3 本を足したため。

## この Task の門番について(2026-09-15 の実測で分かったこと)

「実行中にプロセスグループから抜けた子を検出し…」の入力は、抜けるのを 0.3 秒遅らせてある。遅らせないと、包みが起動直後に `ps` で pgid を確かめる間に子が抜け終わり、起動直後の 1 回の観察だけで捕まってしまうので、走行中の観察を外す変異(E2)が緑のまま生き残った。また perl の `sleep` は整数の秒しか受け付けない(`sleep 0.5` は即座に終わる)。さらに macOS の `ps` は終わりかけ(ゾンビ)のプロセスの名前を `(perl)` のように括弧で囲んで出すので、名前の正規化で外側の括弧を外す(外さないと、子の終了直後の観察で名前が上書きされ、変異を入れなくても 10 回中 6 回赤になった)。

## 2026-09-15(最終レビューの修正・I2)で分かったこと

I2 の直しで、E3 の意味が「使い回された pid を、名前が同じかどうかで同じ子とみなす」から「…、開始時刻(`ps -o lstart=`)が同じかどうかで同じ子とみなす」に変わった。`processTable()` が返す `ProcRow` に `started` を足し、親子関係が切れた子(ppid 1)を追う条件・`report()` の生き残りの再照合の両方を、名前ではなく開始時刻の一致で行うようにした(`test/run/watch.test.mjs` のテスト数はこの変更で 8 → 8 のまま増減なし、`test/run/probe.test.mjs` は変更なし。`escape` 組の対象テスト総数は 42 → 48 に増えたのは、C1・C2・M1 など他の指摘で `test/run/run.test.mjs` と `test/daemon/server.test.mjs` にテストを足したため)。E3 の `from` を新しい行(`known.started === r.started`)に合わせて更新し、置き換え元が 1 箇所であることを確認済み。

## 実行した環境

```
$ uname -sr
Darwin 25.6.0
$ node --version
v24.16.0
```

V4(Task 9)と V6 は macOS で実行した。Linux は未実行。
