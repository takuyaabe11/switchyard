# switchyard

**Keeps heavy test and build runs from colliding when several Claude Code sessions share one machine.**

Run two or three Claude Code sessions on one laptop — one per worktree, or parallel agents — and sooner or later they
all start `npm test`, `cargo build` or `./gradlew test` at once. Every run slows down, a benchmark taken in the middle
means nothing, memory runs out, and two sessions trip over the same git index. switchyard puts those runs in a queue:
it hands out CPU shares, watches memory, and gives out exclusive locks (a port, the git index, any name you pick), so
heavy runs take turns instead of colliding. You keep typing commands the way you do now.

## Is it for you?

**Worth installing if** you often have more than one Claude Code session (or agent) working on the same machine *and*
they run heavy things:

- test suites that spread over several cores (Vitest, Jest, pytest-xdist, cargo test, Gradle, Maven, Go),
  builds (`cargo build`, `npx tsc`, `make`), or browser E2E runs that also need a fixed port;
- benchmarks or performance measurements whose numbers you actually compare;
- a machine with limited cores or memory, where two heavy runs at once already make things crawl.

**Probably not worth it if** you run one session at a time, or your tests take a few seconds and rarely overlap.
switchyard only helps when heavy runs would otherwise overlap; with nothing to sort, it just stays out of the way
(about 4 ms added to most Bash calls, about 60 ms to calls that name a build or test tool, about 0.15 s to each run
it queues).

**Check before you install.** `switchyard replay` reads your past Claude Code sessions (`~/.claude/projects`) and
shows how many of your past commands it would have treated as heavy runs and put in the queue, and which ones it would
have refused. It needs nothing installed and writes nothing:

```
git clone https://github.com/takuyaabe11/switchyard && cd switchyard
node bin/switchyard.mjs replay --since 14d
```

**Or try it without it doing anything.** Install it with `SWITCHYARD_OBSERVE=1` (for example in the `env` of your
Claude Code settings). It then holds nothing back, queues nothing and refuses nothing; it only writes down when heavy
runs started and ended. After a week, `switchyard report` shows how many of them actually overlapped, for how long,
across how many sessions, whether a benchmark ran beside one, and whether two runs held the same lock. If nothing
overlapped, it says so, and you can take it out with `switchyard uninstall`.

## What changes once it is installed

- **Nothing in how you or Claude type commands.** A `PATH` shim in front of `npm`, `npx`, `node`, `yarn`, `pnpm`, `bun`,
  `cargo`, `pytest`, `python`, `python3`, `uv`, `poetry`, `go`, `mvn`, `gradle`, `dotnet`, `bundle`, `rspec`, `deno`,
  `make` and `git` recognizes test and build runs and queues them. Everything else passes straight through.
- **Heavy runs take turns.** When a run has to wait, Claude runs it in the background and is told when it finishes,
  so the session is not stuck. `switchyard top` shows what runs, what waits and why.
- **A failed run is not forgotten.** If a queued run fails and nobody looks at it, the session is asked to look before
  it stops. Running the same command successfully later, or `switchyard ack <job>`, clears it.
- **A few forms are refused, with a fix.** Commands a shim cannot see (`./gradlew test`, `.venv/bin/pytest`, a tool
  called by its full path) would skip the queue, so they are refused with the exact `switchyard run -- …` to use
  instead. Claude follows it on its own.
- **Runs keep to their share.** The share a run is given reaches the tool as its thread or worker count
  (`CARGO_BUILD_JOBS`, `RUST_TEST_THREADS`, `RAYON_NUM_THREADS`, `GOMAXPROCS`, `OMP_NUM_THREADS`,
  `PYTEST_XDIST_AUTO_NUM_WORKERS` for `pytest -n auto`, and Vitest's `VITEST_MAX_THREADS`/`FORKS`/`WORKERS`). A value
  you set yourself always wins. A run that has the machine to itself gets every core, so a lone run is never slowed.
  `SWITCHYARD_THREAD_ENV=0` turns this off.
- **It learns.** After two runs of the same command it knows how much CPU and memory that run really needs and sizes
  its share to that.

## What it does, measured

On a 4-core, 16 GB machine ([0.6–0.8](docs/verification/2026-09-24-effect.md), [0.9](docs/verification/2026-09-24-throughput.md)):

- **Results come back sooner.** Three CPU-heavy suites started together all finished at about 12 s. Through
  switchyard they finished at about 4.5, 8.5 and 12 s: the average result arrived about 30% sooner, and the last one
  at about the same time.
- **Benchmarks stay meaningful.** Beside four CPU-heavy runs a fixed benchmark ran 20–50% slower and varied widely.
  Run as a `measure` job, it waited about 4 s for them to finish and then matched its alone-time.
- **Light runs are not held back for long.** A suite that mostly waits on I/O is sized down to what it uses, and idle
  cores are filled from the queue. Three such suites together took 20.4 s on average once learned (19.4 s without
  switchyard); before anything was learned, 24.4 s.
- **Heavy runs are not stacked into swap.** A run whose usual peak memory would push free memory below 10% waits until
  something ends. With nothing running, a run always starts.
- **Worker-per-core runners stay within their share.** `pytest -n auto` given 2 cores ran 2 workers instead of 4, with a
  peak of 396 MB instead of 758 MB ([details](docs/verification/2026-09-24-adopt.md)). For runs that only use CPU, the
  thread count makes no measurable difference to how long they take: the operating system already shares the cores.

## What it does not do

- It does not make the machine faster or use less CPU in total. It decides the order, so runs stop fighting.
- It does not help a single session running one thing at a time.
- The first one or two runs of a new command are handled conservatively: in the test above, 24.4 s instead of 19.4 s
  before switchyard had learned the suite.
- It only queues commands it recognizes. For others (`bazel test`, `npm run e2e`, a custom script), add them to a
  `switchyard.json`; `switchyard init` suggests entries from your own history.
- Jest, Playwright, Gradle, Maven, `make` and `dotnet` have no environment variable for their worker count, so their
  share is not passed on. Put it in `switchyard.json` yourself (`"args": ["--maxWorkers={cpus}"]`).
- The numbers above come from controlled runs on one machine, not from people's everyday use yet.
  `switchyard report` shows what it did on yours: how many runs it held back, how long they waited, what it packed in.
- macOS and Linux only (Windows through WSL).

## Install

```
/plugin marketplace add takuyaabe11/switchyard
/plugin install switchyard@switchyard
```

Requires Node.js >= 20, macOS or Linux (Windows is not supported; use WSL). Messages that switchyard prints
while you work — the queue notes, the hook verdicts, the reason a session is held back — are in English,
or in Japanese when your locale (`LANG`, `LC_ALL`, `LC_MESSAGES`) starts with `ja`. `SWITCHYARD_LANG=en` or
`SWITCHYARD_LANG=ja` picks one explicitly. The daemon starts on demand; there is nothing
to run by hand. A daemon that never handed out a single slot shuts itself down after a
couple of quiet minutes, so a throwaway `SWITCHYARD_HOME` does not leave one behind.
Set `SWITCHYARD_IDLE_EXIT_MS=0` to keep it resident.

Once installed, every new Claude Code session gets three hooks:

| Hook | What it does |
|---|---|
| `SessionStart` | Puts `shims/` at the front of `PATH` for the session |
| `PreToolUse` (Bash) | Sends a CPU-holding run to the background when it would have to wait (a queue, a measurement, a held lock, not enough free CPU); rejects bypasses that call the real binary by path. `SWITCHYARD_BACKGROUND=always` sends every heavy run to the background, `never` sends none. A small `sh`/`awk` sieve answers commands that name no heavy tool (`ls`, `git status`, `node -e`) in about 4 ms without starting Node |
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
switchyard report [--since 7d]      # aggregate decisions and hook verdicts, and what the queue saved
switchyard init [--write]           # suggest switchyard.json profiles from your past sessions in this repo
switchyard uninstall [--dry-run]    # clean up before /plugin uninstall: daemon, PATH line, ~/.switchyard
```

`switchyard run` flags: `--profile <name>`, `--class quick|batch|measure`,
`--cpus 4` or `--cpus 2..10` (`0` means a locks-only job), `--lock <name>` (repeatable),
`--preempt pause|throttle|never`.

## Per-project configuration

Drop a `switchyard.json` at the repo root to classify that project's commands. `switchyard init` reads your past
Claude Code sessions in the repo (`~/.claude/projects`), finds commands that ran repeatedly and took long but match
no profile, and prints them as profiles; `switchyard init --write` adds them to `switchyard.json` without touching
the profiles already there.

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
- `{cpus}` in `env` and `args` is replaced with the share the job was actually granted.
- `cpus.max` can be `"all"`: as many cores as the daemon has. The built-in table uses `{ "min": 2, "max": "all" }`,
  so a run alone on the machine gets all of it.

Without a `switchyard.json`, a built-in table covers the usual commands: `npm test` / `npm t` /
`npm run test*` / `npm run build*`, the same for `yarn`, `pnpm` and `bun`, `npx vitest run`, `npx jest`,
`npx playwright test`, `npx tsc`, `cargo build|test|nextest|clippy|check`, `pytest`, `python -m pytest`,
`uv run pytest`, `poetry run pytest`, `go test|build`, `mvn test|verify|package|install`, `gradle test|build|check`,
`dotnet test|build`, `bundle exec rspec`, `rspec`, `deno test` and `make`.
A script under `node_modules/.bin` (`./node_modules/.bin/vitest run`) is classified as its `npx` form.
A run that keeps watching (`--watch`, `--watchAll`, `tsc -w`) is never classified: it would hold its CPU share forever.
Anything else is not classified unless your `switchyard.json` names it, and runs outside the queue.

Some heavy runs cannot be seen by a shim: `./gradlew test` and `./mvnw verify` (scripts called by path), tools inside a
Python virtualenv (`.venv/bin/pytest`), and `pytest` or `python -m pytest` after `source .venv/bin/activate` (the
virtualenv comes before the shims on `PATH`). `PreToolUse` refuses these and asks for `switchyard run -- <command>`,
which puts them in the queue. Scripts under `node_modules/.bin` go through the `node` shim and need nothing.

`git` takes the repository's index lock for the subcommands that write the index: `commit`, `merge`,
`rebase`, `cherry-pick`, `stash`, `am`, `add`, `rm`, `mv`, `reset`, `restore`, `checkout`, `switch`,
`pull` and `revert`. Global options before the subcommand (`git -C <dir> commit`, `git -c k=v add`)
are read past, and the lock is taken on the repository they point to.

The daemon reads its capacity (`SWITCHYARD_CAPACITY`, `reserve` in `~/.switchyard/config.json`) when it
starts. After changing either, run `switchyard restart`.

A part that carries `--version`, `--help`, `--list` or `--dry-run` (or ends in `-V`, `-h`, `-n`)
is never classified: it asks a question instead of running work, so `make --version` and
`npx playwright test --list` stay out of the queue.

## Updating

switchyard is installed from its own marketplace, and Claude Code does not auto-update third-party
marketplaces by default. Claude Code only sees a new release when the `version` in
`plugin.json` goes up. To update by hand:

```
/plugin marketplace update switchyard
/reload-plugins
```

The same works in the VS Code extension, where `/plugins` opens the Manage plugins dialog.
After an update the daemon that is already running keeps the old version; the next session says so,
and `switchyard restart` brings the new one up. `PATH` lines that point at the old install are
removed by the next `SessionStart`.

`SessionStart` compares this version with the one published on GitHub, at most once a day, and says when a newer one
is out. Set `SWITCHYARD_UPDATE_CHECK=0` (for example in the `env` of your Claude Code settings) to turn that off. What
changed in each release is in [CHANGELOG.md](CHANGELOG.md).

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
| Watch without acting | `SWITCHYARD_OBSERVE=1`: nothing is held back, queued or refused; `switchyard report` shows what would have happened |
| Remove it | `switchyard uninstall` first (it stops the daemon, removes the shims `PATH` line from the session env files, and deletes `~/.switchyard`; `--dry-run` shows what it would do, `--keep-logs` keeps the logs), then `/plugin uninstall switchyard@switchyard`, then reopen open sessions |

`/plugin uninstall` alone does not stop a running daemon and does not remove the `PATH` line, so run
`switchyard uninstall` before it. It only deletes files switchyard wrote: if `~/.switchyard` (or `SWITCHYARD_HOME`)
holds anything else, it deletes nothing there and lists what it found.

## What it writes down

Everything lives under `~/.switchyard` (or `SWITCHYARD_HOME`), readable by you only (the directory is 0700, the files 0600).

| File | Holds |
|---|---|
| `state.json` | What runs and waits right now |
| `events.jsonl` | Every decision, every job: **the full command string**, the repo path, the session id, exit codes, durations |
| `hooks.jsonl` | Every `PreToolUse` verdict, with the command string and the working directory |
| `unmanaged.jsonl` | Runs that happened while the daemon was unreachable |
| `observed.jsonl` | In observe-only mode, when each heavy run started and ended |

Commands are stored verbatim, so anything you type on a command line — including a secret
passed as an argument — ends up in `events.jsonl`. The journals are capped: past 8MB the
current one is rolled to `<name>.1` and a new one starts, so at most two generations are
kept. Nothing is sent anywhere; these files never leave the machine. The only network access is the update check,
which fetches `plugin.json` from GitHub at most once a day and sends nothing else (`SWITCHYARD_UPDATE_CHECK=0` turns
it off).

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

**同じマシンで複数の Claude Code のセッションが動くとき、重いテストやビルドがぶつからないようにする。**

1 台のノート PC で Claude Code のセッションを 2〜3 本動かしていると(worktree ごとに 1 本、あるいは並列のエージェント)、
いつかは全部が同時に `npm test` や `cargo build`、`./gradlew test` を始める。どの走行も遅くなり、その最中に取ったベンチの
数字は意味を失い、メモリが尽き、2 つのセッションが同じ git の index で衝突する。switchyard はそれらの走行を順番待ちに
乗せる。CPU の取り分を割り振り、メモリを見て、排他の鍵(ポート・git の index・好きな名前)を渡すので、重い走行は
ぶつからずに順番に走る。コマンドの打ち方は今のまま。

## 向いている人・向いていない人

**入れる価値があるのは**、同じマシンで Claude Code のセッション(やエージェント)を 2 本以上動かすことが多く、*かつ*
重いものを走らせる人:

- 複数のコアを使うテスト(Vitest・Jest・pytest-xdist・cargo test・Gradle・Maven・Go)、ビルド(`cargo build`・`npx tsc`・`make`)、
  決まったポートも要るブラウザの E2E
- 数字を比べるベンチマークや性能の計測
- コア数やメモリが少なく、重い走行が 2 本重なるだけで遅くなる機械

**たぶん要らないのは**、セッションを 1 本ずつしか動かさない人や、テストが数秒で終わってめったに重ならない人。
switchyard が効くのは、重い走行が重なりそうなときだけ。振り分けるものが無ければ邪魔をしないだけ
(たいていの Bash の呼び出しに約 4ms、ビルドやテストの道具の名前を含む呼び出しに約 60ms、順番待ちに乗せた走行 1 本に約 0.15 秒
足される)。

**入れる前に確かめる。** `switchyard replay` は過去の Claude Code のセッション(`~/.claude/projects`)を読み、自分の
コマンドのうち何本を重い走行として順番待ちに乗せ、どれを拒否していたかを出す。入れなくても動き、何も書かない:

```
git clone https://github.com/takuyaabe11/switchyard && cd switchyard
node bin/switchyard.mjs replay --since 14d
```

**何もさせずに試す。** `SWITCHYARD_OBSERVE=1` を付けて入れる(Claude Code の設定の `env` など)。switchyard は何も止めず、
並べず、拒否せず、重い走行の始まりと終わりを記録するだけになる。1 週間ほどたったら `switchyard report` で、実際に何本が
重なっていたか・どれだけの時間か・何セッションにまたがっていたか・ベンチが重い走行の横で走っていないか・同じ鍵を持つ走行が
重なっていないかが分かる。重なりが無ければそう出るので、`switchyard uninstall` で外せばよい。

## 入れると何が変わるか

- **自分も Claude も、コマンドの打ち方は変わらない。** `npm` / `npx` / `node` / `yarn` / `pnpm` / `bun` / `cargo` / `pytest` /
  `python` / `python3` / `uv` / `poetry` / `go` / `mvn` / `gradle` / `dotnet` / `bundle` / `rspec` / `deno` / `make` / `git` の前に入る
  `PATH` の shim が、テストやビルドの走行を見分けて順番待ちに乗せる。それ以外はそのまま通る。
- **重い走行は順番に走る。** 待つことになる走行は、Claude が背景で走らせ、終わったら知らせを受けるので、セッションは
  止まらない。`switchyard top` で、何が走り、何が待ち、なぜかが見える。
- **失敗した走行を見落とさない。** 順番待ちに乗った走行が失敗して誰も見ていなければ、セッションは止まる前にそれを見るよう
  求められる。後で同じコマンドが成功するか、`switchyard ack <job>` で消える。
- **いくつかの形は拒否し、直し方を示す。** shim から見えない形(`./gradlew test`・`.venv/bin/pytest`・フルパスで呼ぶ道具)は
  順番待ちを素通りするので拒否し、代わりに使う `switchyard run -- …` をそのまま示す。Claude は自分でそれに従う。
- **走行は自分の取り分を守る。** 割り当てたコア数を、道具が読むスレッド数・ワーカー数として渡す(`CARGO_BUILD_JOBS`・
  `RUST_TEST_THREADS`・`RAYON_NUM_THREADS`・`GOMAXPROCS`・`OMP_NUM_THREADS`・`pytest -n auto` の `PYTEST_XDIST_AUTO_NUM_WORKERS`・
  Vitest の `VITEST_MAX_THREADS`/`FORKS`/`WORKERS`)。自分で決めた値がいつも勝つ。機械を独り占めしている走行には全コアを
  渡すので、単独の走行が遅くなることはない。`SWITCHYARD_THREAD_ENV=0` で止める。
- **学ぶ。** 同じコマンドを 2 回走らせると、その走行が実際に使う CPU とメモリが分かり、取り分をそれに合わせる。

## 実測で何をするか

4 コア・16GB の機械で([0.6〜0.8](docs/verification/2026-09-24-effect.md)・[0.9](docs/verification/2026-09-24-throughput.md)):

- **結果が早く返る。** CPU を使うテストの全件を 3 本同時に始めると、3 本とも約 12 秒で終わった。switchyard を通すと約 4.5 秒・
  8.5 秒・12 秒で終わり、結果が返るまでの平均は約 30% 早く、最後の 1 本はほぼ同じ時刻だった。
- **ベンチの数字が意味を保つ。** CPU を使う走行 4 本の横では、固定量のベンチが 20〜50% 遅くなり、ばらつきも大きかった。
  `measure` として走らせると、4 本が終わるまで約 4 秒待ってから、単独と同じ数字で走った。
- **軽い走行を長く待たせない。** 入出力の待ちが中心の全件は、実際に使う分まで取り分を縮め、空いているコアには待ち列から
  詰めて入れる。そうした全件を 3 本同時に走らせると、学んだ後は平均 20.4 秒(switchyard なしで 19.4 秒)、学ぶ前は 24.4 秒だった。
- **重い走行を重ねてスワップさせない。** いつものピークのメモリを足すと空きが全体の 10% を割る走行は、何かが終わるまで待つ。
  何も走っていなければ必ず走る。
- **コアごとにワーカーを立てる道具を、取り分の中に収める。** 2 コアを割り当てた `pytest -n auto` は、ワーカーが 4 から 2 に、
  ピークのメモリが 758MB から 396MB になった([詳細](docs/verification/2026-09-24-adopt.md))。CPU だけを使う走行では、
  スレッド数を変えても所要は測れるほど変わらなかった(OS がもともとコアを分け合っているため)。

## しないこと

- 機械を速くしたり、CPU の総量を減らしたりはしない。順番を決めて、走行同士が取り合わないようにするだけ。
- 1 本のセッションで 1 つずつ走らせる使い方には効かない。
- 新しいコマンドの最初の 1〜2 回は控えめに扱う。上の実験では、学ぶ前は 19.4 秒のところが 24.4 秒だった。
- 順番待ちに乗せるのは見分けられるコマンドだけ。それ以外(`bazel test`・`npm run e2e`・自作のスクリプト)は `switchyard.json`
  に書く。`switchyard init` が自分の履歴から候補を出す。
- Jest・Playwright・Gradle・Maven・`make`・`dotnet` にはワーカー数の環境変数が無いので、取り分は伝わらない。
  `switchyard.json` に自分で書く(`"args": ["--maxWorkers={cpus}"]`)。
- 上の数字は 1 台の機械で条件をそろえて測ったもので、まだ普段使いの利用者のデータではない。自分の機械で何をしたかは
  `switchyard report` で見られる(待たせた本数・待ち時間・詰めて入れた本数など)。
- macOS と Linux だけ(Windows は WSL で)。

## 導入

```
/plugin marketplace add takuyaabe11/switchyard
/plugin install switchyard@switchyard
```

必要なのは Node.js 20 以上、macOS か Linux(Windows は非対応。WSL なら動く)。作業中に switchyard が出す文言(待ちの知らせ・hook の判断・
差し戻しの理由)は英語で、ロケール(`LANG`・`LC_ALL`・`LC_MESSAGES`)が `ja` で始まれば日本語になる。
`SWITCHYARD_LANG=ja` / `SWITCHYARD_LANG=en` で明示的に選べる。デーモンは必要になった時に自分で起動する。
手で立ち上げるものはない。一度も割り振りを出していないデーモンは、静かなまま数分たつと自分で終わる
(使い捨ての `SWITCHYARD_HOME` でデーモンが残らないようにするため)。常駐させたいときは
`SWITCHYARD_IDLE_EXIT_MS=0`。

入れると、新しいセッションごとに 3 つの hook が付く。

| Hook | すること |
|---|---|
| `SessionStart` | そのセッションの `PATH` の先頭に `shims/` を足す |
| `PreToolUse` (Bash) | CPU を持つ走行が待たされる見込み(待ち列・計測・使われている鍵・CPU の空き不足)のときだけ背景実行に回す。本物の実行ファイルをパスで直に呼ぶ抜け道を拒否する。`SWITCHYARD_BACKGROUND=always` で重い走行を必ず背景へ、`never` で回さない。重い道具の名前を含まないコマンド(`ls`・`git status`・`node -e`)は、`sh`/`awk` のふるいが Node を起動せずに約 4ms で通す |
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
switchyard report [--since 7d]      # 決定と hook の判断、順番待ちの効果を集計する
switchyard init [--write]           # この repo の過去のセッションから switchyard.json の profile を提案する
switchyard uninstall [--dry-run]    # /plugin uninstall の前の後片付け。デーモン・PATH の行・~/.switchyard
```

`switchyard run` の旗: `--profile <名前>`、`--class quick|batch|measure`、
`--cpus 4` または `--cpus 2..10`(`0` は鍵だけのジョブ)、`--lock <名前>`(繰り返し可)、
`--preempt pause|throttle|never`。

## repo ごとの設定

repo の根に `switchyard.json` を置くと、その repo のコマンドの分類を決められる。`switchyard init` は、その repo での
過去の Claude Code のセッション(`~/.claude/projects`)を読み、繰り返し走っていて長いのにどの profile にも当たらない
コマンドを profile として出す。`switchyard init --write` で、既にある profile を変えずに `switchyard.json` へ書き足す。
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
- `env` と `args` の中の `{cpus}` は、そのジョブに実際に渡された取り分に置き換わる。
- `cpus.max` には `"all"`(デーモンの容量いっぱい)と書ける。組み込みの既定表は `{ "min": 2, "max": "all" }` なので、
  機械で単独の走行は全部を使える。

`switchyard.json` が無ければ、組み込みの既定表がよくあるコマンドを見る: `npm test` / `npm t` /
`npm run test*` / `npm run build*` と、`yarn` / `pnpm` / `bun` の同じ形、`npx vitest run`・`npx jest`・
`npx playwright test`・`npx tsc`、`cargo build|test|nextest|clippy|check`、`pytest`・`python -m pytest`・
`uv run pytest`・`poetry run pytest`、`go test|build`、`mvn test|verify|package|install`、`gradle test|build|check`、
`dotnet test|build`、`bundle exec rspec`・`rspec`、`deno test`、`make`。
`node_modules/.bin` の下のスクリプト(`./node_modules/.bin/vitest run`)は `npx` の形として分類する。
見張り続ける走行(`--watch`・`--watchAll`・`tsc -w`)は分類しない。包むと CPU の取り分を握ったまま終わらない。
それ以外は、`switchyard.json` で名指ししない限り分類されず、順番待ちの外で走る。

shim から見えない重い走行もある: パスで呼ぶスクリプト(`./gradlew test`・`./mvnw verify`)、Python の仮想環境の中の
道具(`.venv/bin/pytest`)、`source .venv/bin/activate` の後の `pytest`・`python -m pytest`(仮想環境が `PATH` で shim より前に
来る)。`PreToolUse` はこれらを拒否し、`switchyard run -- <コマンド>` で包むよう案内する(包めば順番待ちに乗る)。
`node_modules/.bin` の下のスクリプトは `node` の shim を通るので、何もしなくてよい。

`git` は index を書き換えるサブコマンド(`commit`・`merge`・`rebase`・`cherry-pick`・`stash`・`am`・
`add`・`rm`・`mv`・`reset`・`restore`・`checkout`・`switch`・`pull`・`revert`)のとき、その repo の index の鍵を取る。
サブコマンドの前の大域オプション(`git -C <dir> commit`・`git -c k=v add`)は読み飛ばし、鍵はそれが指す repo のものを取る。

デーモンは容量(`SWITCHYARD_CAPACITY`・`~/.switchyard/config.json` の `reserve`)を起動時に読む。変えたら `switchyard restart`。

`--version` / `--help` / `--list` / `--dry-run` を含む部分(と、末尾が `-V` / `-h` / `-n` の部分)は
どの表にも当てない。走らせずに訊いているだけなので、`make --version` や
`npx playwright test --list` は順番待ちに乗らない。

## 更新する

switchyard は自前のマーケットプレイスから入るので、Claude Code は既定ではそれを自動で更新しない。
Claude Code が新しい版に気づくのは、`plugin.json` の `version` が上がったときだけ。手で更新するには:

```
/plugin marketplace update switchyard
/reload-plugins
```

VS Code の拡張でも同じで、`/plugins` で Manage plugins の画面が開く。
更新しても、走っているデーモンは古い版のまま残る。次のセッションがそれを知らせるので、`switchyard restart` で入れ替える。
古い置き場を指す `PATH` の行は、次の `SessionStart` が取り除く。

`SessionStart` がいまの版と GitHub で公開されている版を 1 日に 1 回まで比べ、新しい版が出ていれば知らせる。
止めるには `SWITCHYARD_UPDATE_CHECK=0` を設定する(Claude Code の設定の `env` など)。各版の変更は [CHANGELOG.md](CHANGELOG.md) にある。

## 切る・外す

switchyard は hook を 3 つ入れる。そのうち 2 つは作業を止めうる。`PreToolUse` は shim の語の実行ファイルをパスで直に呼ぶコマンドと、環境変数で shim を素通りさせるコマンドを拒否し、`Stop` は自分のジョブに誰も見ていない終わり方があるとセッションの終了を差し戻す。逃げ道:

| したいこと | すること |
|---|---|
| 差し戻されたセッションを終わらせる | 挙がったジョブごとに `switchyard ack <job>`。人の端末からはジョブ id でセッションを探す。Claude のセッションからは自分のセッションのジョブだけ。確認待ちに無い id はエラーになる |
| このセッションだけ hook を全部黙らせる | 環境変数 `SWITCHYARD_THINKER=1` |
| デーモンを止める | `switchyard stop`(次の要求で起動し直す) |
| 1 本だけ順番待ちの外で走らせる | `switchyard run --class quick -- <コマンド>` で包む |
| 何もさせずに見るだけにする | `SWITCHYARD_OBSERVE=1`。止めも並べも拒否もしない。入れていれば何が起きたかは `switchyard report` で分かる |
| 外す | 先に `switchyard uninstall`(デーモンを止め、セッションの環境ファイルから shims の `PATH` の行を取り除き、`~/.switchyard` を消す。`--dry-run` ですることだけを見る、`--keep-logs` で記録を残す)。その後 `/plugin uninstall switchyard@switchyard`、開いているセッションを開き直す |

`/plugin uninstall` だけでは、走っているデーモンは止まらず、`PATH` の行も消えない。先に `switchyard uninstall` を走らせる。
消すのは switchyard が書いたファイルだけで、`~/.switchyard`(か `SWITCHYARD_HOME`)に他のものがあれば、そこでは何も消さずに
見つけたものを挙げる。

## 何が記録されるか

置き場は `~/.switchyard`(`SWITCHYARD_HOME` で変えられる)。持ち主だけが読める(ディレクトリは 0700、ファイルは 0600)。

| ファイル | 中身 |
|---|---|
| `state.json` | いま走っているもの・待っているもの |
| `events.jsonl` | すべての決定とジョブ。**コマンドの全文**・repo のパス・セッション id・終了コード・所要時間 |
| `hooks.jsonl` | `PreToolUse` の判断。コマンドの文字列と作業ディレクトリつき |
| `unmanaged.jsonl` | デーモンに届かない間に走ったもの |
| `observed.jsonl` | 観察だけのモードで、重い走行が始まった時刻と終わった時刻 |

コマンドはそのままの文字列で残る。引数に渡した秘密も `events.jsonl` に入る。記録には上限があり、8MB を超えると `<名前>.1` へ回して新しく始めるので、残るのは 2 世代まで。どこにも送信しない。機械の外へは出ない。外へ問い合わせるのは更新の確認だけで、1 日に 1 回まで GitHub から `plugin.json` を取ってくる以外は何も送らない(`SWITCHYARD_UPDATE_CHECK=0` で止まる)。

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
