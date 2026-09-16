# 記録(決定・hook の判断)と conductor report の門番の検出力

- 実行日時: 2026-09-16 10:08 JST(`date "+%Y-%m-%d %H:%M"` の出力)
- `uname -sr`: Darwin 25.6.0
- `node --version`: v24.16.0
- 走らせたもの: `npm run mutate:report`(新しい組)・`npm run mutate:escape`・`npm run mutate:hooks`・`npm run mutate:core`
- 全件: `npm test` 381 / 381(`ℹ tests 381` / `ℹ pass 381` / `ℹ fail 0`)、`npx tsc -p .` は終了コード 0

## 組 report(新設。`test/report/report.test.mjs` と `test/cli/report.test.mjs`)

```
== R1 計測の理由を見ない | src/report/report.mjs | 赤 | tests 13 / fail 2 / cancelled 0 / pass 11
   壊した行: (行を消した)
   赤: 待たせた理由を種別ごとに数える(ジョブごとに最初の理由)
   赤: 待ち・理由・借り・hook の判断を表に出し、絞り込みを添える
== R2 借りて入場した件数を数えない | src/report/report.mjs | 赤 | tests 13 / fail 1 / cancelled 0 / pass 12
   壊した行: (行を消した)
   赤: 容量を超えて借りた入場を数える
== R3 中央値の代わりに平均を出す | src/report/report.mjs | 赤 | tests 13 / fail 2 / cancelled 0 / pass 11
   壊した行: return sorted.reduce((a, b) => a + b, 0) / sorted.length;
   赤: 要求から入場までの待ち時間を、中央値と最大で数える
   赤: profile ごとの本数と所要の中央値、失敗、管理なしの走行を数える
== R4 repo と期間の絞り込みを外す | src/report/report.mjs | 赤 | tests 13 / fail 1 / cancelled 0 / pass 12
   壊した行: true
   赤: repo の前方一致と期間で絞る(決定は、その要求の repo で絞る)
== R5 待ち時間を常に 0 とする | src/report/report.mjs | 赤 | tests 13 / fail 2 / cancelled 0 / pass 11
   壊した行: 0
   赤: 要求から入場までの待ち時間を、中央値と最大で数える
   赤: repo の前方一致と期間で絞る(決定は、その要求の repo で絞る)
全部の変異が赤になった
```

★ **R3 は 1 回目の走行で生き残った**(`tests 13 / fail 0 / pass 13`)。テストの入力が中央値と平均を区別できていなかったため
(待ちが 0・2・4 分 → どちらも 2 分、所要が 10・20・30 分 → どちらも 20 分)。入力を待ち 0・2・6 分(中央 2 分・平均 2.67 分)と
所要 10・20・120 分(中央 20 分・平均 50 分)へ変えてから、上のとおり赤になった。**門番を足したら壊して確かめる**規律どおり、
1 回目の生き残りをここに残す。

## 既存の組へ足した変異

```
== E5 決定(grant / queued)を記録しない | src/daemon/server.mjs | 赤 | tests 55 / fail 2 / cancelled 0 / pass 53
   壊した行: (行を消した)
   赤: 出来事と決定を events.jsonl に記録し、tick は記録しない
   赤: 待たせた決定(queued)も、理由と順番つきで events.jsonl に記録する
== H21 背景へ回した判断を記録しない | src/hooks/pretooluse.mjs | 赤 | tests 79 / fail 1 / cancelled 0 / pass 78
   壊した行: (行を消した)
   赤: 背景へ回した判断と拒否を hooks.jsonl に記録し、何もしなかった分は書かない
== H22 拒否した判断を記録しない | src/hooks/pretooluse.mjs | 赤 | tests 79 / fail 1 / cancelled 0 / pass 78
   壊した行: (行を消した)
   赤: 背景へ回した判断と拒否を hooks.jsonl に記録し、何もしなかった分は書かない
== M18 grant に借りの印を載せない | src/core/schedule.mjs | 赤 | tests 89 / fail 1 / cancelled 0 / pass 88
   壊した行: (行を消した)
   赤: 借りて入場した親の子の grant には、借りの印が載る
```

組ごとの終わり方: `EXIT escape=0 hooks=0 core=0`(3 組とも最後の行は `全部の変異が赤になった`)。

## 分かったこと(改善の候補)

- `classify`(`src/config/profiles.mjs`)は、**1 つの部分に複数の profile が当たったら先に書いた方**を採る。設計書 §4.5 の
  「複数の profile に当たったら measure > batch > quick の順で重い方を採る」は、**部分をまたいだときだけ**そうなっている。
  IRC の `conductor.json` では、同じコマンドを 2 つの profile に書かない形で回避した(`npm run e2e` は計測の側だけに置く)。
  設計書の文言を実体に合わせるか、実装を重い方優先へ変えるかは、次の改善で決める。

## 導入の当日に踏んだ不具合と、その直し(2026-09-16)

plugin を入れて IRC の unit 全件を 1 本通した直後、`~/.conductor/hooks.jsonl` が **142 KB・864 行**になっていた。
中身を数えると、`cwd` は `/repo`(258 行)・`/w/irc`(54 行)・一時ディレクトリ(`cagree-*` / `cproj-*`)で、
**すべてテストと `conductor replay` の試算**だった。原因は、判断の記録を判定そのもの(`preToolUse`)の中に置いたこと:

- `conductor replay` は記録の全コマンドを `preToolUse` に流す(空回し)ので、流した数だけ本物の記録へ書く。
- `test/hooks/*` の多くは `env: {}` で呼ぶため、`conductorHome({})` が**実際のホーム**を指し、テストが `~/.conductor/` を汚す
  (全タスク共通の制約「テストは実際のホームの `~/.conductor/` を作らない」に違反していた)。

直し: **記録を hook の入口 `runHook`(`src/hooks/main.mjs`)へ移し、`preToolUse` は何も書かない純粋な関数に戻した**。
汚れた `hooks.jsonl` は消した(本物のセッションの行は 1 行も無かった)。門番は次の 3 本で、いずれも赤を実測した。

```
== H21 hook の判断を記録しない | src/hooks/main.mjs | 赤 | tests 81 / fail 1 / cancelled 0 / pass 80
== H22 拒否を背景として記録する | src/hooks/main.mjs | 赤 | tests 81 / fail 1 / cancelled 0 / pass 80
== H23 何もしなかった分まで記録しようとする | src/hooks/main.mjs | 赤 | tests 81 / fail 2 / cancelled 0 / pass 79
全部の変異が赤になった
```

新しいテストは `test/hooks/main.test.mjs`(入口が記録する / 判定は何も書かない / 記録に書けなくても判断は返す)。
全件は `ℹ tests 383` / `ℹ pass 383` / `ℹ fail 0`、`npx tsc -p .` は終了コード 0。

★ 教訓: **記録は「決めたところ」ではなく「実際に効かせるところ」に置く。** 判定を純粋に保てば、空回し(replay)と
テストが本物の記録を汚さない。これは設計 §4.4 の replay(「記録は読むだけで、何も書き出さない」)と同じ規律で、
今回はその規律を hook 側で破っていた。
