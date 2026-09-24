# Changelog

All notable changes to switchyard. Versions follow `plugin.json`; Claude Code only offers an update when that
version goes up.

## 0.10.0

### Added
- The share a run is given now reaches the tool: `CARGO_BUILD_JOBS`, `RUST_TEST_THREADS`, `RAYON_NUM_THREADS`,
  `GOMAXPROCS`, `OMP_NUM_THREADS`, `PYTEST_XDIST_AUTO_NUM_WORKERS` (`pytest -n auto`) and Vitest's `VITEST_MAX_THREADS`,
  `VITEST_MAX_FORKS` and `VITEST_MAX_WORKERS` are set for runs the daemon admits, plus `SWITCHYARD_THREADS`. A value
  already in the environment or in the profile's `env` wins. A run given the whole capacity gets every core; a run
  sized down to its measured use keeps its declared maximum, since it mostly waits. `SWITCHYARD_THREAD_ENV=0` turns
  it off.
- Observe-only mode, `SWITCHYARD_OBSERVE=1`: nothing is held back, queued or refused. Heavy runs start at once and
  their start and end go to `observed.jsonl`; `PreToolUse` verdicts are logged but not acted on; `Stop` never holds a
  session. `switchyard report` then shows how many heavy runs overlapped, for how long and across how many sessions,
  measurements that ran beside one, runs holding the same lock at once, and what `PreToolUse` would have done.
- `switchyard uninstall [--dry-run] [--keep-logs]` stops the daemon, removes switchyard's shims `PATH` line from the
  session env files, and deletes `~/.switchyard`. It only deletes files switchyard wrote; if the directory holds
  anything else it deletes nothing there.

### Changed
- The built-in table and `switchyard init` suggestions use `cpus: { min: 2, max: "all" }` (was `2..4`); `"all"` is
  accepted in `switchyard.json`. The daemon cuts a maximum above its capacity down to the capacity before sizing.

## 0.9.0

### Added
- Packing into measured spare CPU. The daemon samples machine-wide CPU use once a second. When the queue head does not
  fit in the declared free CPU but fits in capacity minus what the machine really uses (and minus what the running
  jobs usually use, once learned), it is admitted beyond capacity, one run at a time, after the running jobs have had
  1 s (learned) or 3 s (not yet learned) to start. Never while a measurement runs or waits, never past a held lock.
  `top` marks packed runs and `report` counts them. `SWITCHYARD_OVERCOMMIT=0` turns it off.
- Memory-aware admission. The daemon samples each running job's process-group RSS every 2 s and records its peak.
  A run whose usual peak (the largest of its last three) would push free memory, minus what running jobs are still
  expected to take, below a floor (10% of total or the cgroup limit; `SWITCHYARD_MEM_FLOOR_MB`) waits. With nothing
  running it always starts. `top` shows free memory; `report` counts "memory" waits. `SWITCHYARD_MEMORY=0` turns it off.

### Changed
- `PreToolUse` goes through a `sh`/`awk` sieve first. Commands that name no default-table tool, no wrapper, no
  index-writing `git` subcommand, in a directory with no `switchyard.json` above it, return in about 4 ms instead of
  about 60 ms, without starting Node.
- Two runs (was three) are enough to size a profile down to its measured CPU use.
- `PreToolUse` expects no wait for a single heavy run that fits in the measured spare CPU.

### Docs
- The README (English and Japanese) now opens with who switchyard is for and who can skip it, how to check with
  `switchyard replay` before installing, what changes once it is installed, and what it does not do. The plugin
  description and keywords say the same. `docs/marketplace-submission.md` holds the directory submission text.

## 0.8.0

### Security
- `~/.switchyard` is created readable by its owner only (0700, logs 0600). The logs hold full command lines, arguments
  included, and were readable by other users on the machine. Existing directories and logs are tightened when the
  daemon starts.

### Changed
- `PreToolUse` refuses heavy runs that no shim can see — `./gradlew test`, `./mvnw verify`, tools inside a Python
  virtualenv (`.venv/bin/pytest`), and `pytest` or `python -m pytest` after `source .venv/bin/activate` — and asks for
  `switchyard run -- <command>`, which puts them in the queue.
- Whether to send a run to the background now uses the share the daemon will actually give it (sized to measured use),
  not the declared one.
- CPU use is learned from failed runs too when they ran for 5 seconds or more, so a profile gets sized while its
  tests are still red.

### Fixed
- A daemon test with a 150 ms heartbeat window failed under CI load.

## 0.7.0

### Added
- switchyard measures how much CPU each run really uses (user + sys time of the command and everything it started).
  A `batch` profile whose successful runs keep using less than half of what they were given is admitted with a share
  sized to what it uses (never more than declared). Runs that use all they are given, measurements and locks-only
  jobs are left as declared. `top` and `why` show when a run was sized down. `SWITCHYARD_ADAPTIVE=0` turns it off.

### Changed
- The update check is on by default. `SessionStart` fetches `plugin.json` from GitHub at most once a day and says when
  a newer version is out; `SWITCHYARD_UPDATE_CHECK=0` turns it off.

## 0.6.0

### Added
- `switchyard init` suggests `switchyard.json` profiles from your past Claude Code sessions in the repo: commands
  that ran repeatedly and took long but match no profile. `--write` adds them without touching existing profiles.
- The built-in table also covers Python (`python -m pytest`, `uv run pytest`, `poetry run pytest`), Maven, Gradle,
  .NET (`dotnet test|build`), Ruby (`bundle exec rspec`, `rspec`), Deno (`deno test`) and `npx tsc`, with shims for
  `python`, `python3`, `uv`, `poetry`, `mvn`, `gradle`, `dotnet`, `bundle`, `rspec` and `deno`.
- `switchyard report` shows what the queue did: how many runs it held back so they would not overlap, the total wait,
  and how many measurements ran alone.
- Messages are in English by default, and in Japanese when the locale starts with `ja`. `SWITCHYARD_LANG=en|ja`
  picks one explicitly.
- `SWITCHYARD_UPDATE_CHECK=1` makes `SessionStart` say when a newer version is published (checked at most once a day).

### Changed
- A failed run is marked as looked at automatically when the same command later succeeds in the same session, so
  fixing a failing test no longer leaves the session held back by `Stop`.
- `PreToolUse` sends a heavy run to the background only when it would have to wait (a queue, a measurement, a held
  lock, not enough free CPU). `SWITCHYARD_BACKGROUND=always` restores the old behavior, `never` turns it off.
- A run that keeps watching (`--watch`, `--watchAll`, `tsc -w`) is no longer classified.
- Calling a shimmed tool inside a virtualenv or `node_modules/.bin` by path is no longer refused.

## 0.5.0

### Added
- Shims for `yarn`, `pnpm` and `bun`; the built-in table covers `npm run test*`, `npm t`, `npx jest`, `yarn`/`pnpm`/`bun`
  test and build, `cargo nextest|clippy|check` and `go build`. A script under `node_modules/.bin` is classified as its
  `npx` form.
- `git` takes the index lock for `add`, `rm`, `mv`, `reset`, `restore`, `checkout`, `switch`, `pull` and `revert` too.

### Fixed
- `git -C <dir> commit` and `git -c k=v commit` skipped the index lock.
- `switchyard ack <job>` from your own terminal said it succeeded while doing nothing. It now finds the job's session
  by id, and reports an error for an id that is not waiting to be acked.
- `PreToolUse` refuses running a queued command with `PATH` replaced, `env -i`, `SWITCHYARD_IN_JOB` or
  `SWITCHYARD_HELD_LOCKS`.
- A `pause` job was stopped even while the measurement could not start yet.
- Zombie processes were counted as alive, giving false "still alive" reports and needless SIGKILLs in containers.
- The daemon lock could be seen empty by a second daemon starting at the same time, and a daemon stopped during
  startup left its lock behind.
