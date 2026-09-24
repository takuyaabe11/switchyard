#!/bin/sh
# PreToolUse(Bash)の hook の入口。switchyard-pretooluse.awk のふるいが「判定は何もしない」と言い切れる呼び出しでは、
# node を起動せずに何も出さずに終わる(Bash の呼び出しごとの時間を減らす)。それ以外は node の判定へそのまま渡す。
# SWITCHYARD_HOOK_SIEVE=0 でふるいを外す(いつも node の判定へ渡す)。
# Windows では C:\…\switchyard-pretooluse.sh の形で呼ばれうる
case $0 in
  */*) here=${0%/*} ;;
  *\\*) here=${0%\\*} ;;
  *) here=. ;;
esac
input=$(cat)
if [ "${SWITCHYARD_HOOK_SIEVE:-1}" != 0 ] && printf '%s\n' "$input" | awk -f "$here/switchyard-pretooluse.awk" 2>/dev/null; then
  exit 0
fi
printf '%s\n' "$input" | node "$here/switchyard-hook.mjs" pre-tool-use
