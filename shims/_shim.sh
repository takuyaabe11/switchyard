# conductor の shim の本体(設計 §9.1)。各 shim は name を決めてから、これを読み込む。
# 分からないことがあれば、本物のコマンドをそのまま exec する(shim の失敗で作業を止めない)。
# PATH が空でも動くよう、外部コマンド(dirname など)は使わない。

raw_dir=${0%/*}
self_dir=$(CDPATH= cd -- "$raw_dir" && pwd -P)
root=${self_dir%/*}

# PATH から自分(shims/)を除く。除かないと、本物を探すときに自分へ戻ってくる
stripped=
old_ifs=$IFS
IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  if [ "$d" = "$raw_dir" ] || [ "$d" = "$self_dir" ]; then continue; fi
  stripped="${stripped:+$stripped:}$d"
done
IFS=$old_ifs

real=$(PATH=$stripped command -v "$name" 2>/dev/null)
if [ -z "$real" ]; then
  echo "conductor shim: 本物の $name が PATH に見つからない" >&2
  exit 127
fi

# CPU を持つジョブの中なら、そのジョブの一部として走らせる(設計 §4.3 の 7。分類器を呼ぶまでもない)
if [ "${CONDUCTOR_IN_JOB:-}" = 1 ]; then exec "$real" "$@"; fi

# git は index を書き換えるサブコマンドのときだけ分類器を呼ぶ(git status などを速いまま通す)
if [ "$name" = git ]; then
  case "${1:-}" in
    commit | merge | rebase | cherry-pick | stash | am) ;;
    *) exec "$real" "$@" ;;
  esac
fi

node=$(PATH=$stripped command -v node 2>/dev/null)
[ -n "$node" ] || exec "$real" "$@"
answer=$(PATH=$stripped "$node" "$root/src/shim/decide.mjs" "$name" "$@" 2>/dev/null) || exec "$real" "$@"

case "$answer" in
  "run "*) exec "$node" "$root/bin/conductor.mjs" run --profile "${answer#run }" -- "$real" "$@" ;;
  "lock "*) exec "$node" "$root/bin/conductor.mjs" run --class quick --cpus 0..0 --lock "${answer#lock }" -- "$real" "$@" ;;
  *) exec "$real" "$@" ;;
esac
