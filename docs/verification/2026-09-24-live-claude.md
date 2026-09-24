# 本物の Claude Code での通し(0.11.0)

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
    "./gradlew test を拒否し、Claude が switchyard run で包んで走らせた": true
  },
  "costUsd": [0.0164635, 0.0394821, 0.0203286],
  "result1": "The command has finished. Here's the line from the output that starts with `LIVE_JOB=`:\n\n```\nLIVE_JOB=jmufajmem0\n```",
  "result2": "Done. I've acknowledged the failed test job with switchyard. The test ran as expected and exited with code 1—the failure has been marked as reviewed.",
  "result3": "```\nGRADLE_JOB=jmufak7mh2 test\n```"
}
```

終了コード: 0。費用の合計 $0.076。

## 読み方

- 1: デーモンが空いていたので、PreToolUse は背景へ回さず(`task_started` の `is_backgrounded` が偽)、Bash の結果に子の出力が
  そのまま入った。それでも shim が包んでいて、記録に `default:batch` の走行が残り、子にジョブの id が渡っている。
- 2: 失敗した走行で Stop が差し戻し(0.11.0 から既定は知らせるだけなので、この走行だけ SWITCHYARD_STOP=block)、Claude は `switchyard ack` で確認済みにしてから止まった。
- 3: `./gradlew test` は shim から見えないので PreToolUse が拒否し、Claude は案内どおり `switchyard run -- ./gradlew test` で
  走らせ直した。記録にその要求が残り、子にジョブの id が渡っている。

0.9.0 から PreToolUse は `sh`/`awk` のふるいを通る。3 の拒否は、ふるいが `gradlew` の語を見て node の判定へ回した結果で、
ふるいを通した入口が実物の Claude Code でも効いていることを確かめた。

以前の記録(2026-09-15)は 0.1 系のもので、背景に回ったかを "running in background" という文字列の有無だけで見ていた。
いまの台本は `task_started` と tool_result の中身で見る。
