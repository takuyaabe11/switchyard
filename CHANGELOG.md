# Changelog

All notable changes to switchyard. Versions follow `plugin.json`; Claude Code only offers an update when that
version goes up.

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
