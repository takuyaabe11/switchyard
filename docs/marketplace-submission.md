# Marketplace submission text / マーケットプレイス申請用の文章

Text to paste into the plugin directory submission form (https://platform.claude.com/plugins/submit).
Kept here so it stays in step with the README. Numbers come from
[docs/verification/2026-09-24-throughput.md](verification/2026-09-24-throughput.md) and
[docs/verification/2026-09-24-effect.md](verification/2026-09-24-effect.md).

申請フォームに貼る文章。README とずれないよう、ここに置いておく。

---

## English

**Name:** switchyard

**Repository:** https://github.com/takuyaabe11/switchyard

**Category:** Developer tools / productivity

**One-line description (≈150 characters):**
For running several Claude Code sessions or agents on one machine: queues heavy test and build runs so they take
turns instead of colliding.

**Description:**
When two or three Claude Code sessions share one machine — one per git worktree, or parallel agents — they often start
`npm test`, `cargo build` or `./gradlew test` at the same moment. Every run slows down, benchmarks taken in the middle
are meaningless, memory runs out, and sessions trip over the same git index.

switchyard puts those runs in a queue. A `PATH` shim recognizes test and build commands for npm, yarn, pnpm, bun,
cargo, pytest, uv, poetry, go, Maven, Gradle, dotnet, rspec, deno and make, and routes them through a small local
daemon that hands out CPU shares, watches memory, and gives out exclusive locks (a port, the git index, any name).
The share reaches the tool as its thread or worker count (cargo, Go, pytest-xdist, Vitest and others).
Nobody changes how commands are typed. When a run has to wait, Claude runs it in the background and is told when it
finishes. A failed run that nobody looked at is brought back to the session before it stops. After two runs of the
same command, switchyard knows how much CPU and memory it really uses and sizes its share to match.

**Who it is for:**
People who run more than one Claude Code session or agent on the same machine and run heavy test suites, builds,
browser E2E tests or benchmarks. It does not help a single session running one thing at a time; with nothing to sort,
it stays out of the way (about 4 ms on most Bash calls).

**Measured on a 4-core machine:**
- Three CPU-heavy test suites started together: the average result came back about 30% sooner, the last at about the
  same time.
- A benchmark beside four CPU-heavy runs was 20–50% slower and noisy; run through switchyard it waited about 4 s and
  then matched its alone-time.
- Wait-heavy suites are sized down to what they use, so three of them together finish close to their unqueued time
  (20.4 s vs 19.4 s) once learned.

**Limitations:**
- It orders work; it does not reduce total CPU. The first one or two runs of a new command are handled conservatively.
- Only recognized commands are queued; others can be added in `switchyard.json` (`switchyard init` suggests them).
- macOS and Linux (Windows via WSL). Node.js 20+.
- Everything stays on the machine. Logs live in `~/.switchyard` (owner-only). The only network access is a
  once-a-day version check against GitHub, which can be turned off.

**Try before installing:**
`git clone https://github.com/takuyaabe11/switchyard && cd switchyard && node bin/switchyard.mjs replay --since 14d`
shows how many of your past commands it would have queued, without installing anything. Installed with
`SWITCHYARD_OBSERVE=1`, it acts on nothing and only records when heavy runs overlapped; `switchyard report` shows the
result after a week. `switchyard uninstall` removes everything it wrote.

---

## 日本語

**名前:** switchyard

**リポジトリ:** https://github.com/takuyaabe11/switchyard

**カテゴリ:** 開発ツール / 生産性

**一行の説明:**
同じマシンで複数の Claude Code のセッションやエージェントを動かす人向け。重いテストやビルドを順番待ちに乗せ、ぶつからずに
順番に走らせる。

**説明:**
1 台のマシンで Claude Code のセッションを 2〜3 本動かしていると(git の worktree ごとに 1 本、あるいは並列のエージェント)、
同時に `npm test` や `cargo build`、`./gradlew test` が始まりがちだ。どの走行も遅くなり、その最中のベンチの数字は意味を失い、
メモリが尽き、セッション同士が同じ git の index で衝突する。

switchyard はそれらの走行を順番待ちに乗せる。`PATH` の shim が npm・yarn・pnpm・bun・cargo・pytest・uv・poetry・go・Maven・
Gradle・dotnet・rspec・deno・make のテストとビルドのコマンドを見分け、手元の小さなデーモンに通す。デーモンは CPU の取り分を
割り振り、メモリを見て、排他の鍵(ポート・git の index・任意の名前)を渡す。取り分は、道具のスレッド数・ワーカー数として
伝わる(cargo・Go・pytest-xdist・Vitest など)。コマンドの打ち方は誰も変えなくてよい。
待つことになる走行は Claude が背景で走らせ、終わったら知らせを受ける。誰も見ていない失敗は、セッションが止まる前に
差し戻して見させる。同じコマンドを 2 回走らせると、実際に使う CPU とメモリを学び、取り分をそれに合わせる。

**向いている人:**
同じマシンで Claude Code のセッションやエージェントを 2 本以上動かし、重いテスト・ビルド・ブラウザの E2E・ベンチマークを
走らせる人。1 本のセッションで 1 つずつ走らせる使い方には効かない。振り分けるものが無ければ邪魔をしない
(たいていの Bash の呼び出しに約 4ms)。

**4 コアの機械での実測:**
- CPU を使うテストの全件を 3 本同時に始めると、結果が返るまでの平均が約 30% 早くなり、最後の 1 本はほぼ同じ時刻だった。
- CPU を使う走行 4 本の横でベンチは 20〜50% 遅く、ばらついた。switchyard を通すと約 4 秒待ってから、単独と同じ数字で走った。
- 待ちが中心の全件は使う分まで取り分を縮めるので、学んだ後は 3 本同時でも順番待ちなしとほぼ同じ所要になる(20.4 秒と 19.4 秒)。

**限界:**
- 順番を決めるだけで、CPU の総量は減らさない。新しいコマンドの最初の 1〜2 回は控えめに扱う。
- 順番待ちに乗るのは見分けられるコマンドだけ。それ以外は `switchyard.json` に書く(`switchyard init` が候補を出す)。
- macOS と Linux(Windows は WSL)。Node.js 20 以上。
- すべて手元に残る。記録は `~/.switchyard`(持ち主だけが読める)。外への通信は 1 日 1 回の GitHub への版の確認だけで、止められる。

**入れる前に試す:**
`git clone https://github.com/takuyaabe11/switchyard && cd switchyard && node bin/switchyard.mjs replay --since 14d`
で、過去のコマンドのうち何本を順番待ちに乗せていたかが、何も入れずに分かる。`SWITCHYARD_OBSERVE=1` を付けて入れると、
何もせずに重い走行の重なりだけを記録し、1 週間後に `switchyard report` で結果が見られる。`switchyard uninstall` で、
書いたものをすべて片付けられる。
