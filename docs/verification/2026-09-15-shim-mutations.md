# shim の門番の検出力(conductor 1b)

実行日時: Tue Sep 15 20:15:19 JST 2026
環境: Darwin 25.6.0
Node: v24.16.0

## 復元後の原本のテスト

```
ℹ tests 221
ℹ pass 221
ℹ fail 0
```

## npm run mutate:shim の出力

```
== D1 CPU を持つジョブの中でも分類する | src/shim/decide.mjs | 赤 | tests 18 / fail 1 / cancelled 0 / pass 17
   壊した行: (行を消した)
   赤: CPU を持つジョブの中では、何でも pass
== S2 node が無いと作業を止める | shims/_shim.sh | 赤 | tests 18 / fail 1 / cancelled 0 / pass 17
   壊した行: [ -n "$node" ] || exit 1
   赤: node が PATH に無ければ、本物をそのまま実行する(作業を止めない)
== S3 祖先が持つ git の鍵も取りに行く | src/shim/decide.mjs | 赤 | tests 18 / fail 1 / cancelled 0 / pass 17
   壊した行: return { kind: 'lock', lock };
   赤: 祖先が同じ git の鍵を持っていれば pass
== S4 管理対象を包まない | shims/_shim.sh | 赤 | tests 18 / fail 1 / cancelled 0 / pass 17
   壊した行: "never-run "*) exec
   赤: 管理対象(npm test)は conductor run に包まれ、子にジョブの印が渡る
== S5 git の鍵だけのジョブを作らない | shims/_shim.sh | 赤 | tests 18 / fail 1 / cancelled 0 / pass 17
   壊した行: "never-lock "*) exec
   赤: git commit は git-dir の鍵だけのジョブとして包み、鍵を子に渡す
全部の変異が赤になった
```

## 入れていない変異と理由

### sh の `CONDUCTOR_IN_JOB` の直行

分類器(`decideShim`)も同じ条件で `pass` を返すので、sh の行だけを壊しても結果は変わらない。sh の行は分類器を呼ばずに済ませる速い道で、守りは分類器の側にある。そちらを D1 で測る。

### PATH から自分を除く行

壊すと shim が自分を exec し続け、`conductor run` の子として孤児になりうる。安全に止められないので入れない。
