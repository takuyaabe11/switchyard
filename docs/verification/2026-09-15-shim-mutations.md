# shim の門番の検出力(conductor 1b)

- 実行日時: 2026-09-15 22:23 JST(最後の全体レビューの修正の後に走らせ直した)
- 環境: Darwin 25.6.0
- Node: v24.16.0
- 組のテスト: `test/shim/decide.test.mjs`・`test/shim/shims.test.mjs`・`test/hooks/agreement.test.mjs`(三者の判定の表)

## 原本の `npm test`(変異は一時ディレクトリの写しに入れるので、原本は変わらない)

```
ℹ tests 311
ℹ suites 54
ℹ pass 311
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## npm run mutate:shim の出力

```
> conductor@0.2.0 mutate:shim
> node scripts/mutate.mjs shim

== D1 CPU を持つジョブの中でも分類する | src/shim/decide.mjs | 赤 | tests 58 / fail 1 / cancelled 0 / pass 57
   壊した行: (行を消した)
   赤: CPU を持つジョブの中では、何でも pass
== D2 conductor の CLI 自身も分類して包む | src/shim/decide.mjs | 赤 | tests 58 / fail 4 / cancelled 0 / pass 54
   壊した行: (行を消した)
   赤: "conductor run -- npx vitest run"
   赤: "conductor run -- ./node_modules/.bin/vitest run"
   赤: "node <bin/conductor.mjs> run --lock port:4173 -- npm run bench"
   赤: node で呼んだこの plugin の conductor の CLI は、分類せずに pass(外側のジョブに包まない)
== S6 分類器が失敗したら作業を止める | shims/_shim.sh | 赤 | tests 58 / fail 1 / cancelled 0 / pass 57
   壊した行: 2>/dev/null) || exit 1
   赤: 分類器が失敗したら(終了コード 0 以外)、答えを出していても本物をそのまま実行する
== S7 分類器の想定外の答えで作業を止める | shims/_shim.sh | 赤 | tests 58 / fail 3 / cancelled 0 / pass 55
   壊した行: *) exit 1 ;;
esac
   赤: 管理対象でなければ、本物をそのまま実行する
   赤: 分類器が想定外の答えを出したら、本物をそのまま実行する
   赤: 祖先が git の鍵を持っていれば、git stash はジョブを作らずに走る
== S2 node が無いと作業を止める | shims/_shim.sh | 赤 | tests 58 / fail 1 / cancelled 0 / pass 57
   壊した行: [ -n "$node" ] || exit 1
   赤: node が PATH に無ければ、本物をそのまま実行する(作業を止めない)
== S3 祖先が持つ git の鍵も取りに行く | src/shim/decide.mjs | 赤 | tests 58 / fail 1 / cancelled 0 / pass 57
   壊した行: return { kind: 'lock', lock };
   赤: 祖先が同じ git の鍵を持っていれば pass
== S4 管理対象を包まない | shims/_shim.sh | 赤 | tests 58 / fail 1 / cancelled 0 / pass 57
   壊した行: "never-run "*) exec
   赤: 管理対象(npm test)は conductor run に包まれ、子にジョブの印が渡る
== S5 git の鍵だけのジョブを作らない | shims/_shim.sh | 赤 | tests 58 / fail 1 / cancelled 0 / pass 57
   壊した行: "never-lock "*) exec
   赤: git commit は git-dir の鍵だけのジョブとして包み、鍵を子に渡す
全部の変異が赤になった
```

## 最後の全体レビューで足した変異

- **D2(I2)**: 分類器が conductor の CLI 自身(`node …/bin/conductor.mjs`)を見分けて `pass` を返す行を消す。赤は分類器の単体テストと、三者の判定の表の `conductor run` の行。
- **S6・S7(I4)**: `_shim.sh:39` の「分類器が失敗したら本物へ」を `|| exit 1` に、`_shim.sh:44` の「想定外の答えなら本物へ」を `exit 1` にする。赤は、分類器を `process.exit(3)` するだけ・`garbage` を出すだけの偽物に差し替えた root で走らせるテスト。S7 の壊した行は改行を含むので、出力では 2 行になる。S7 は `pass` の答えも同じ枝を通るので、`pass` を確かめるテストも赤になる。
- **S2** のテストは、PATH を shims と偽のコマンドだけにして、`/usr/bin/node` のある機械でも skip しない形にした(以前は `/usr/bin/node` があると skip していた)。

## 入れていない変異と理由

### sh の `CONDUCTOR_IN_JOB` の直行

分類器(`decideShim`)も同じ条件で `pass` を返すので、sh の行だけを壊しても結果は変わらない。sh の行は分類器を呼ばずに済ませる速い道で、守りは分類器の側にある。そちらを D1 で測る。

### PATH から自分を除く行

壊すと shim が自分を exec し続け、`conductor run` の子として孤児になりうる。安全に止められないので入れない。
