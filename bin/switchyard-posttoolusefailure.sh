#!/bin/sh
# PostToolUseFailure(Bash)の hook の入口。失敗した Bash の呼び出しのうち、Bash の時間切れか、ポートが使用中のときだけ
# node の判定(src/hooks/failure.mjs)へ渡す。それ以外の失敗(テストが赤い・コマンドが無い)では node を起動せずに何も出さない。
# 文言は src/hooks/timeouts.mjs(Command timed out after)と src/hooks/ports.mjs の PORT_IN_USE に合わせる(node の側で確かめ直す)。
case $0 in
  */*) here=${0%/*} ;;
  *\\*) here=${0%\\*} ;;
  *) here=. ;;
esac
input=$(cat)
case "$input" in
  *'Command timed out after'* | *EADDRINUSE* | *'ddress already in use'* | *'already allocated'* | *'s already in use'* | *' is in use'*) ;;
  *) exit 0 ;;
esac
printf '%s\n' "$input" | node "$here/switchyard-hook.mjs" post-tool-use-failure
