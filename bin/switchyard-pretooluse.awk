# PreToolUse(Bash)の入口のふるい(bin/switchyard-pretooluse.sh から呼ぶ)。
# hook の標準入力の JSON を読み、判定(src/hooks/pretooluse.mjs)が何もしないと言い切れるときだけ 0 で終わる。
# 言い切れなければ 1(node の判定へ回す)。node を起動しない分、普段の Bash の呼び出しに乗る時間が 64ms → 数 ms になる。
#
# 判定が何かを返すのは、どれかの部分が次のどれかのときだけ:
#   - 既定表の glob が始まる語(src/config/profiles.mjs の defaultHeadWords。どれも shim の語)。
#     shim の語のうち node は、設定ファイルが無ければ node_modules/.bin の形でしか当たらない(下の node_modules で拾う)
#   - git の、index を書き換えるサブコマンド(SWITCHYARD_GIT=1 のときだけ。パスで呼ぶ・PATH を差し替えると拒否する)
#   - switchyard run の包み・パスで呼ぶビルドの包み(gradlew・mvnw)・node_modules/.bin の実行ファイル
#   - repo の switchyard.json(改名前の conductor.json)の profile
# だから、コマンドの文字列にこれらの語が語として現れず、cwd から上に設定ファイルが無ければ、node を起動するまでもない。
# 語の一覧は test/hooks/sieve.test.mjs が SHIM_WORDS・defaultHeadWords との食い違いを止める。
# 読めない形(command や cwd が見つからない・エスケープを含む cwd)は、迷わず 1 を返す。
# 前に Bash の時間切れで切られたコマンドも 1(判定が時間切れを延ばす)。
# Windows の cwd(C:\\Users\\a。JSON では \ が \\ になる)は / の形(C:/Users/a)に直して見る。

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
  # switchyard を止めていれば、判定も何もしない
  if (ENVIRON["SWITCHYARD_OFF"] == "1" || ENVIRON["SWITCHYARD_THINKER"] == "1") exit 0
  cmd = field(s, "command")
  if (cmd == "\001") exit 1
  # 前に Bash の時間切れで切られたコマンド(src/hooks/timeouts.mjs が書く一覧。JSON の文字列の中身の形)は、
  # 重い語が無くても node の判定へ回す(時間切れを延ばす)
  if (ENVIRON["SWITCHYARD_TIMEOUT_GUARD"] != "0") {
    home = ENVIRON["SWITCHYARD_HOME"]
    if (home == "") home = ENVIRON["HOME"] "/.switchyard"
    list = home "/timeouts.txt"
    while ((getline line < list) > 0) {
      if (line == cmd) { close(list); exit 1 }
    }
    close(list)
  }
  # 改行・タブなどのエスケープ(\n)の字は語の一部ではない。語の境目にする
  gsub(/\\u[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]/, " ", cmd)
  gsub(/\\[nrtbf]/, " ", cmd)
  if (cmd ~ /(^|[^A-Za-z0-9_-])(npm|npx|cargo|pytest|go|make|yarn|pnpm|bun|python|python3|uv|poetry|mvn|gradle|dotnet|bundle|rspec|deno|xcodebuild|bazel|bazelisk|nx|turbo|php|composer|phpunit|pest|paratest|switchyard|gradlew|mvnw|node_modules)([^A-Za-z0-9_-]|$)/) exit 1
  # git は index を書き換えるサブコマンド(src/shim/decide.mjs の GIT_LOCK_SUBCOMMANDS)の語があるときだけ見る(git status・git diff は素通し)
  if (ENVIRON["SWITCHYARD_GIT"] == "1" && cmd ~ /(^|[^A-Za-z0-9_-])git([^A-Za-z0-9_-]|$)/ && cmd ~ /(^|[^A-Za-z0-9_-])(commit|merge|rebase|cherry-pick|stash|am|add|rm|mv|reset|restore|checkout|switch|pull|revert)([^A-Za-z0-9_-]|$)/) exit 1
  # 前景で待つ形(sleep を含む until / while / for のループ・sleep だけ・gh run watch)は、判定が背景へ回すので node へ渡す
  # (src/hooks/waitloop.mjs。ループの形と回数は node の側で確かめる)
  if (ENVIRON["SWITCHYARD_WAIT_LOOPS"] != "0") {
    if (cmd ~ /(^|[^A-Za-z0-9_-])(until|while|for)([^A-Za-z0-9_-]|$)/ && cmd ~ /(^|[^A-Za-z0-9_-])do([^A-Za-z0-9_-]|$)/ && cmd ~ /(^|[^A-Za-z0-9_-])sleep([^A-Za-z0-9_-]|$)/) exit 1
    if (cmd ~ /^[ \t]*sleep[ \t]+[0-9]/ || cmd ~ /(^|[^A-Za-z0-9_-])gh[ \t]+run[ \t]+watch([^A-Za-z0-9_-]|$)/) exit 1
  }
  cwd = field(s, "cwd")
  if (cwd ~ /^[A-Za-z]:(\\\\|\/)/) {
    gsub(/\\\\/, "/", cwd)
    sub(/\/$/, "", cwd)
  } else if (cwd !~ /^\//) exit 1
  if (cwd == "\001" || cwd ~ /\\/) exit 1
  d = cwd
  while (1) {
    if (exists(d "/switchyard.json") || exists(d "/conductor.json")) exit 1
    if (d == "") break
    prev = d
    sub(/\/[^\/]*$/, "", d)
    # Windows のドライブの根(C:)まで来た
    if (d == prev) break
  }
  exit 0
}
