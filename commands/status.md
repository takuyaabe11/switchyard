---
description: Show switchyard's state at a glance - whether this session is governed, what runs and waits, and the last day's totals. switchyard の状態を 1 目で出す(このセッションが統治下か・走行と待ち・直近 1 日の集計)
---

このセッションが switchyard の統治下にあるかと、いまの走行・待ち・直近の集計を調べて、短くまとめる。

## 1. 調べる

次を 1 回の Bash で走らせる(失敗しても止めない)。

```sh
echo "PATH先頭: $(echo $PATH | cut -d: -f1)"
which npm
command -v switchyard >/dev/null && switchyard top || echo "(switchyard は PATH に無い)"
```

`switchyard` が PATH に無ければ、入っている plugin の複製から直に呼ぶ。

```sh
CLI=$(ls -d "$HOME"/.claude/plugins/cache/switchyard/switchyard/*/bin/switchyard.mjs 2>/dev/null | sort -V | tail -1)
[ -n "$CLI" ] && node "$CLI" top || echo "(plugin が入っていない)"
```

続けて、直近 1 日の集計を取る(repo の中なら `--repo` にその repo の根を渡す)。

```sh
switchyard report --since 1d    # PATH に無ければ node "$CLI" report --since 1d
```

## 2. 判定

| 見えたもの | 判定 |
|---|---|
| PATH の先頭が `.../switchyard/<版>/shims` で、`which npm` もその下 | 統治下(shim と hook の両方が効く) |
| shim は無いが `switchyard top` は動く | hook だけ(背景化と拒否は効くが、入れ子のコマンドは包まれない) |
| `switchyard` も plugin の複製も無い | 統治外(このセッションは管理されない) |

shim が無いのは、たいてい**そのセッションが plugin を入れる前に始まった**ため。開き直せば効く。

## 3. まとめて出す

3〜5 行で、次を日本語で書く。長い出力は貼らない。

- 判定(統治下 / hook だけ / 統治外)と、その根拠 1 つ(PATH か `which npm`)
- いまの走行と待ち(`CPU N / M 使用中`・走行 n 本・待ち m 本。待ちがあれば先頭の理由も 1 つ)
- 直近 1 日(ジョブ件数・待った件数と中央値・背景へ回した件数)
- 統治外なら、次の 1 手(セッションを開き直す / その場で包むなら `switchyard run -- <コマンド>`)
