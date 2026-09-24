# switchyard の shim の本体(設計 §9.1)。各 shim は name を決めてから、これを読み込む。
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
  echo "switchyard shim: 本物の $name が PATH に見つからない" >&2
  exit 127
fi

# CPU を持つジョブの中なら、そのジョブの一部として走らせる(設計 §4.3 の 7。分類器を呼ぶまでもない)
if [ "${SWITCHYARD_IN_JOB:-}" = 1 ]; then exec "$real" "$@"; fi

# git は index を書き換えるサブコマンドのときだけ分類器を呼ぶ(git status などを速いまま通す)。
# 大域オプション(-C dir・-c k=v・--no-pager など)を読み飛ばしてサブコマンドを探す。
# 最初の引数だけを見ると git -C repo commit が鍵を取らずに素通りする
# (src/shim/decide.mjs の gitSubcommand と GIT_LOCK_SUBCOMMANDS と同じ。test/shim/shims.test.mjs が食い違いを止める)
if [ "$name" = git ]; then
  git_sub=
  git_skip=0
  for a in "$@"; do
    if [ "$git_skip" = 1 ]; then
      git_skip=0
      continue
    fi
    case "$a" in
      -C | -c | --git-dir | --work-tree | --namespace | --config-env | --super-prefix) git_skip=1 ;;
      -*) ;;
      *)
        git_sub=$a
        break
        ;;
    esac
  done
  case "$git_sub" in
    commit | merge | rebase | cherry-pick | stash | am | add | rm | mv | reset | restore | checkout | switch | pull | revert) ;;
    *) exec "$real" "$@" ;;
  esac
fi

# sh のふるい(設計 §9.1)。node を 1 本起動すると、素通しのコマンドにもその時間(実測 21ms)がまるごと乗る。
# switchyard.json の無い repo では既定表だけが効き、既定表の glob はどれも語で始まる
# (src/config/profiles.mjs の defaultHeadWords。test/shim/shims.test.mjs が食い違いを止める)。
# だから先頭の語がその中に無ければ、分類器を呼ぶまでもない。
# git はここまで来た時点で index を書き換えるサブコマンドで、鍵は profile の表ではなく git-dir が決める。ふるいにかけない
if [ "$name" != git ]; then
  sieve_root=${PWD:-$(pwd)}
  while [ ! -e "$sieve_root/.git" ]; do
    sieve_up=${sieve_root%/*}
    [ -n "$sieve_up" ] || sieve_up=/
    if [ "$sieve_up" = "$sieve_root" ]; then
      sieve_root=${PWD:-$(pwd)}
      break
    fi
    sieve_root=$sieve_up
  done
  # 改名の前の名前(conductor.json)も見る。見ないと、古い名前の設定を持つ repo で
  # 既定表に無い語(node など)がふるいで素通しになり、その repo の profile が効かなくなる
  if [ ! -f "$sieve_root/switchyard.json" ] && [ ! -f "$sieve_root/conductor.json" ]; then
    case "$name" in
      bun | cargo | go | make | npm | npx | pnpm | pytest | yarn) ;;
      *)
        # node_modules/.bin のスクリプトを shebang(#!/usr/bin/env node)で起動した形は、npx と同じに分類する
        case "$name:${1:-}" in
          node:*node_modules/.bin/*) ;;
          *) exec "$real" "$@" ;;
        esac
        ;;
    esac
  fi
fi

node=$(PATH=$stripped command -v node 2>/dev/null)
[ -n "$node" ] || exec "$real" "$@"
answer=$(PATH=$stripped "$node" "$root/src/shim/decide.mjs" "$name" "$@" 2>/dev/null) || exec "$real" "$@"

case "$answer" in
  "run "*) exec "$node" "$root/bin/switchyard.mjs" run --profile "${answer#run }" -- "$real" "$@" ;;
  "lock "*) exec "$node" "$root/bin/switchyard.mjs" run --class quick --cpus 0..0 --lock "${answer#lock }" -- "$real" "$@" ;;
  *) exec "$real" "$@" ;;
esac
