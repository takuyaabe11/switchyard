# 本物の Claude Code での通し(0.12.1)

## 実行日時・環境

- 日時: 2026-09-24
- `claude --version`: 2.1.281 (Claude Code)
- `node --version`: v22.22.2
- `uname -sr`: Linux 6.18.44-fc-v37
- モデル: claude-haiku-4-5
- 言語の指定なし(`LANG` などを外して、既定の英語で確かめる)・更新の確認は 0

`SWITCHYARD_LIVE_CLAUDE=1 node scripts/live-claude.mjs` の結果。使い捨ての作業場所と一時の `SWITCHYARD_HOME` で、
この repo を `--plugin-dir` として 4 回走らせた。

## 結果

```json
{
  "checks": {
    "shim が npm test を switchyard に通した(記録に default:batch の history)": true,
    "空いているので前景のまま走った(tool_result に子の出力・背景に回っていない)": true,
    "子にジョブの id が渡った(LIVE_JOB=j…)": true,
    "文言は英語(started)": true,
    "Stop の差し戻しの後、Claude が switchyard ack した": true,
    "./gradlew test を拒否せずに switchyard run で包んで走らせた(子にジョブの id)": true,
    "switchyard run:* を許していても、中身が重い走行でない包みは走らなかった(Claude は実際に試した)": true
  },
  "costUsd": [0.0165587, 0.0325746, 0.0161764, 0.0174381],
  "result1": "```\nLIVE_JOB=jmufnwns10\n```",
  "result2": "Done. I ran `npm test` once (it failed as expected), and acknowledged the job failure with switchyard as instructed.",
  "result3": "Here's the line from the output that starts with `GRADLE_JOB=`:\n\n```\nGRADLE_JOB=jmufnx6bd2 test\n```",
  "result4": "DONE."
}
```

終了コード: 0。費用の合計 $0.083。

## 読み方

- 1: デーモンが空いていたので、PreToolUse は背景へ回さず(`task_started` の `is_backgrounded` が偽)、Bash の結果に子の出力が
  そのまま入った。それでも shim が包んでいて、記録に `default:batch` の走行が残り、子にジョブの id が渡っている。
- 2: 失敗した走行で Stop が差し戻し(0.11.0 から既定は知らせるだけなので、この走行だけ SWITCHYARD_STOP=block)、Claude は `switchyard ack` で確認済みにしてから止まった。
- 3: `./gradlew test` は shim から見えないので、PreToolUse が `switchyard run -- ./gradlew test` に書き換えた(0.12.0 から。
  以前は拒否して Claude に包み直させていた)。拒否は出ず(`denied` が偽)、記録にその要求が残り、子にジョブの id が渡っている。
  許したのは包んだ形 `Bash(switchyard run -- ./gradlew test)` だけで、`./gradlew test` は許していない。Claude Code が書き換えた
  後のコマンドで権限を確かめ、包んだ形だけを許す狭い規則で足りることが、ここで分かる。
- 4: `Bash(switchyard run:*)` と広く許した上で、`switchyard run -- touch unvetted.txt` を走らせるよう頼んだ。Claude はそのとおり
  試した(`commands` にある)が、中身が重い走行の形ではないので PreToolUse が承認を求め(ask)、承認する人のいない `-p` では
  走らず、ファイルはできなかった。
  比べるために同じ頼みを `SWITCHYARD_RUN_GUARD=0`(この確認を止めた状態)で走らせると、ファイルができた。0.12.0 が勧めていた
  `Bash(switchyard run:*)` は、実際に何でも通していた。

0.9.0 から PreToolUse は `sh`/`awk` のふるいを通る。3 の書き換えは、ふるいが `gradlew` の語を見て node の判定へ回した結果で、
ふるいを通した入口が実物の Claude Code でも効いていることを確かめた。

以前の記録(2026-09-15)は 0.1 系のもので、背景に回ったかを "running in background" という文字列の有無だけで見ていた。
いまの台本は `task_started` と tool_result の中身で見る。
