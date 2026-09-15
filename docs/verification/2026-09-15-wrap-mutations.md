# 包みの入れ子・信号・管理なしの走行の門番の検出力(conductor 1b)

- 実行日時: 2026-09-15 19:52:51 JST
- `uname -sr`: Darwin 25.6.0
- `node --version`: v24.16.0

## 復元後の原本の `npm test`

```
ℹ tests 203
ℹ pass 203
ℹ fail 0
```

## `npm run mutate:wrap` の出力(全文)

```
> conductor@0.1.0 mutate:wrap
> node scripts/mutate.mjs wrap

== W1 祖先が持つ鍵を外さない | src/run/run.mjs | 赤 | tests 17 / fail 4 / cancelled 0 / pass 13
   壊した行: ,
   赤: デーモンに届かず管理なしで走ったら、終了時に控えを 1 行足す。入れ子でそのまま走ったときは足さない
   赤: buildRequest は祖先の鍵を外し、CPU を持つジョブの中では CPU を 0..0 にする
   赤: 入れ子で CPU も鍵も要らなければ、デーモンに接続せずにそのまま走らせる
   赤: 祖先が持つ鍵は待たない(git commit の中の git stash が、親の鍵で止まらない)
== W2 CPU を持つジョブの子に入れ子の印を立てない | src/run/run.mjs | 赤 | tests 17 / fail 1 / cancelled 0 / pass 16
   壊した行: (行を消した)
   赤: CPU を持つジョブの子には CONDUCTOR_IN_JOB=1 と、持っている鍵を CONDUCTOR_HELD_LOCKS で渡す
== W3 入れ子で何も要らなくてもデーモンに要求する | src/run/run.mjs | 赤 | tests 17 / fail 2 / cancelled 0 / pass 15
   壊した行: if (false) {
   赤: デーモンに届かず管理なしで走ったら、終了時に控えを 1 行足す。入れ子でそのまま走ったときは足さない
   赤: 入れ子で CPU も鍵も要らなければ、デーモンに接続せずにそのまま走らせる
== W4 CPU を持つジョブの中でも CPU を要求する | src/run/run.mjs | 赤 | tests 17 / fail 3 / cancelled 0 / pass 14
   壊した行: cpus: flags.cpus
   赤: デーモンに届かず管理なしで走ったら、終了時に控えを 1 行足す。入れ子でそのまま走ったときは足さない
   赤: buildRequest は祖先の鍵を外し、CPU を持つジョブの中では CPU を 0..0 にする
   赤: 入れ子で CPU も鍵も要らなければ、デーモンに接続せずにそのまま走らせる
== W5 グループの確かめ方を差し替えられない | src/run/run.mjs | 赤 | tests 17 / fail 1 / cancelled 0 / pass 16
   壊した行: pgid = verifiedGroup(c.pid, ownPgid);
   赤: 呼び出し元の SIGTERM は子の pid だけに届き、グループ(孫)には送らない
== W6 デーモンが管理なしの失敗を ack 待ちに積まない | src/daemon/server.mjs | 赤 | tests 17 / fail 1 / cancelled 0 / pass 16
   壊した行: if (false) apply({ type: 'unmanagedExit'
   赤: デーモンは起動時に控えを取り込み、記録に写し、失敗だけを ack 待ちに積む
== W7 管理なしで走っても控えない | src/run/run.mjs | 赤 | tests 17 / fail 2 / cancelled 0 / pass 15
   壊した行: if (false) {
   赤: 待っている間にデーモンが要求を拒んだら、待ち続けずに管理なしで実行し、控える
   赤: デーモンに届かず管理なしで走ったら、終了時に控えを 1 行足す。入れ子でそのまま走ったときは足さない
== W8 待っている間にデーモンが要求を拒んでも待ち続ける | src/run/run.mjs | 赤 | tests 17 / fail 0 / cancelled 1 / pass 16
   壊した行: } else if (false) {
   赤: 待っている間にデーモンが要求を拒んだら、待ち続けずに管理なしで実行し、控える
全部の変異が赤になった
```

## W8 が `cancelled` で赤になる理由

W8 は `src/run/run.mjs` の `attach` の `error` 枝から、待っている間(`phase === 'waiting'`)の分岐を
外す変異。この分岐が無いと、「待っている間にデーモンが要求を拒んだら、待ち続けずに管理なしで実行し、
控える」テストが、偽のデーモンからの `error` を受けても管理なしへ落ちず、待ち続ける。

このテストにはテスト自身の `{ timeout: 5_000 }` が付けてあるので、待ち続けた場合は Node のテストランナーが
5 秒で打ち切る。打ち切られたテストは `fail` ではなく `cancelled` に数えられる(件数の行が `fail 0 /
cancelled 1` になる)。`scripts/mutate.mjs` の赤の判定を `fail` だけで見ていると、この変異は `fail 0` のまま
「生き残り」と誤判定される(試作で実際に起きた)。今回の実装は `cancelled` も赤に数える(`redCount('fail')
|| redCount('cancelled')`)ので、`fail 0 / cancelled 1` でも正しく「赤」と判定している。
