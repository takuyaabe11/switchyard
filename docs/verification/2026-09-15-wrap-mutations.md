# 包みの入れ子・信号・管理なしの走行の門番の検出力(switchyard 1b)

- 実行日時: 2026-09-16 07:24 JST(改善 3 の実装後、Task 1 で検証)
- `uname -sr`: Darwin 25.6.0
- `node --version`: v24.16.0
- 組のテスト: `test/run/nest.test.mjs`・`test/run/signals.test.mjs`・`test/daemon/unmanaged.test.mjs`

## 原本の `npm test`(変異は一時ディレクトリの写しに入れるので、原本は変わらない)

```
ℹ tests 350
ℹ suites 62
ℹ pass 350
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## `npm run mutate:wrap` の出力(全文)

```
> switchyard@0.2.0 mutate:wrap
> node scripts/mutate.mjs wrap

== W1 祖先が持つ鍵を外さない | src/run/run.mjs | 赤 | tests 21 / fail 4 / cancelled 0 / pass 17
   壊した行: ,
   赤: デーモンに届かず管理なしで走ったら、終了時に控えを 1 行足す。入れ子でそのまま走ったときは足さない
   赤: buildRequest は祖先の鍵を外し、CPU を持つジョブの中では CPU を 0..0 にする
   赤: 入れ子で CPU も鍵も要らなければ、デーモンに接続せずにそのまま走らせる
   赤: 祖先が持つ鍵は待たない(git commit の中の git stash が、親の鍵で止まらない)
== W2 CPU を持つジョブの子に入れ子の印を立てない | src/run/run.mjs | 赤 | tests 21 / fail 1 / cancelled 0 / pass 20
   壊した行: (行を消した)
   赤: CPU を持つジョブの子には SWITCHYARD_IN_JOB=1 と、持っている鍵を SWITCHYARD_HELD_LOCKS で渡す
== W3 入れ子で何も要らなくてもデーモンに要求する | src/run/run.mjs | 赤 | tests 21 / fail 2 / cancelled 0 / pass 19
   壊した行: if (false) {
   赤: デーモンに届かず管理なしで走ったら、終了時に控えを 1 行足す。入れ子でそのまま走ったときは足さない
   赤: 入れ子で CPU も鍵も要らなければ、デーモンに接続せずにそのまま走らせる
== W4 CPU を持つジョブの中でも CPU を要求する | src/run/run.mjs | 赤 | tests 21 / fail 3 / cancelled 0 / pass 18
   壊した行: cpus: flags.cpus
   赤: デーモンに届かず管理なしで走ったら、終了時に控えを 1 行足す。入れ子でそのまま走ったときは足さない
   赤: buildRequest は祖先の鍵を外し、CPU を持つジョブの中では CPU を 0..0 にする
   赤: 入れ子で CPU も鍵も要らなければ、デーモンに接続せずにそのまま走らせる
== W5 グループの確かめ方を差し替えられない | src/run/run.mjs | 赤 | tests 21 / fail 1 / cancelled 0 / pass 20
   壊した行: pgid = verifiedGroup(c.pid, ownPgid);
   赤: 呼び出し元の SIGTERM は子の pid だけに届き、グループ(孫)には送らない
== W6 デーモンが管理なしの失敗を ack 待ちに積まない | src/daemon/server.mjs | 赤 | tests 21 / fail 2 / cancelled 0 / pass 19
   壊した行: if (false) apply({ type: 'unmanagedExit'
   赤: デーモンが起動した後に足された控えも、次の tick で取り込み、失敗を ack 待ちに積む
   赤: デーモンは起動時に控えを取り込み、記録に写し、失敗だけを ack 待ちに積む
== W7 管理なしで走っても控えない | src/run/run.mjs | 赤 | tests 21 / fail 2 / cancelled 0 / pass 19
   壊した行: if (false) {
   赤: 待っている間にデーモンが要求を拒んだら、待ち続けずに管理なしで実行し、控える
   赤: デーモンに届かず管理なしで走ったら、終了時に控えを 1 行足す。入れ子でそのまま走ったときは足さない
== W8 待っている間にデーモンが要求を拒んでも待ち続ける | src/run/run.mjs | 赤 | tests 21 / fail 0 / cancelled 1 / pass 20
   壊した行: } else if (false) {
   赤: 待っている間にデーモンが要求を拒んだら、待ち続けずに管理なしで実行し、控える
== W9 tick で控えを取り込まない | src/daemon/server.mjs | 赤 | tests 21 / fail 1 / cancelled 0 / pass 20
   壊した行: try {
      void 0;
   赤: デーモンが起動した後に足された控えも、次の tick で取り込み、失敗を ack 待ちに積む
== W10 残った別名(.taking)を拾わない | src/daemon/store.mjs | 赤 | tests 21 / fail 1 / cancelled 0 / pass 20
   壊した行: .filter(() => false)
   赤: takeUnmanaged は rename と unlink の間で落ちて残った別名(.taking)も拾い、2 度は取り込まない
== W11 鍵だけのジョブの子の要求に parent を載せない | src/run/run.mjs | 赤 | tests 21 / fail 1 / cancelled 0 / pass 20
   壊した行: const parent = null;
   赤: buildRequest は、鍵だけのジョブの子(祖先の鍵があり SWITCHYARD_IN_JOB が無い)にだけ、親のジョブの id を parent として載せる(設計 §4.3 の 7)
全部の変異が赤になった
```

## 最後の全体レビューで足した変異

- **W9(I3)**: デーモンの tick で控えを取り込む呼び出しを消す(直す前の、起動時だけ取り込む形)。赤は「デーモンが起動した後に足された控えも、次の tick で取り込み、失敗を ack 待ちに積む」だけ。壊した行は改行を含むので、出力では 2 行になる。
- **W10(m4)**: rename と unlink の間で落ちて残った別名(`.taking`)を拾わない形。赤は、残った別名(落ちたデーモンと同じ pid の名前も含む)を置いたテストだけ。
- **W6** は、tick の取り込みも同じ `unmanagedExit` を通るので、足したテストも赤になり 2 件になった。

## 改善 3 で足した変異

- **W11**: 鍵だけのジョブの子の要求に parent を載せない形。赤は「buildRequest は、鍵だけのジョブの子(祖先の鍵があり SWITCHYARD_IN_JOB が無い)にだけ、親のジョブの id を parent として載せる(設計 §4.3 の 7)」のテストだけ。

## W8 が `cancelled` で赤になる理由

W8 は `src/run/run.mjs` の `attach` の `error` 枝から、待っている間(`phase === 'waiting'`)の分岐を
外す変異。この分岐が無いと、「待っている間にデーモンが要求を拒んだら、待ち続けずに管理なしで実行し、
控える」テストが、偽のデーモンからの `error` を受けても管理なしへ落ちず、待ち続ける。

このテストにはテスト自身の `{ timeout: 5_000 }` が付けてあるので、待ち続けた場合は Node のテストランナーが
5 秒で打ち切る。打ち切られたテストは `fail` ではなく `cancelled` に数えられる(件数の行が `fail 0 /
cancelled 1` になる)。`scripts/mutate.mjs` の赤の判定を `fail` だけで見ていると、この変異は `fail 0` のまま
「生き残り」と誤判定される(試作で実際に起きた)。今回の実装は `cancelled` も赤に数える(`redCount('fail')
|| redCount('cancelled')`)ので、`fail 0 / cancelled 1` でも正しく「赤」と判定している。
