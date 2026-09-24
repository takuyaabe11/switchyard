# PreToolUse(Bash)の入口のふるい(bin/switchyard-pretooluse.sh から呼ぶ)。
# hook の標準入力の JSON を読み、判定(src/hooks/pretooluse.mjs)が何もしないと言い切れるときだけ 0 で終わる。
# 言い切れなければ 1(node の判定へ回す)。node を起動しない分、普段の Bash の呼び出しに乗る時間が 64ms → 数 ms になる。
#
# 判定が何かを返すのは、どれかの部分が次のどれかのときだけ:
#   - 既定表の glob が始まる語(src/config/profiles.mjs の defaultHeadWords。どれも shim の語)。
#     shim の語のうち node は、設定ファイルが無ければ node_modules/.bin の形でしか当たらない(下の node_modules で拾う)
#   - git の、index を書き換えるサブコマンド(パスで呼ぶ・PATH を差し替えると拒否する)
#   - switchyard run の包み・パスで呼ぶビルドの包み(gradlew・mvnw)・node_modules/.bin の実行ファイル
#   - repo の switchyard.json(改名前の conductor.json)の profile
# だから、コマンドの文字列にこれらの語が語として現れず、cwd から上に設定ファイルが無ければ、node を起動するまでもない。
# 語の一覧は test/hooks/sieve.test.mjs が SHIM_WORDS・defaultHeadWords との食い違いを止める。
# 読めない形(command や cwd が見つからない・エスケープを含む cwd)は、迷わず 1 を返す。

function exists(f,    line, r) {
  r = (getline line < f)
  close(f)
  return r >= 0
}

# JSON の "key": "値" の値(引用の中身のまま)。見つからなければ "\001"
function field(s, key,    re, v) {
  re = "[{,][ \t\n]*\"" key "\"[ \t\n]*:[ \t\n]*\"([^\"\\\\]|\\\\.)*\""
  if (!match(s, re)) return "\001"
  v = substr(s, RSTART, RLENGTH)
  sub(/^[{,][ \t\n]*"[^"]*"[ \t\n]*:[ \t\n]*"/, "", v)
  return substr(v, 1, length(v) - 1)
}

{ s = s $0 "\n" }

END {
  cmd = field(s, "command")
  if (cmd == "\001") exit 1
  # 改行・タブなどのエスケープ(\n)の字は語の一部ではない。語の境目にする
  gsub(/\\u[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]/, " ", cmd)
  gsub(/\\[nrtbf]/, " ", cmd)
  if (cmd ~ /(^|[^A-Za-z0-9_-])(npm|npx|cargo|pytest|go|make|yarn|pnpm|bun|python|python3|uv|poetry|mvn|gradle|dotnet|bundle|rspec|deno|switchyard|gradlew|mvnw|node_modules)([^A-Za-z0-9_-]|$)/) exit 1
  # git は index を書き換えるサブコマンド(src/shim/decide.mjs の GIT_LOCK_SUBCOMMANDS)の語があるときだけ見る(git status・git diff は素通し)
  if (cmd ~ /(^|[^A-Za-z0-9_-])git([^A-Za-z0-9_-]|$)/ && cmd ~ /(^|[^A-Za-z0-9_-])(commit|merge|rebase|cherry-pick|stash|am|add|rm|mv|reset|restore|checkout|switch|pull|revert)([^A-Za-z0-9_-]|$)/) exit 1
  cwd = field(s, "cwd")
  if (cwd == "\001" || cwd !~ /^\// || cwd ~ /\\/) exit 1
  d = cwd
  while (1) {
    if (exists(d "/switchyard.json") || exists(d "/conductor.json")) exit 1
    if (d == "") break
    sub(/\/[^\/]*$/, "", d)
  }
  exit 0
}
