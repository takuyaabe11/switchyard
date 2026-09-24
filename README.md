# switchyard

**A traffic controller for heavy runs across Claude Code sessions on one machine.**

When several Claude Code sessions share a laptop, they all want to run `npm test`,
`cargo build`, `playwright test` at the same time. The machine thrashes, benchmarks
become meaningless, and two sessions rewrite the same git index. switchyard hands out
CPU shares and exclusive locks (ports, the git index, anything you name) so those runs
queue instead of collide. A switchyard is where trains are sorted onto the right track,
one at a time — that is what this does for heavy runs.

You do not change how you type commands. A `PATH` shim in front of `npm`, `npx`, `node`,
`yarn`, `pnpm`, `bun`, `cargo`, `pytest`, `go`, `make` and `git` classifies each command and routes it through
switchyard automatically.

## Install

```
/plugin marketplace add takuyaabe11/switchyard
/plugin install switchyard@switchyard
```

Requires Node.js >= 20, macOS or Linux. Messages that switchyard prints while you work —
the queue notes, the hook verdicts, the reason a session is held back — are in Japanese.
Everything you type (commands, flags, `switchyard.json`) is in English. The daemon starts on demand; there is nothing
to run by hand. A daemon that never handed out a single slot shuts itself down after a
couple of quiet minutes, so a throwaway `SWITCHYARD_HOME` does not leave one behind.
Set `SWITCHYARD_IDLE_EXIT_MS=0` to keep it resident.

Once installed, every new Claude Code session gets three hooks:

| Hook | What it does |
|---|---|
| `SessionStart` | Puts `shims/` at the front of `PATH` for the session |
| `PreToolUse` (Bash) | Sends CPU-holding runs to the background; rejects bypasses that call the real binary by path |
| `Stop` | Holds the session back if one of its jobs ended in a way nobody has looked at |

## Commands

```
switchyard top                      # the whole board: what runs, what waits, why
switchyard stop                     # stop the daemon (it starts again on the next request)
switchyard restart                  # stop it and bring the current version back up
switchyard why <job>                # one job's reason for waiting
switchyard ack <job> [--session <id>] # mark a failed job as looked at
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
- `preempt`: what may be done to this job when a `measure` job reaches the head of the queue.
  `never` (the default) means the measure waits for it to finish. `pause` stops its process
  group with `SIGSTOP` and continues it when the measure is done. `throttle` drops its
  priority with `renice` and lets it keep running beside the measure. A job that shares a
  lock with the measure is never held — releasing that lock is what the measure is waiting for.
  Only declare `pause` or `throttle` on work that survives being suspended: a stopped job
  still holds its locks, its memory and its open files, and a test runner inside it may hit
  its own timeout once it resumes.
- A wrapped job runs with `SWITCHYARD_IN_JOB=1` in its environment. If your own test suite
  reads that variable, do not classify the command that starts it — or strip the variable
  before the suite runs, the way this repo's `npm test` does with `env -u SWITCHYARD_IN_JOB`.
- `{cpus}` in `env` is replaced with the share the job was actually granted.

Without a `switchyard.json`, a built-in table covers the usual commands: `npm test` / `npm t` /
`npm run test*` / `npm run build*`, the same for `yarn`, `pnpm` and `bun`, `npx vitest run`, `npx jest`,
`npx playwright test`, `cargo build|test|nextest|clippy|check`, `pytest`, `go test|build` and `make`.
A script under `node_modules/.bin` (`./node_modules/.bin/vitest run`) is classified as its `npx` form.
Anything else — `python -m pytest`, `uv run pytest`, `tsc` — is not classified unless your
`switchyard.json` names it, and runs outside the queue.

`git` takes the repository's index lock for the subcommands that write the index: `commit`, `merge`,
`rebase`, `cherry-pick`, `stash`, `am`, `add`, `rm`, `mv`, `reset`, `restore`, `checkout`, `switch`,
`pull` and `revert`. Global options before the subcommand (`git -C <dir> commit`, `git -c k=v add`)
are read past, and the lock is taken on the repository they point to.

The daemon reads its capacity (`SWITCHYARD_CAPACITY`, `reserve` in `~/.switchyard/config.json`) when it
starts. After changing either, run `switchyard restart`.

A part that carries `--version`, `--help`, `--list` or `--dry-run` (or ends in `-V`, `-h`, `-n`)
is never classified: it asks a question instead of running work, so `make --version` and
`npx playwright test --list` stay out of the queue.

## Turning it off, and taking it out

switchyard installs three hooks, and two of them can stop you: `PreToolUse` refuses a
command that calls a shimmed binary by path or overrides the environment to get past the shim, and `Stop` holds the session back while a job
of yours ended in a way nobody has looked at. The ways out:

| Want | Do |
|---|---|
| Let a blocked session end | `switchyard ack <job>` for each job it names. From your own terminal this finds the session by job id; from a Claude session it only acks that session's jobs. An id that is not waiting to be acked is reported as an error |
| Silence every hook for one session | `SWITCHYARD_THINKER=1` in the environment |
| Stop the daemon | `switchyard stop` (it starts again on the next request) |
| Run one command outside the queue | `switchyard run --class quick -- <command>`. The hook refuses the other ways around the shim for a command it would queue: calling a shimmed binary by path (`/usr/local/bin/npm test`), replacing `PATH` without keeping `$PATH`, `env -i`, and setting `SWITCHYARD_IN_JOB` or `SWITCHYARD_HELD_LOCKS` |
| Remove it | `/plugin uninstall switchyard@switchyard`, then `switchyard stop`, then delete the `export PATH=.../shims:"$PATH"` line from the file Claude Code uses for session environment (`CLAUDE_ENV_FILE`), and `rm -rf ~/.switchyard` |

Uninstalling the plugin does not stop a running daemon and does not remove the `PATH` line,
so do those two by hand.

## What it writes down

Everything lives under `~/.switchyard` (or `SWITCHYARD_HOME`).

| File | Holds |
|---|---|
| `state.json` | What runs and waits right now |
| `events.jsonl` | Every decision, every job: **the full command string**, the repo path, the session id, exit codes, durations |
| `hooks.jsonl` | Every `PreToolUse` verdict, with the command string and the working directory |
| `unmanaged.jsonl` | Runs that happened while the daemon was unreachable |

Commands are stored verbatim, so anything you type on a command line — including a secret
passed as an argument — ends up in `events.jsonl`. The journals are capped: past 8MB the
current one is rolled to `<name>.1` and a new one starts, so at most two generations are
kept. Nothing is sent anywhere; these files never leave the machine.

### Why the tests ship with it

switchyard sits in front of every command you type, so you should be able to check it
rather than trust it. `test/`, `testkit/` and `scripts/` are part of the plugin on purpose:
`npm test` runs the whole suite against the copy you installed, and `node scripts/mutate.mjs core`
breaks the scheduler one rule at a time to show that the tests actually catch it. They add
about 360KB. The package is marked `private` because it is installed as a Claude Code
plugin from git, not published to npm — that flag only stops an accidental `npm publish`.

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

コマンドの打ち方は変えない。`npm` / `npx` / `node` / `yarn` / `pnpm` / `bun` / `cargo` / `pytest` / `go` / `make` /
`git` の前に入る `PATH` の shim が、打たれたコマンドを分類して自動で switchyard に通す。

## 導入

```
/plugin marketplace add takuyaabe11/switchyard
/plugin install switchyard@switchyard
```

必要なのは Node.js 20 以上、macOS か Linux。デーモンは必要になった時に自分で起動する。
手で立ち上げるものはない。一度も割り振りを出していないデーモンは、静かなまま数分たつと自分で終わる
(使い捨ての `SWITCHYARD_HOME` でデーモンが残らないようにするため)。常駐させたいときは
`SWITCHYARD_IDLE_EXIT_MS=0`。

入れると、新しいセッションごとに 3 つの hook が付く。

| Hook | すること |
|---|---|
| `SessionStart` | そのセッションの `PATH` の先頭に `shims/` を足す |
| `PreToolUse` (Bash) | CPU を持つ走行を背景実行に回す。本物の実行ファイルをパスで直に呼ぶ抜け道を拒否する |
| `Stop` | そのセッションのジョブに、まだ誰も確かめていない終わり方があれば止まるのを差し戻す |

## コマンド

```
switchyard top                      # 盤面全体。何が走り、何が待ち、なぜか
switchyard stop                     # デーモンを止める(次の要求で自動的に起動し直す)
switchyard restart                  # 止めて、いまの版で立て直す
switchyard why <job>                # 1 本の待ちの理由
switchyard ack <job> [--session <id>] # 失敗したジョブを確認済みにする
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
- `preempt`: 計測が待ち列の先頭に立ったとき、このジョブに何をしてよいか。
  `never`(既定)は「何もしない」。計測はこのジョブが終わるのを待つ。
  `pause` はプロセスグループを `SIGSTOP` で止め、計測が終わったら動かし直す。
  `throttle` は `renice` で優先度を下げ、計測の隣で走り続けさせる。
  計測と同じ鍵を持つジョブは止めない —— その鍵が返るのを計測が待っているため。
  `pause` / `throttle` を宣言するのは、中断に耐える走行だけにする。止まったジョブは鍵もメモリも
  開いたファイルも握ったままで、中のテストランナーは動き出した後に自分のタイムアウトを踏みうる。
- 包まれたジョブの環境には `SWITCHYARD_IN_JOB=1` が立つ。自分のテストがその変数を読むなら、
  それを起こすコマンドは分類しないこと。あるいは走らせる前に変数を落とす(この repo の `npm test` は
  `env -u SWITCHYARD_IN_JOB` で落としている)。
- `env` の中の `{cpus}` は、そのジョブに実際に渡された取り分に置き換わる。

`switchyard.json` が無ければ、組み込みの既定表がよくあるコマンドを見る: `npm test` / `npm t` /
`npm run test*` / `npm run build*` と、`yarn` / `pnpm` / `bun` の同じ形、`npx vitest run`・`npx jest`・
`npx playwright test`、`cargo build|test|nextest|clippy|check`、`pytest`、`go test|build`、`make`。
`node_modules/.bin` の下のスクリプト(`./node_modules/.bin/vitest run`)は `npx` の形として分類する。
それ以外(`python -m pytest`・`uv run pytest`・`tsc` など)は、`switchyard.json` で名指ししない限り分類されず、順番待ちの外で走る。

`git` は index を書き換えるサブコマンド(`commit`・`merge`・`rebase`・`cherry-pick`・`stash`・`am`・
`add`・`rm`・`mv`・`reset`・`restore`・`checkout`・`switch`・`pull`・`revert`)のとき、その repo の index の鍵を取る。
サブコマンドの前の大域オプション(`git -C <dir> commit`・`git -c k=v add`)は読み飛ばし、鍵はそれが指す repo のものを取る。

デーモンは容量(`SWITCHYARD_CAPACITY`・`~/.switchyard/config.json` の `reserve`)を起動時に読む。変えたら `switchyard restart`。

`--version` / `--help` / `--list` / `--dry-run` を含む部分(と、末尾が `-V` / `-h` / `-n` の部分)は
どの表にも当てない。走らせずに訊いているだけなので、`make --version` や
`npx playwright test --list` は順番待ちに乗らない。

## 切る・外す

switchyard は hook を 3 つ入れる。そのうち 2 つは作業を止めうる。`PreToolUse` は shim の語の実行ファイルをパスで直に呼ぶコマンドと、環境変数で shim を素通りさせるコマンドを拒否し、`Stop` は自分のジョブに誰も見ていない終わり方があるとセッションの終了を差し戻す。逃げ道:

| したいこと | すること |
|---|---|
| 差し戻されたセッションを終わらせる | 挙がったジョブごとに `switchyard ack <job>`。人の端末からはジョブ id でセッションを探す。Claude のセッションからは自分のセッションのジョブだけ。確認待ちに無い id はエラーになる |
| このセッションだけ hook を全部黙らせる | 環境変数 `SWITCHYARD_THINKER=1` |
| デーモンを止める | `switchyard stop`(次の要求で起動し直す) |
| 1 本だけ順番待ちの外で走らせる | `switchyard run --class quick -- <コマンド>` で包む |
| 外す | `/plugin uninstall switchyard@switchyard` の後、`switchyard stop`、Claude Code がセッションの環境に使うファイル(`CLAUDE_ENV_FILE`)から `export PATH=.../shims:"$PATH"` の行を消し、`rm -rf ~/.switchyard` |

plugin を外しても、走っているデーモンは止まらず、`PATH` の行も消えない。その 2 つは手で行う。

## 何が記録されるか

置き場は `~/.switchyard`(`SWITCHYARD_HOME` で変えられる)。

| ファイル | 中身 |
|---|---|
| `state.json` | いま走っているもの・待っているもの |
| `events.jsonl` | すべての決定とジョブ。**コマンドの全文**・repo のパス・セッション id・終了コード・所要時間 |
| `hooks.jsonl` | `PreToolUse` の判断。コマンドの文字列と作業ディレクトリつき |
| `unmanaged.jsonl` | デーモンに届かない間に走ったもの |

コマンドはそのままの文字列で残る。引数に渡した秘密も `events.jsonl` に入る。記録には上限があり、8MB を超えると `<名前>.1` へ回して新しく始めるので、残るのは 2 世代まで。どこにも送信しない。機械の外へは出ない。

### テストを同梱している理由

switchyard は打つコマンドの前に必ず立つ。信じるのではなく確かめられる方がよい。`test/` と
`testkit/` と `scripts/` を plugin に入れてあるのは意図的で、入れた複製に対してそのまま
`npm test` で全件が回り、`node scripts/mutate.mjs core` は割り振りの規則を 1 つずつ壊して
「テストが本当に捕まえるか」を見せる。大きさは約 360KB。`package.json` の `private` は、
これが npm ではなく git 経由の Claude Code plugin として配られるため —— 誤って
`npm publish` しないための印で、それ以上の意味は無い。

## エージェントに知らせる

switchyard は `AGENTS.md` や `CLAUDE.md` を自動では書き換えない。セッションに順番待ちを
理解させたければ、[docs/agents-snippet.md](docs/agents-snippet.md) の一節を自分で貼る。

## ライセンス

MIT。[LICENSE](LICENSE) を見る。
