# 本物の Claude Code での通し(0.12.0)

## 実行日時・環境

- 日時: 2026-09-24
- `claude --version`: 2.1.281 (Claude Code)
- `node --version`: v22.22.2
- `uname -sr`: Linux 6.18.44-fc-v37
- モデル: claude-haiku-4-5
- 言語の指定なし(`LANG` などを外して、既定の英語で確かめる)・更新の確認は 0

`SWITCHYARD_LIVE_CLAUDE=1 node scripts/live-claude.mjs` の結果。使い捨ての作業場所と一時の `SWITCHYARD_HOME` で、
この repo を `--plugin-dir` として 3 回走らせた。

## 結果

```json
{
  "checks": {
    "shim が npm test を switchyard に通した(記録に default:batch の history)": true,
    "空いているので前景のまま走った(tool_result に子の出力・背景に回っていない)": true,
    "子にジョブの id が渡った(LIVE_JOB=j…)": true,
    "文言は英語(started)": true,
    "Stop の差し戻しの後、Claude が switchyard ack した": true,
    "./gradlew test を拒否せずに switchyard run で包んで走らせた(子にジョブの id)": true
  },
  "costUsd": [0.0169417, 0.031194, 0.0161054],
  "result1": "The output line starting with `LIVE_JOB=` is:\n\n```\nLIVE_JOB=jmufmuwar0\n```",
  "result2": "Done. The test ran and failed as expected, and I've acknowledged the job with switchyard.",
  "result3": "```\nGRADLE_JOB=jmufmve3x2 test\n```"
}
```

終了コード: 0。費用の合計 $0.064。

## 読み方

- 1: デーモンが空いていたので、PreToolUse は背景へ回さず(`task_started` の `is_backgrounded` が偽)、Bash の結果に子の出力が
  そのまま入った。それでも shim が包んでいて、記録に `default:batch` の走行が残り、子にジョブの id が渡っている。
- 2: 失敗した走行で Stop が差し戻し(0.11.0 から既定は知らせるだけなので、この走行だけ SWITCHYARD_STOP=block)、Claude は `switchyard ack` で確認済みにしてから止まった。
- 3: `./gradlew test` は shim から見えないので、PreToolUse が `switchyard run -- ./gradlew test` に書き換えた(0.12.0 から。
  以前は拒否して Claude に包み直させていた)。拒否は出ず(`denied` が偽)、記録にその要求が残り、子にジョブの id が渡っている。
  許したのは `Bash(switchyard run:*)` だけで、`./gradlew test` は許していない。Claude Code が書き換えた後のコマンドで権限を
  確かめていることも、ここで分かる。

0.9.0 から PreToolUse は `sh`/`awk` のふるいを通る。3 の書き換えは、ふるいが `gradlew` の語を見て node の判定へ回した結果で、
ふるいを通した入口が実物の Claude Code でも効いていることを確かめた。

以前の記録(2026-09-15)は 0.1 系のもので、背景に回ったかを "running in background" という文字列の有無だけで見ていた。
いまの台本は `task_started` と tool_result の中身で見る。
