# switchyard

**Keeps heavy test and build runs from colliding when several Claude Code sessions share one machine.**

Run two or three Claude Code sessions on one laptop — one per worktree, or parallel agents — and sooner or later they
all start `npm test`, `cargo build` or `./gradlew test` at once. Every run slows down, a benchmark taken in the middle
means nothing, and memory runs out. switchyard puts those runs in a queue:
it hands out CPU shares, watches memory, and gives out exclusive locks (a port, a database, any name you pick), so
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
  `make`, `xcodebuild`, `bazel`, `bazelisk`, `nx`, `turbo`, `php`, `composer`, `phpunit`, `pest` and `paratest` recognizes test and build runs and queues them. Everything else passes straight through. (`git` has a shim
  too, but does nothing unless you turn it on; see below.)
- **Heavy runs take turns.** When a run has to wait, Claude runs it in the background and is told when it finishes,
  so the session is not stuck. `switchyard top` shows what runs, what waits and why.
- **A failed run is not forgotten.** If a queued run fails and nobody looks at it, you get a notice when the session
  stops (once per run; Claude is not made to do anything). Running the same command successfully later, or
  `switchyard ack <job>`, clears it. `SWITCHYARD_STOP=block` has Claude look at it before it stops instead.
- **A failure that may not be the code's fault says so.** If a run fails while the machine was saturated by other work,
  free memory ran low, the run was killed with SIGKILL, or it was paused for a measurement, Claude is told right under
  the output (`this failure may not be caused by the code: …`) and asked to re-run it on a quiet machine before
  changing code. The same clue is added to the Stop notice and counted in `switchyard report`.
- **Secrets stay out of the logs.** Values that look like secrets — `API_KEY=…`, `--password …`, `-Dx.password=…`,
  `mysql -p…`, `user:pass@` in URLs, `Authorization:` headers, and token shapes such as `sk-…`, `ghp_…`, `AKIA…` —
  are written as `***`. The command itself runs unchanged.
- **Commands a shim cannot see are wrapped for you.** `./gradlew test`, `./mvnw verify` or `.venv/bin/pytest` on a line
  of its own is rewritten to `switchyard run -- ./gradlew test` and runs in the queue. Claude Code checks permission on
  the rewritten command, so an allow rule for `./gradlew test` alone does not approve it: you are asked, or add the
  same rule for the wrapped form (`Bash(switchyard run -- ./gradlew test)`). Chained forms (`cd app && ./gradlew test`) are refused with the exact `switchyard run -- …`
  to use instead, and Claude follows it on its own. `SWITCHYARD_WRAP=0` refuses every form instead of rewriting.
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
- It only queues commands it recognizes. For others (`npm run e2e`, a custom script), add them to a
  `switchyard.json`; `switchyard init` suggests entries from your own history.
- Jest, Playwright, Gradle, Maven, `make`, `dotnet`, Xcode, Bazel, Nx, Turbo, PHPUnit, Pest and ParaTest have no environment variable for their
  worker count, so their share is not passed on. Put it in `switchyard.json` yourself (`"args": ["--maxWorkers={cpus}"]`).
- The clue on a failed run is a hint, not a diagnosis: a run can fail for its own reasons on a busy machine too.
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
| `PreToolUse` (Bash) | Sends a CPU-holding run to the background when it would have to wait (a queue, a measurement, a held lock, not enough free CPU); wraps a heavy command the shims cannot see (`./gradlew test`) in `switchyard run --`; rejects bypasses that call the real binary by path. `SWITCHYARD_BACKGROUND=always` sends every heavy run to the background, `never` sends none. A small `sh`/`awk` sieve answers commands that name no heavy tool (`ls`, `git status`, `node -e`) in about 4 ms without starting Node |
| `Stop` | Tells you when one of the session's runs ended in a way nobody has looked at (`SWITCHYARD_STOP=block` holds the session back instead) |

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
`dotnet test|build`, `bundle exec rspec`, `rspec`, `deno test`, `make`,
`xcodebuild test|build|build-for-testing|test-without-building` (the action may come after the options),
`bazel`/`bazelisk test|build|coverage`, `nx test|build|run-many|affected|run <project>:test|build` (also through
`npx`, `pnpm` or `yarn`), `turbo run test|build` (also `turbo test|build`, through `npx` or `pnpm`), `php artisan test`,
`phpunit`, `pest`, `paratest` and `composer test` (also `composer run test*`).
A script under `node_modules/.bin` (`./node_modules/.bin/vitest run`) is classified as its `npx` form, and one under
`vendor/bin` (`./vendor/bin/phpunit`, which starts through `php`) as the tool's own name.
A run that keeps watching (`--watch`, `--watchAll`, `tsc -w`) is never classified: it would hold its CPU share forever.
Anything else is not classified unless your `switchyard.json` names it, and runs outside the queue.

Some heavy runs cannot be seen by a shim: `./gradlew test` and `./mvnw verify` (scripts called by path), tools inside a
Python virtualenv (`.venv/bin/pytest`), and `pytest` or `python -m pytest` after `source .venv/bin/activate` (the
virtualenv comes before the shims on `PATH`). When one of these is the whole command, `PreToolUse` rewrites it to
`switchyard run -- <command>`, which puts it in the queue. When it is chained with other commands, it is refused with
the `switchyard run -- …` to use, since rewriting part of a chain could change what the line does. `SWITCHYARD_WRAP=0`
refuses in both cases. Scripts under `node_modules/.bin` go through the `node` shim and need nothing.

With `SWITCHYARD_GIT=1`, `git` takes the index lock for the subcommands that write the index: `commit`, `merge`,
`rebase`, `cherry-pick`, `stash`, `am`, `add`, `rm`, `mv`, `reset`, `restore`, `checkout`, `switch`,
`pull` and `revert`, so two sessions in the same working tree do not collide on `index.lock`. Global options before
the subcommand (`git -C <dir> commit`, `git -c k=v add`) are read past, and the lock is taken on the repository they
point to. Each git worktree has its own index, so sessions in separate worktrees never wait for each other. By default
(`SWITCHYARD_GIT` unset) the `git` shim hands every command straight to git.

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

With `SWITCHYARD_UPDATE_CHECK=1` (for example in the `env` of your Claude Code settings), `SessionStart` compares this
version with the one published on GitHub, at most once a day, and says when a newer one is out. It is off by default,
so switchyard makes no network requests unless you ask. What
changed in each release is in [CHANGELOG.md](CHANGELOG.md).

## Turning it off, and taking it out

switchyard installs three hooks, and one of them can stop you: `PreToolUse` refuses a command that calls a shimmed
binary by path or overrides the environment to get past the shim, and rewrites a lone `./gradlew test`-style command
to `switchyard run -- …` (Claude Code then asks for permission on the rewritten command) (`Stop` only tells you something, unless you set
`SWITCHYARD_STOP=block`). The ways out:

| Want | Do |
|---|---|
| Clear a failed run you have looked at (or let a session held by `SWITCHYARD_STOP=block` end) | `switchyard ack <job>` for each job it names. From your own terminal this finds the session by job id; from a Claude session it only acks that session's jobs. An id that is not waiting to be acked is reported as an error |
| Turn switchyard off for a session | `SWITCHYARD_OFF=1` in the environment: the hooks do nothing and the shims run the real tools directly (the old name `SWITCHYARD_THINKER=1` still works) |
| Stop the daemon | `switchyard stop` (it starts again on the next request) |
| Run one command outside the queue | `switchyard run --class quick -- <command>`. The hook refuses the other ways around the shim for a command it would queue: calling a shimmed binary by path (`/usr/local/bin/npm test`), replacing `PATH` without keeping `$PATH`, `env -i`, and setting `SWITCHYARD_IN_JOB` or `SWITCHYARD_HELD_LOCKS` |
| Keep `./gradlew test` and the like as typed | `SWITCHYARD_WRAP=0`: they are refused with the `switchyard run -- …` to use instead of being rewritten |
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
| `events.jsonl` | Every decision, every job: the command (secrets masked), the repo path, the session id, exit codes, durations |
| `hooks.jsonl` | Every `PreToolUse` verdict, with the command string and the working directory |
| `unmanaged.jsonl` | Runs that happened while the daemon was unreachable |
| `observed.jsonl` | In observe-only mode, when each heavy run started and ended |

Commands are stored with values that look like secrets replaced by `***` (see above). Masking works from patterns,
so a secret with no telltale name or shape can still get through: `SWITCHYARD_LOG_COMMANDS=none` keeps only the
first word of each command, and `SWITCHYARD_LOG_COMMANDS=full` keeps everything as typed. The journals are capped:
past 8MB the current one is rolled to `<name>.1` and a new one starts, so at most two generations are kept. Nothing is
sent anywhere; these files never leave the machine. switchyard makes no network requests unless you turn on the
update check (`SWITCHYARD_UPDATE_CHECK=1`), which then fetches `plugin.json` from GitHub at most once a day and sends
nothing else.

## Questions people ask

- **Does the daemon listen on the network?** No. It is one process per user, reachable only through a Unix socket in
  `~/.switchyard` (owner-only). It starts on demand and needs no root.
- **Does it see other things on the machine?** For memory and spare CPU, yes: it measures the whole machine, so Docker,
  emulators, IDEs and other users' processes all count. For queueing, no: only runs that go through switchyard wait
  for each other, and a run alone always starts. On a machine shared with other people, a run that has switchyard to
  itself is still given every core; set `SWITCHYARD_CAPACITY` lower, or `SWITCHYARD_THREAD_ENV=0`, if that is too much.
- **Git worktrees?** Each worktree has its own index, so the git lock (off by default) never makes them wait. Test and
  build runs from different worktrees do share the CPU queue, which is the point.
- **What does allowing `switchyard run` approve?** Allow the wrapped forms you actually use, the way you allow the
  unwrapped ones: `Bash(switchyard run -- ./gradlew test)`, or `Bash(switchyard run -- ./gradlew:*)` for every Gradle
  task. A broad `Bash(switchyard run:*)` would let any command through inside the wrapper, so `PreToolUse` narrows it:
  when what `switchyard run` wraps is not a test or build switchyard itself would queue (the built-in table, your
  `switchyard.json`, or a form like `./gradlew test`), you are asked to approve it whatever your allow rules say.
  `--profile` does not count, since it can be put in front of anything. A wrap you use on purpose (say
  `switchyard run --lock db -- docker compose up -d`) is asked about each time until a profile in `switchyard.json`
  matches it. This check stays on in observe mode; `SWITCHYARD_RUN_GUARD=0` turns it off.
- **Subagents (the Task tool)?** Covered. A subagent's Bash calls go through the same hooks and the same shims, and
  count as the parent session (checked with the real CLI: a subagent's `npm test` was queued and got a job id).
  `switchyard top` and `switchyard ack` treat them as that session; `switchyard replay` reads subagent logs too.
- **What if a run holding a lock dies?** When the `switchyard run` wrapper or shim goes away, its connection closes
  and the daemon gives back the share and the locks. If the run's processes are still alive, it keeps them until
  those processes end (listed as an orphan to ack), so a half-dead run cannot let a second one onto the same port.
- **Where does the learning live, and do repos mix?** Per repository and profile: `npm test` in one repo never sizes
  `npm test` in another. It is read from the run history in `~/.switchyard/events.jsonl`; `switchyard uninstall`
  removes it (`--keep-logs` keeps it).
- **A shared database, docker compose, Testcontainers?** switchyard has no shim for `docker`, so name what must not
  overlap. Put a lock on the test command that uses it, in `switchyard.json`:
  `"integration": { "match": ["go test ./integration/*"], "class": "batch", "locks": ["db"] }`. For the compose
  commands themselves, add a profile such as `"compose": { "match": ["docker compose up*", "docker compose down*"],
  "class": "quick", "locks": ["db"] }` and run them as `switchyard run -- docker compose up -d`; because a profile
  matches, it is not asked about. Testcontainers on random ports need no port lock; a fixed port (`port:5432`) does.
- **Inside a dev container, or WSL2?** The daemon, the shims and the measurements live where Claude Code runs. Memory
  follows the container's limit. The CPU count and how busy the CPUs are come from what that system shows, which in a
  container is usually the whole Docker VM, and in WSL2 is the WSL VM (sized by `.wslconfig`; Windows programs
  are not seen). In a container with a CPU limit, set `SWITCHYARD_CAPACITY` to that limit.
- **How much should a shared machine give it?** switchyard orders only the runs that go through it; other people's
  jobs are only counted as load. On a shared server, cap it: `SWITCHYARD_CAPACITY=8`, or `"reserve": 24` in
  `~/.switchyard/config.json` on a 32-core machine, then `switchyard restart`.
- **What does installing change in my settings?** Nothing in `settings.json`. The three hooks come from the plugin's
  own `hooks/hooks.json` and stop when the plugin is uninstalled. The only thing written outside `~/.switchyard` is one
  `PATH` line in the session environment file Claude Code provides (`CLAUDE_ENV_FILE`), which `switchyard uninstall`
  removes.
- **GPUs?** Not measured or queued. A lock name can still keep two runs off the same card: a profile with
  `"locks": ["gpu:0"]`.
- **Headless `claude -p`?** The hooks run the same way. Nothing holds a session back by default, so a scripted run
  ends normally. Sending a run to the background makes little sense when nobody waits for the notice;
  `SWITCHYARD_BACKGROUND=never` keeps every run in the foreground (it still waits its turn). This has not been tested
  at scale yet.

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
数字は意味を失い、メモリが尽きる。switchyard はそれらの走行を順番待ちに
乗せる。CPU の取り分を割り振り、メモリを見て、排他の鍵(ポート・データベース・好きな名前)を渡すので、重い走行は
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
  `python` / `python3` / `uv` / `poetry` / `go` / `mvn` / `gradle` / `dotnet` / `bundle` / `rspec` / `deno` / `make` /
  `xcodebuild` / `bazel` / `bazelisk` / `nx` / `turbo` / `php` / `composer` / `phpunit` / `pest` / `paratest` の前に入る
  `PATH` の shim が、テストやビルドの走行を見分けて順番待ちに乗せる。それ以外はそのまま通る(`git` にも shim はあるが、
  有効にしない限り何もしない。下を参照)。
- **重い走行は順番に走る。** 待つことになる走行は、Claude が背景で走らせ、終わったら知らせを受けるので、セッションは
  止まらない。`switchyard top` で、何が走り、何が待ち、なぜかが見える。
- **失敗した走行を見落とさない。** 順番待ちに乗った走行が失敗して誰も見ていなければ、セッションが止まるときにあなたに
  知らせる(1 本につき 1 回。Claude には何もさせない)。後で同じコマンドが成功するか、`switchyard ack <job>` で消える。
  `SWITCHYARD_STOP=block` にすると、止まる前に Claude に確かめさせる。
- **コードのせいではないかもしれない失敗は、そう伝える。** 他の処理で機械のコアがほぼ埋まっていた・空きメモリが減った・
  SIGKILL で止められた・計測のために一時停止された、の中で失敗した走行は、出力のすぐ下で Claude に
  (`この失敗はコードのせいではないかもしれない: …`)伝え、コードを直す前に空いた機械で走らせ直すよう促す。同じ手がかりを
  Stop の知らせにも載せ、`switchyard report` でも数える。
- **秘密を記録に残さない。** 秘密らしい値(`API_KEY=…`・`--password …`・`-Dx.password=…`・`mysql -p…`・URL の `user:pass@`・
  `Authorization:` ヘッダ・`sk-…`・`ghp_…`・`AKIA…` などのトークンの形)は `***` として記録する。走らせるコマンドは変えない。
- **shim から見えないコマンドは代わりに包む。** 1 行だけの `./gradlew test`・`./mvnw verify`・`.venv/bin/pytest` は
  `switchyard run -- ./gradlew test` に書き換えて順番待ちに乗せる。Claude Code は書き換えた後のコマンドで権限を確かめるので、
  `./gradlew test` だけを許す設定ではそのまま通らない(承認を求められる。包んだ形にも同じ許可を足す: `Bash(switchyard run -- ./gradlew test)`)。
  つないだ形(`cd app && ./gradlew test`)は拒否し、代わりに使う `switchyard run -- …` を示す。Claude は自分でそれに従う。
  `SWITCHYARD_WRAP=0` にすると、書き換えずにどの形も拒否する。
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
- 順番待ちに乗せるのは見分けられるコマンドだけ。それ以外(`npm run e2e`・自作のスクリプト)は `switchyard.json`
  に書く。`switchyard init` が自分の履歴から候補を出す。
- Jest・Playwright・Gradle・Maven・`make`・`dotnet`・Xcode・Bazel・Nx・Turbo・PHPUnit・Pest・ParaTest にはワーカー数の環境変数が無いので、取り分は伝わらない。
  `switchyard.json` に自分で書く(`"args": ["--maxWorkers={cpus}"]`)。
- 失敗に添える手がかりは見立てで、診断ではない。忙しい機械の上でも、走行はそれ自身の理由で失敗しうる。
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
| `PreToolUse` (Bash) | CPU を持つ走行が待たされる見込み(待ち列・計測・使われている鍵・CPU の空き不足)のときだけ背景実行に回す。shim から見えない重いコマンド(`./gradlew test`)を `switchyard run --` で包む。本物の実行ファイルをパスで直に呼ぶ抜け道を拒否する。`SWITCHYARD_BACKGROUND=always` で重い走行を必ず背景へ、`never` で回さない。重い道具の名前を含まないコマンド(`ls`・`git status`・`node -e`)は、`sh`/`awk` のふるいが Node を起動せずに約 4ms で通す |
| `Stop` | そのセッションの走行に、まだ誰も確かめていない終わり方があれば知らせる(`SWITCHYARD_STOP=block` なら止まるのを差し戻す) |

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
`dotnet test|build`、`bundle exec rspec`・`rspec`、`deno test`、`make`、
`xcodebuild test|build|build-for-testing|test-without-building`(オプションの後ろに置いた形も)、
`bazel`/`bazelisk test|build|coverage`、`nx test|build|run-many|affected|run <project>:test|build`(`npx`・`pnpm`・`yarn` 経由も)、
`turbo run test|build`(`turbo test|build`、`npx`・`pnpm` 経由も)、`php artisan test`・`phpunit`・`pest`・`paratest`・`composer test`
(`composer run test*` も)。
`node_modules/.bin` の下のスクリプト(`./node_modules/.bin/vitest run`)は `npx` の形として、`vendor/bin` の下のもの
(`php` を通って起動する `./vendor/bin/phpunit`)は道具の名前の形として分類する。
見張り続ける走行(`--watch`・`--watchAll`・`tsc -w`)は分類しない。包むと CPU の取り分を握ったまま終わらない。
それ以外は、`switchyard.json` で名指ししない限り分類されず、順番待ちの外で走る。

shim から見えない重い走行もある: パスで呼ぶスクリプト(`./gradlew test`・`./mvnw verify`)、Python の仮想環境の中の
道具(`.venv/bin/pytest`)、`source .venv/bin/activate` の後の `pytest`・`python -m pytest`(仮想環境が `PATH` で shim より前に
来る)。これだけの 1 行なら、`PreToolUse` が `switchyard run -- <コマンド>` に書き換え、順番待ちに乗せる。他のコマンドと
つないだ形は、一部だけを書き換えると行の意味が変わりうるので拒否し、使う `switchyard run -- …` を示す。
`SWITCHYARD_WRAP=0` ならどちらも拒否する。
`node_modules/.bin` の下のスクリプトは `node` の shim を通るので、何もしなくてよい。

`SWITCHYARD_GIT=1` にすると、`git` は index を書き換えるサブコマンド(`commit`・`merge`・`rebase`・`cherry-pick`・`stash`・`am`・
`add`・`rm`・`mv`・`reset`・`restore`・`checkout`・`switch`・`pull`・`revert`)のとき、その repo の index の鍵を取る
(同じ作業ツリーの 2 つのセッションが `index.lock` でぶつからない)。サブコマンドの前の大域オプション(`git -C <dir> commit`・
`git -c k=v add`)は読み飛ばし、鍵はそれが指す repo のものを取る。git の worktree はそれぞれ別の index を持つので、別の worktree の
セッション同士は待たない。既定(`SWITCHYARD_GIT` なし)では、`git` の shim はどのコマンドもそのまま git に渡す。

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

`SWITCHYARD_UPDATE_CHECK=1` を設定すると(Claude Code の設定の `env` など)、`SessionStart` がいまの版と GitHub で公開されている版を
1 日に 1 回まで比べ、新しい版が出ていれば知らせる。既定では無効で、頼まない限り switchyard は外へ通信しない。各版の変更は [CHANGELOG.md](CHANGELOG.md) にある。

## 切る・外す

switchyard は hook を 3 つ入れる。作業を止めうるのは `PreToolUse` だけで、shim の語の実行ファイルをパスで直に呼ぶコマンドと、環境変数で shim を素通りさせるコマンドを拒否し、1 行だけの `./gradlew test` のような形を `switchyard run -- …` に書き換える(Claude Code は書き換えた後のコマンドで承認を求める)(`Stop` は知らせるだけ。`SWITCHYARD_STOP=block` のときだけ差し戻す)。逃げ道:

| したいこと | すること |
|---|---|
| 確かめた失敗を消す(`SWITCHYARD_STOP=block` で差し戻されたセッションを終わらせる) | 挙がったジョブごとに `switchyard ack <job>`。人の端末からはジョブ id でセッションを探す。Claude のセッションからは自分のセッションのジョブだけ。確認待ちに無い id はエラーになる |
| このセッションで switchyard を止める | 環境変数 `SWITCHYARD_OFF=1`。hook は何もせず、shim は本物をそのまま走らせる(以前の名前 `SWITCHYARD_THINKER=1` も効く) |
| デーモンを止める | `switchyard stop`(次の要求で起動し直す) |
| 1 本だけ順番待ちの外で走らせる | `switchyard run --class quick -- <コマンド>` で包む |
| `./gradlew test` などを打ったとおりに保つ | `SWITCHYARD_WRAP=0`。書き換えずに拒否し、使う `switchyard run -- …` を示す |
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
| `events.jsonl` | すべての決定とジョブ。コマンド(秘密は伏せる)・repo のパス・セッション id・終了コード・所要時間 |
| `hooks.jsonl` | `PreToolUse` の判断。コマンドの文字列と作業ディレクトリつき |
| `unmanaged.jsonl` | デーモンに届かない間に走ったもの |
| `observed.jsonl` | 観察だけのモードで、重い走行が始まった時刻と終わった時刻 |

コマンドは、秘密らしい値を `***` に置き換えて残す(上を参照)。形と名前から見分けるので、手がかりの無い秘密はすり抜けうる。
`SWITCHYARD_LOG_COMMANDS=none` にすると各コマンドの最初の語だけを、`full` にすると打ったとおりを残す。記録には上限があり、8MB を超えると
`<名前>.1` へ回して新しく始めるので、残るのは 2 世代まで。どこにも送信しない。機械の外へは出ない。更新の確認(`SWITCHYARD_UPDATE_CHECK=1`)を
有効にしない限り外へ通信しない。有効にしても、1 日に 1 回まで GitHub から `plugin.json` を取ってくる以外は何も送らない。

## よく聞かれること

- **デーモンはネットワークで待ち受けるか。** しない。ユーザーごとに 1 つのプロセスで、`~/.switchyard`(持ち主だけが読める)の
  Unix ソケットからしか話せない。必要になったときに自分で起動し、root は要らない。
- **機械のほかのものは見えるか。** メモリと空いている CPU は機械全体を測るので、Docker・エミュレータ・IDE・他のユーザーの
  プロセスも数に入る。順番待ちは switchyard を通った走行同士だけで、単独の走行は必ず走る。他の人と共有する機械では、
  switchyard の中で単独の走行にも全コアを渡すので、多すぎるなら `SWITCHYARD_CAPACITY` を下げるか `SWITCHYARD_THREAD_ENV=0` にする。
- **git の worktree は。** worktree ごとに index は別なので、git の鍵(既定は無効)で待つことはない。別の worktree からのテストや
  ビルドは CPU の順番待ちを分け合う。それが狙い。
- **`switchyard run` を許すと何が通るか。** 包まない形を許すのと同じように、使う包みの形だけを許す:
  `Bash(switchyard run -- ./gradlew test)`、Gradle のタスクすべてなら `Bash(switchyard run -- ./gradlew:*)`。
  `Bash(switchyard run:*)` と広く許すと、包みの中なら何でも通ってしまうので、`PreToolUse` が絞る: `switchyard run` が包むのが、
  switchyard 自身も順番待ちに乗せるテストやビルド(既定の表・`switchyard.json`・`./gradlew test` のような形)でなければ、
  許可の設定にかかわらず承認を求める。`--profile` は何の前にも付けられるので数えない。わざと包む形
  (例: `switchyard run --lock db -- docker compose up -d`)は、`switchyard.json` の profile に当たるまで毎回承認を求められる。
  観察だけのモードでもこの確認は働く。`SWITCHYARD_RUN_GUARD=0` で止める。
- **サブエージェント(Task ツール)にも効くか。** 効く。サブエージェントの Bash も同じ hook と同じ shim を通り、親のセッションの
  走行として数える(実物で確認: サブエージェントが走らせた `npm test` が順番待ちに乗り、ジョブの id が渡った)。`switchyard top`・
  `switchyard ack` でもそのセッションとして扱い、`switchyard replay` はサブエージェントの記録も読む。
- **鍵を持った走行が落ちたらどうなるか。** `switchyard run` の包みや shim が居なくなると接続が切れ、デーモンが取り分と鍵を返す。
  走行のプロセスがまだ生きていれば、それが終わるまで持たせる(確認待ちの孤児として挙がる)。半分死んだ走行の横で、同じポートを
  使う次の走行が始まることはない。
- **学んだ値はどこにあり、repo 同士で混ざらないか。** repo と profile の組ごとに持つ。ある repo の `npm test` が、別の repo の
  `npm test` の取り分を決めることはない。`~/.switchyard/events.jsonl` の走行の記録から読み、`switchyard uninstall` で消える
  (`--keep-logs` で残す)。
- **共有のデータベース・docker compose・Testcontainers は。** `docker` には shim が無いので、重ねてはいけないものに名前を付ける。
  それを使うテストのコマンドに、`switchyard.json` で鍵を付ける:
  `"integration": { "match": ["go test ./integration/*"], "class": "batch", "locks": ["db"] }`。compose のコマンド自体は、
  `"compose": { "match": ["docker compose up*", "docker compose down*"], "class": "quick", "locks": ["db"] }` のような profile を
  足し、`switchyard run -- docker compose up -d` で走らせる(profile に当たるので承認は求められない)。
  ランダムなポートの Testcontainers にはポートの鍵は要らない。固定のポート(`port:5432`)なら要る。
- **dev container や WSL2 の中では。** デーモン・shim・測定は、Claude Code が動いている側にある。メモリはコンテナの上限に従う。
  CPU の数と忙しさはその環境が見せる値で、コンテナではたいてい Docker の VM 全体、WSL2 では WSL の VM(`.wslconfig` の大きさ。
  Windows 側のプログラムは見えない)。CPU の上限があるコンテナでは、`SWITCHYARD_CAPACITY` をその上限にする。
- **共有の機械では、どれだけ渡せばよいか。** switchyard が並べるのは自分を通った走行だけで、他の人のジョブは負荷として数えるだけ。
  共有のサーバでは上限を決める: 32 コアの機械なら `SWITCHYARD_CAPACITY=8`、または `~/.switchyard/config.json` に `"reserve": 24`。
  その後 `switchyard restart`。
- **入れると設定の何が変わるか。** `settings.json` には何も書かない。3 つの hook は plugin 自身の `hooks/hooks.json` から来て、
  plugin を外せば止まる。`~/.switchyard` の外に書くのは、Claude Code が渡すセッションの環境ファイル(`CLAUDE_ENV_FILE`)の
  `PATH` の 1 行だけで、`switchyard uninstall` が取り除く。
- **GPU は。** 測りも並べもしない。鍵の名前で、同じカードを 2 つの走行が使わないようにはできる(profile に `"locks": ["gpu:0"]`)。
- **headless の `claude -p` では。** hook は同じように動く。既定では何もセッションを差し戻さないので、スクリプトの走行は普通に
  終わる。知らせを待つ人がいないので背景に回す意味は薄く、`SWITCHYARD_BACKGROUND=never` で前景のまま走らせられる(順番は
  普段どおり待つ)。大規模にはまだ試していない。

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
