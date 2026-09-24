# 1 本のセッションでも起きる事故: Bash の時間切れとポートの衝突(0.18.0・2026-09-24)

## なぜ

switchyard はセッションの間の取り合いを解くものだが、セッションを 1 本しか使わない人にも起きる事故が 2 つある。

- **Bash の時間切れ。** Claude Code は、Claude が長く頼まない限り、Bash の呼び出しを 2 分で止める。長いテストやビルドは途中で切られ、走り直しになる。
- **ポートの衝突。** 前に起動した dev サーバーやテストの残りがポートを握ったまま残り、次の走行が `EADDRINUSE` で落ちる。Claude はテストのせいだと思って直しに行きがち。

利用者の記録で量を数える `switchyard replay` の欄は足した。ただし今は利用者の機械で走らせられない。そこで、起きたときだけ働き、起きなければ何もしない形で作った。

## Claude Code の実物で確かめたこと(2.1.282)

入れ子の Claude Code を走らせ、hook に渡るものを書き出して確かめた。

| 場合 | 呼ばれる hook | 渡るもの |
|---|---|---|
| 成功した Bash | `PostToolUse` | `tool_response: { stdout, stderr, interrupted, isImage, noOutputExpected }`・`duration_ms` |
| 失敗した Bash(終了コード 0 以外) | `PostToolUseFailure`(`PostToolUse` は呼ばれない) | `error`(例: `Exit code 1\n…EADDRINUSE: address already in use 0.0.0.0:47321…`) |
| 時間切れ | `PostToolUseFailure` | `error: "Exit code 143\nCommand timed out after 3s"`・`is_interrupt: false`・`duration_ms: 3028`・`tool_input.timeout: 3000` |

- 記録(transcript)の tool_result も同じ文面で、`is_error: true`。
- `PostToolUseFailure` の `hookSpecificOutput.additionalContext` は Claude に届く。Claude が文面をそのまま引用した。
- PreToolUse の `updatedInput` で `timeout` を書き換えると効く。3 秒で切られた `sleep 5` が、6 秒に延ばされて最後まで走った。
- hooks.json の `"shell": "bash"` は公式の文書には無いが、付けたままでも Linux の Claude Code は plugin の hook を読み、すべて走らせた。

## 作ったもの

- **時間切れ**
  - 切られたコマンドを、repo の根と一緒に覚える(`timeouts.json`。直近 50 個・30 日)。
  - 次に同じ repo で同じコマンドが走るとき、PreToolUse が時間切れを倍にする(上限まで)。
  - デーモンが、自分で終わった走行(成否を問わず、信号で殺されていないもの)の最長の所要を学んでいれば、その 1.5 倍にする。上限でも足りなければ背景へ回す。
  - 終わったことの無いコマンド(watch モード・サーバー)は背景へ回さない。回すと誰も止めない。
  - 重い語の無いコマンドは、普段は PreToolUse の sh のふるいが node を起動せずに通す。覚えたコマンドだけは、ふるいが一覧(`timeouts.txt`)と照らして node の判定へ回す。
  - 秘密らしい値を含むコマンドと、`SWITCHYARD_LOG_COMMANDS=none` のときは覚えない。
- **ポート**
  - `PostToolUseFailure` の文面からポートの番号を取り出す(Node・Go・docker・Vite・Rails・Java・Python)。番号が無ければコマンドの `--port` などから取る。
  - 握っているプロセスを `lsof` → `ss` → `/proc/net/tcp`(Linux)→ `netstat`(Windows)の順で探す。
  - pid・コマンドライン・作業場所・走っている時間を Claude に伝える。Docker のコンテナが公開していればそう伝える。
- **入口**: `PostToolUseFailure` の hook は sh のふるいを通す。時間切れかポートの文言が無い失敗では node を起動しない。
- **記録**: hooks.jsonl に timeout・extend・port の行を足した。`switchyard report`(と `--share`)が数える。

## 通し(scripts/live-claude.mjs の 5 番目)

使い捨ての作業場所で、ポートを握るサーバーを先に立ててから、haiku に次の 3 つを走らせた。

1. 同じポートで待ち受ける `node -e …`
2. `sleep 5`(timeout 3000)
3. もう一度 `sleep 5`(timeout 3000)

結果:
- 1 は `EADDRINUSE` で落ち、switchyard が握っている pid とコマンドを伝えた。
- 2 は 3 秒で切られ、switchyard が「次は 6 秒」と伝えて、コマンドを覚えた。
- 3 は PreToolUse が timeout を 6000 に書き換え、最後まで走った。

既存の 7 つの確認と合わせて 9 つすべてが通った(haiku・費用は合わせて約 0.11 ドル)。

Claude が引用した文面:

```
[switchyard] Port 43107 is already in use, so it could not start; this is not a failure of the code. It is held by pid 10983 (/opt/node22/bin/node -e const s=require('http').createServer().listen(0,()=>console.log(s.address().port)); setTimeou…, running for 3s, in /home/user/switchyard). If that is left over from something started earlier in this work, stop it (kill 10983); otherwise use another port.

[switchyard] This was cut off by the Bash time limit (3s); it is not a failure of the code. The next time this command runs here, switchyard gives it 6s, so if it is just slow, run it again as is. If it never ends by itself (watch mode, a server), run it with run_in_background instead.
```

## まだ分からないこと

- 利用者の記録で、時間切れとポートの衝突がどれだけ起きているか。`switchyard replay` の「Bash の時間切れ」「ポートが使用中で落ちた Bash」の欄で数えられる。
- Windows の実物の Claude Code での動き。CI では、`netstat` で待ち受けているプロセスを突き止める通しを回している。
