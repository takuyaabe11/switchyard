# switchyard

**A traffic controller for heavy runs across Claude Code sessions on one machine.**

When several Claude Code sessions share a laptop, they all want to run `npm test`,
`cargo build`, `playwright test` at the same time. The machine thrashes, benchmarks
become meaningless, and two sessions rewrite the same git index. switchyard hands out
CPU shares and exclusive locks (ports, the git index, anything you name) so those runs
queue instead of collide. A switchyard is where trains are sorted onto the right track,
one at a time — that is what this does for heavy runs.

You do not change how you type commands. A `PATH` shim in front of `npm`, `npx`, `node`,
`cargo`, `pytest`, `go`, `make` and `git` classifies each command and routes it through
switchyard automatically.

## Install

```
/plugin marketplace add takuyaabe11/switchyard
/plugin install switchyard@switchyard
```

Requires Node.js >= 20, macOS or Linux. The daemon starts on demand; there is nothing
to run by hand.

Once installed, every new Claude Code session gets three hooks:

| Hook | What it does |
|---|---|
| `SessionStart` | Puts `shims/` at the front of `PATH` for the session |
| `PreToolUse` (Bash) | Sends CPU-holding runs to the background; rejects bypasses that call the real binary by path |
| `Stop` | Holds the session back if one of its jobs ended in a way nobody has looked at |

## Commands

```
switchyard top                      # the whole board: what runs, what waits, why
switchyard why <job>                # one job's reason for waiting
switchyard ack <job>                # mark a failed job as looked at
switchyard run --why "..." -- <cmd> # run something through switchyard explicitly
switchyard probe <seconds> -- <cmd> # measure a command to pick cpus/class
switchyard replay [--since 7d]      # re-run past decisions against a config
switchyard report [--since 7d]      # aggregate decisions and hook verdicts
```

`switchyard run` flags: `--profile <name>`, `--class quick|batch|measure`,
`--cpus 4` or `--cpus 2..10` (`0` means a locks-only job), `--lock <name>` (repeatable),
`--preempt pause|throttle|never`.

## Per-project configuration

Drop a `switchyard.json` at the repo root to classify that project's commands:

```json
{
  "profiles": {
    "unit": {
      "match": ["npm test", "npx vitest run*"],
      "class": "batch",
      "cpus": { "min": 2, "max": 10 },
      "env": { "VITEST_MAX_THREADS": "{cpus}" },
      "preempt": "throttle"
    },
    "e2e": {
      "match": ["npm run e2e*"],
      "class": "batch",
      "cpus": { "min": 4, "max": 4 },
      "locks": ["port:4173"],
      "preempt": "never"
    },
    "bench": {
      "match": ["npm run benchmark*"],
      "class": "measure",
      "locks": ["port:4173"]
    }
  }
}
```

- `class`: `quick` passes straight through, `batch` takes CPU and may be throttled,
  `measure` runs alone so its numbers mean something.
- `locks`: names, not files. Two jobs naming `port:4173` never overlap.
- `{cpus}` in `env` is replaced with the share the job was actually granted.

Without a `switchyard.json`, a built-in table covers the usual commands.

## Telling your agent about it

switchyard never edits your `AGENTS.md` or `CLAUDE.md`. If you want sessions to
understand the queue, paste the snippet in [docs/agents-snippet.md](docs/agents-snippet.md)
yourself.

## License

MIT. See [LICENSE](LICENSE).

---

# switchyard(日本語)

**同じマシンで動く Claude Code のセッションが、重い走行を取り合わないようにする司令塔。**

1 台のノート PC で複数のセッションが動いていると、それぞれが同時に `npm test` や
`cargo build`、`playwright test` を始める。マシンは詰まり、ベンチの数字は意味を失い、
2 つのセッションが同じ git の index を書き換える。switchyard は CPU の取り分と排他の鍵
(ポート・git の index・任意の名前)を割り振り、それらの走行をぶつけずに順番へ流す。
switchyard は操車場のこと。重い走行を 1 本ずつ、正しい線路へ振り分ける。

コマンドの打ち方は変えない。`npm` / `npx` / `node` / `cargo` / `pytest` / `go` / `make` /
`git` の前に入る `PATH` の shim が、打たれたコマンドを分類して自動で switchyard に通す。

## 導入

```
/plugin marketplace add takuyaabe11/switchyard
/plugin install switchyard@switchyard
```

必要なのは Node.js 20 以上、macOS か Linux。デーモンは必要になった時に自分で起動する。
手で立ち上げるものはない。

入れると、新しいセッションごとに 3 つの hook が付く。

| Hook | すること |
|---|---|
| `SessionStart` | そのセッションの `PATH` の先頭に `shims/` を足す |
| `PreToolUse` (Bash) | CPU を持つ走行を背景実行に回す。本物の実行ファイルをパスで直に呼ぶ抜け道を拒否する |
| `Stop` | そのセッションのジョブに、まだ誰も確かめていない終わり方があれば止まるのを差し戻す |

## コマンド

```
switchyard top                      # 盤面全体。何が走り、何が待ち、なぜか
switchyard why <job>                # 1 本の待ちの理由
switchyard ack <job>                # 失敗したジョブを確認済みにする
switchyard run --why "..." -- <cmd> # 明示的に switchyard を通して走らせる
switchyard probe <秒> -- <cmd>      # cpus / class を決めるためにコマンドを計測する
switchyard replay [--since 7d]      # 過去の決定を、今の設定でやり直して見る
switchyard report [--since 7d]      # 決定と hook の判断を集計する
```

`switchyard run` の旗: `--profile <名前>`、`--class quick|batch|measure`、
`--cpus 4` または `--cpus 2..10`(`0` は鍵だけのジョブ)、`--lock <名前>`(繰り返し可)、
`--preempt pause|throttle|never`。

## repo ごとの設定

repo の根に `switchyard.json` を置くと、その repo のコマンドの分類を決められる。
形式は上の英語側の例と同じ。

- `class`: `quick` は素通し、`batch` は CPU を取り、絞られることがある。
  `measure` は数字が意味を持つように単独で走る。
- `locks`: ファイルではなく名前。`port:4173` を名乗る 2 本は決して重ならない。
- `env` の中の `{cpus}` は、そのジョブに実際に渡された取り分に置き換わる。

`switchyard.json` が無ければ、組み込みの既定表がよくあるコマンドを見る。

## エージェントに知らせる

switchyard は `AGENTS.md` や `CLAUDE.md` を自動では書き換えない。セッションに順番待ちを
理解させたければ、[docs/agents-snippet.md](docs/agents-snippet.md) の一節を自分で貼る。

## ライセンス

MIT。[LICENSE](LICENSE) を見る。
