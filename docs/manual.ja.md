# switchyard 取扱説明書(0.19.0)

この説明書は、2026-09-25 時点のコード(0.19.0)に書かれている動作と、記録に残っている測定だけを元にしている。
「根拠」の欄の意味は次のとおり。

- **実測**: 1 台の機械で条件をそろえて測った数字
- **利用者の記録**: 1 人の利用者の実際の記録(30 日分など)
- **実物の通し**: 本物の Claude Code に switchyard を入れて走らせ、動いたことを確かめた(`scripts/live-claude.mjs`)
- **テスト**: 自動テストで確かめている(実物では試していない)
- **未確認**: まだ確かめていない

---

## 1. これは何か

同じ機械で Claude Code のセッション(サブエージェントを含む)が同時に重い走行(テスト・ビルド・ベンチマーク)をするとき、CPU の割り振りと排他の鍵で順番を決める Claude Code の plugin。

機械を速くするものではない。CPU の総量も減らさない。走行の順番と取り分を決めるだけである。

加えて 0.18〜0.19 では、セッションが 1 本でも起きる 3 つのことを扱う。

- Bash の時間切れ
- 前景で待つループ
- 使用中のポート

## 2. 動く環境

| 環境 | 状態 | 根拠 |
|---|---|---|
| macOS・Linux(Node.js 20 以上) | すべての機能 | テスト(CI で Node 20・22・24)・実物の通し(Linux) |
| WSL2 | Linux として動く | 未確認(Linux と同じ仕組み) |
| Windows(Git for Windows が必要) | 一部の機能が弱まる(下) | テスト(CI の windows-latest)。**実物の Claude Code では未確認** |
| Windows(Git for Windows なし) | 何も起きない(Claude Code が PowerShell を使い、shim が PATH に載らない) | 仕組みから |

Windows で弱まるもの:
- 走行を止めるときは `taskkill /T` で子の木ごと止める。先に穏やかな SIGTERM を送る段は無い。
- `preempt: pause`・`throttle` は効かない。
- 走行から抜けた子を見つけない。`switchyard probe` は使えない。
- CPU の使い方の学習(right-sizing)と、メモリのピークの学習をしない。

## 3. 入れ方・外し方

入れ方:
```
/plugin marketplace add takuyaabe11/switchyard
/plugin install switchyard@switchyard
```

- デーモンは、必要になったときに自分で起動する。
- 一度も割り振りを出さないまま 2 分静かなら、自分で終わる(`SWITCHYARD_IDLE_EXIT_MS=0` で常駐)。

外し方(この順に):
1. `switchyard uninstall`
   - デーモンを止める。
   - セッションの環境ファイルから PATH の行を取り除く。
   - `~/.switchyard` を消す。`--dry-run` で何をするかだけ見る。`--keep-logs` で記録を残す。
2. `/plugin uninstall switchyard@switchyard`
3. 開いているセッションを開き直す。

`/plugin uninstall` だけでは、走っているデーモンも PATH の行も残る。

更新:
- 手順: `/plugin marketplace update switchyard` の後に `/reload-plugins`。
- 走っているデーモンは古い版のまま残る。次のセッションがそう知らせるので、`switchyard restart` で新しい版にする。

## 4. 入れると何が起きるか

switchyard が足すものは 2 つ。

- **hook 4 つ**: `SessionStart`・`PreToolUse`(Bash)・`PostToolUseFailure`(Bash)・`Stop`
- **PATH の shim**: 31 語

`settings.json` には何も書かない。

### 4.1 重い走行を見分ける(shim)

- **対象の語**:
  - `npm` `npx` `node` `yarn` `pnpm` `bun`
  - `cargo` `pytest` `python` `python3` `uv` `poetry` `go` `mvn` `gradle` `dotnet` `bundle` `rspec` `deno` `make`
  - `xcodebuild` `bazel` `bazelisk` `nx` `turbo`
  - `php` `composer` `phpunit` `pest` `paratest`
  - `git`(既定では何もしない)
  - 見分けた重い走行は順番待ちに乗せる。それ以外はそのまま本物へ渡す。
- **既定の表で見分ける形**:
  - `npm test`・`npm run test*`・`npm run build*`(yarn・pnpm・bun も同じ)
  - `npx vitest run`・`npx jest`・`npx playwright test`・`npx tsc`
  - `cargo build|test|nextest|clippy|check`
  - `pytest`・`python -m pytest`
  - `go test|build`・`mvn test|verify|package|install`・`gradle test|build|check`・`dotnet test|build`
  - `rspec`・`deno test`・`make`
  - `xcodebuild`・`bazel`・`nx`・`turbo` の test・build
  - `php artisan test`・`phpunit`・`pest`・`paratest`・`composer test`
  - これ以外は、`switchyard.json` に書かない限り順番待ちに乗らない。
- **見分けないもの**:
  - 走り続ける形: `--watch`・`--watchAll`・`tsc -w`
  - 問い合わせの形: `--version`・`--help`・`--list`・`--dry-run`
- **根拠**: テスト。実物の通しで `npm test` が switchyard を通ったことを確かめた。

### 4.2 順番待ちと CPU の割り振り(デーモン)

- **容量**: 論理コア数から予約(既定はコア数の 20% を切り上げ)を引いた数。`~/.switchyard/config.json` の `reserve`、または `SWITCHYARD_CAPACITY` で変える(変えたら `switchyard restart`)。
- **待たせるとき**: 容量の空きが足りない、鍵が使われている、または計測(`measure`)が走っているとき。待ち行列は見込みの短い順で、待った時間に応じて優先を上げる。
- **待つときの動き**: PreToolUse がその走行を背景に回す。Claude は待たずに先へ進み、終われば知らせが届く。待ちが見込まれなければ前景のまま走る(`SWITCHYARD_BACKGROUND=always|never` で変える)。
- **並列度の受け渡し**: 割り振った数を、並列度の環境変数で道具に渡す。
  - 渡す変数: `CARGO_BUILD_JOBS`・`RUST_TEST_THREADS`・`RAYON_NUM_THREADS`・`GOMAXPROCS`・`OMP_NUM_THREADS`・`PYTEST_XDIST_AUTO_NUM_WORKERS`・Vitest の `VITEST_MAX_THREADS`/`FORKS`/`WORKERS`
  - 自分で設定した値があれば、そちらが勝つ。
  - 1 本だけで走る走行には全コアを渡す。
  - Jest・Playwright・Gradle・Maven・make・dotnet・Xcode・Bazel・Nx・Turbo・PHPUnit・Pest・ParaTest には渡す変数が無い。`switchyard.json` の `args` に自分で書く。
- **学習**
  - **所要**: 成功した直近 10 回のうち 3 回以上で見込みを出す。
  - **CPU の使い方**: 2 回以上で学ぶ。割り振りの半分も使わない走行が続けば、要求を下げる。上げることはしない。
  - **メモリのピーク**: 直近 3 回で学ぶ。
  - **学習の単位**: repo(git の worktree は本体と共有)と profile の組。
- **実測の空きへの詰め込み**: 予約されていても使われていないコアに、待っている `batch` を 1 本ずつ入れる。
- **メモリを見た受け入れ**: 学んだピークを足すと、空きメモリが全体の 10% を割る走行を待たせる。何も走っていなければ必ず入れる。

根拠(実測。4 コア・16GB の 1 台):

| 場面 | 結果 |
|---|---|
| CPU を食うテスト 3 本を同時に始めた | switchyard 無しでは 3 本とも約 12 秒で終わった。switchyard を通すと約 4.5・8.5・12 秒で終わり、結果が届くまでの平均が約 30% 早まった。最後の 1 本はほぼ同じ |
| 重い走行 4 本の横でベンチマークを走らせた | switchyard 無しでは 20〜50% 遅く、ばらつきも大きかった。`measure` として走らせると約 4 秒待ち、1 本だけで走らせたときと同じ値になった |
| 入出力待ちが中心のテスト 3 本 | 学んだ後は平均 20.4 秒(switchyard 無しでは 19.4 秒)。学ぶ前は 24.4 秒 |
| 1 本ごとに新しい worktree で短い走行を回した | 56.2 秒 → 28.3 秒(0.15.0 → 0.16.0) |
| `pytest -n auto` に 2 コアを割り振った | ワーカーは 4 → 2、ピークのメモリは 758MB → 396MB。所要は変わらなかった |

利用者の記録(6 日・3,633 ジョブ・0.15.0 のころ):
- 待たせた走行は 130 本、待ち時間の合計は 4 時間 25 分。
- この待ちで、どれだけ時間を取り戻せたかは分からない(switchyard が無かった場合と比べる手段が無い)。

### 4.3 排他の鍵

- **付け方**: `switchyard.json` の `locks` か、`switchyard run --lock <名前>`。同じ名前の鍵を持つ走行は重ならない。例: `port:4173`・`db`。
- **自動では付かない。** ポートや DB を取り合う走行には、自分で書く必要がある。
- **git の index の鍵**: `SWITCHYARD_GIT=1` のときだけ取る。対象は index を書き換えるサブコマンドで、worktree ごとに別の鍵になる。
- **鍵の解放**: 包み(`switchyard run` か shim)が消えると、デーモンとの接続が切れ、取り分と鍵を返す。走行のプロセスがまだ生きていれば、終わるまで持たせる(確認待ちの「見失った走行」として出る)。心拍が 30 秒途絶えたときも同じに扱う。
- **根拠**: テスト。

### 4.4 shim から見えない走行を包む

- **包む形**: 1 行だけの `./gradlew test`・`./mvnw verify`・`.venv/bin/pytest` は、`switchyard run -- …` に書き換える。
- **権限**: Claude Code は書き換えた後のコマンドで許可を確かめる。そのため、包んだ形(`Bash(switchyard run -- ./gradlew test)`)を許していないと、許可を求められる。
- **拒否する形**
  - 他のコマンドとつないだ形(`cd app && ./gradlew test`)。使うべき `switchyard run -- …` を添えて拒否する。
  - 本物をパスで直に呼ぶ形(`/usr/local/bin/npm test`)。
  - `PATH` を差し替えて shim を素通りさせる形。
  - `SWITCHYARD_WRAP=0` のときは、1 行だけの形も書き換えずに拒否する。
- **承認を求める形**: 中身が重い走行の形ではない `switchyard run -- <何でも>`。`Bash(switchyard run:*)` を許していても求める(`SWITCHYARD_RUN_GUARD=0` で止める)。
- **根拠**: 実物の通し(包んで走らせた・中身が重い走行の形ではない包みは走らなかった)。

### 4.5 失敗した走行の知らせ(Stop)

- **知らせ**: 順番待ちを通った走行が失敗し、誰も確かめていなければ、セッションが止まるときに人へ知らせる。1 走行につき 1 回で、Claude には何もさせない。
- **確認済みになるとき**: 同じコマンドが後で成功するか、`switchyard ack <job>` を打ったとき。
- **差し戻し**: `SWITCHYARD_STOP=block` にすると、止まるのを差し戻して Claude に確かめさせる。
- **根拠**: 実物の通し(差し戻しの後、Claude が `switchyard ack` した)。

### 4.6 コードのせいではないかもしれない失敗の手がかり

- **いつ出すか**: 走行が失敗し、その間に次のどれかがあったとき。
  - 他の処理で機械がほぼ埋まっていた
  - 空きメモリが減った
  - SIGKILL で止められた
  - 計測のために一時停止された
- **どこに出すか**: 出力のすぐ下で、Claude に手がかりを伝える。Stop の知らせにも載せ、`report` でも数える。
- **手がかりにすぎない。** 忙しい機械の上でも、走行はそれ自身の理由で失敗しうる。
- **根拠**: テスト。

### 4.7 Bash の時間切れで長い走行を切らせない(0.18.0)

- **切られたとき**: Claude Code は、Claude が頼まない限り Bash の呼び出しを 2 分で止める。切られたら、時間切れだったことを Claude に伝え、コマンドを repo ごとに覚える(直近 50 個・30 日)。
- **次に走るとき**: 同じ repo で同じコマンドが走るとき、時間切れを倍にする。上限は既定で 10 分(`BASH_MAX_TIMEOUT_MS`)。
- **学んだ所要を使うとき**: 自分で終わるのを見たことのある重い走行は、最長の所要の 1.5 倍を与える。上限でも足りなければ背景へ回す。
- **背景へ回さないもの**: 自分で終わったことの無いコマンド。信号で殺された走行は「終わった」と数えない。
- **覚えないもの**: 秘密らしい値を含むコマンドと、`SWITCHYARD_LOG_COMMANDS=none` のとき。
- **止め方**: `SWITCHYARD_TIMEOUT_GUARD=0`。
- **根拠**: 実物の通し(3 秒で切られた `sleep 5` を覚え、次は 6 秒に延ばして走り切った)。
- **利用者の記録(30 日)**:
  - 時間切れは 170 件・25 時間 25 分。
  - 同じコマンドを走らせ直したのは 11 件だけ。「同じコマンドを覚えて延ばす」が効く場面は多くない。
  - 重い走行の時間切れは 38 件・3 時間 7 分。

### 4.8 前景で待つループを背景へ回す(0.19.0)

- **回すもの**: 前景で何かを待つ形を PreToolUse が見つけたら、`run_in_background` に書き換える。背景には時間切れが無く、終われば Claude Code が Claude に知らせる。
  - `sleep` を含む `until`・`while`・`for` のループ
  - 1 分を超える `sleep` だけの呼び出し
  - `gh run watch`
- **前景のままにするもの**
  - 回数 × sleep の見積もりが 1 分以下のループ
  - 回数の決まらないループで、1 回の sleep が 5 秒未満のもの
- **回さないもの**: 自分で終われないループ(`break` の無い `while true`・`tail -f`・`watch`)。背景では誰も止めない。
- **見ないもの**: heredoc の本文や引用の中に書いてあるだけのループ。
- **止め方**: `SWITCHYARD_WAIT_LOOPS=0`。
- **根拠**: 実物の通し(前景で頼んだ 65 秒のループが背景へ回り、30 秒の時間切れで切られずに最後まで走った)。
- **利用者の記録(30 日。この機能を入れる前)**: 時間切れのうち、前景で待つループは 70 件・15 時間。「その他」62 件・7 時間の上位にも、`for` の待つループがあった。入れた後にどれだけ減ったかは**未確認**。

### 4.9 使用中のポートを握っているプロセスを突き止める(0.18.0)

- **いつ動くか**: Bash の呼び出しが次の文言で落ちたとき。そういう失敗が無ければ何もしない。
  - `EADDRINUSE`
  - `address already in use`
  - Docker の `port is already allocated`
- **何を伝えるか**: ポートを握っているプロセスの pid・コマンドライン・作業場所・走っている時間と、コードのせいではないこと。Docker のコンテナが公開していれば、そう伝える。
- **調べ方**: `lsof` → `ss` → `/proc`(Linux)の順。Windows は `netstat`。
- **根拠**: 実物の通し(握っているサーバーの pid が Claude に届いた)。テスト(Windows の CI で `netstat` から突き止めた)。
- **利用者の記録(30 日)**: 0 件。この利用者には出番が無かった。

### 4.10 記録から秘密を伏せる

- **伏せ方**: 記録に残すコマンドのうち、秘密らしい値を `***` にする。走らせるコマンドそのものは変えない。
  - 名前: `API_KEY=`・`--password`・`-Dx.password=`
  - 形: `mysql -p…`・URL の `user:pass@`・`Authorization:` ヘッダ
  - トークンの形: `sk-…`・`ghp_…`・`AKIA…`
- **限界**: 名前や形から見分けるので、手がかりの無い秘密はすり抜けうる。
- **記録の設定**: `SWITCHYARD_LOG_COMMANDS=none` は先頭の語だけを残す。`full` はそのまま残す。
- **根拠**: テスト。

## 5. コマンド

| コマンド | すること |
|---|---|
| `switchyard top` | 走っているもの・待っているもの・その理由 |
| `switchyard why <job>` | 1 つのジョブの待つ理由 |
| `switchyard ack <job> [--session <id>]` | 失敗したジョブを確認済みにする |
| `switchyard run [--profile 名] [--why 目的] [--class quick\|batch\|measure] [--cpus min..max] [--lock 名]… [--preempt pause\|throttle\|never] -- <cmd>` | switchyard を通して明示的に走らせる(`--cpus 0` は鍵だけのジョブ) |
| `switchyard probe <秒> -- <cmd>` | 走行を測り、グループから抜ける子を報告する(Windows では使えない) |
| `switchyard replay [--since 30d] [--cwd 前方一致] [--config file] [--examples 数] [--dir 記録の根]` | 過去のセッション記録を、今の設定で空回しして数える(下) |
| `switchyard report [--since 7d] [--repo 前方一致] [--share]` | switchyard が実際にしたことの集計。`--share` は数だけ(repo・パス・コマンド・profile の名前・セッション id を含まない) |
| `switchyard init [--write] [--since 30d] [--min-seconds 秒] [--min-count 回]` | 過去の記録から、繰り返し走っていて長いのにどの profile にも当たらないコマンドを `switchyard.json` の案として出す(`--write` で書き足す。既にある profile は変えない) |
| `switchyard stop` / `restart` | デーモンを止める / 今の版で立ち上げ直す |
| `switchyard uninstall [--dry-run] [--keep-logs]` | 外す前の後片付け |

`switchyard replay` が出すもの(何も入れずに、何も書かずに動く):
- 判定の空回し: 拒否・包む・背景へ回す・承認を求める件数と例
- 前景で待つループを背景へ回す件数
- 同じ状態での走り直し(厳しめ・緩め)
- 重い走行の所要の分布と、セッションをまたいだ重なり
- Bash の時間切れ: 件数と、種類(前景で待つループ・重い走行・その他)ごとの件数と時間
- ポートが使用中で落ちた件数

## 6. 設定

### 6.1 switchyard.json(repo の根)

```json
{
  "profiles": {
    "unit": { "match": ["npm test", "npx vitest run*"], "class": "batch", "cpus": { "min": 2, "max": 10 }, "env": { "VITEST_MAX_THREADS": "{cpus}" } },
    "e2e":  { "match": ["npm run e2e*"], "class": "batch", "cpus": { "min": 4, "max": 4 }, "locks": ["port:4173"] },
    "bench": { "match": ["npm run benchmark*"], "class": "measure", "locks": ["port:4173"] }
  }
}
```

- **`class`**
  - `quick`: 素通しする。
  - `batch`: CPU を取る。
  - `measure`: 他の重い走行が無いときに 1 本だけで走る。
- **`cpus`**: `{ min, max }`。`max` に `"all"` を書くと、全コアを取れる。
- **`locks`**: 鍵の名前。ファイルではない。
- **`env`・`args`**: `{cpus}` が割り振った数に置き換わる。
- **`preempt`**: `measure` が先頭に来たとき、このジョブをどう扱うか。
  - `never`(既定): 計測はこのジョブが終わるのを待つ。
  - `pause`: SIGSTOP で止める。
  - `throttle`: renice で優先度を下げる。
  - 止めても鍵・メモリ・開いたファイルは持ったまま。コンテナを起こすテストは `never` のままにする。

### 6.2 環境変数(利用者が設定するもの)

| 変数 | 既定 | 意味 |
|---|---|---|
| `SWITCHYARD_OFF=1` | 無効 | switchyard を止める(hook は何もせず、shim は本物を直に走らせる) |
| `SWITCHYARD_OBSERVE=1` | 無効 | 観察だけ。何も止めず、並べず、拒否せず、始まりと終わりを記録する |
| `SWITCHYARD_BACKGROUND` | `auto` | `auto` は待ちが見込まれるときだけ背景へ回す。`always` は必ず回す。`never` は回さない |
| `SWITCHYARD_STOP=block` | 知らせるだけ | 確かめていない失敗があれば、止まるのを差し戻す |
| `SWITCHYARD_GIT=1` | 無効 | git の index の鍵を取る |
| `SWITCHYARD_WRAP=0` | 包む | 見えない形を書き換えずに拒否する |
| `SWITCHYARD_RUN_GUARD=0` | 求める | 中身が重い走行の形ではない `switchyard run` にも承認を求めない |
| `SWITCHYARD_THREAD_ENV=0` | 渡す | 並列度の環境変数を渡さない |
| `SWITCHYARD_OVERCOMMIT=0` | 有効 | 実測の空きへ詰め込まない |
| `SWITCHYARD_ADAPTIVE=0` | 有効 | 学んだ CPU の使い方で要求を下げない |
| `SWITCHYARD_MEMORY=0` | 有効 | メモリを見た受け入れをしない |
| `SWITCHYARD_MEM_FLOOR_MB` | 全体の 10% | 残しておく空きメモリ |
| `SWITCHYARD_CAPACITY` | コア数 − 予約 | 容量を固定する |
| `SWITCHYARD_TIMEOUT_GUARD=0` | 有効 | 時間切れを延ばさない・覚えない |
| `SWITCHYARD_WAIT_LOOPS=0` | 有効 | 前景で待つループを背景へ回さない |
| `SWITCHYARD_LOG_COMMANDS` | `masked` | `full`・`none` |
| `SWITCHYARD_LANG` | ロケールに従う | `ja`・`en` |
| `SWITCHYARD_HOME` | `~/.switchyard` | 記録の置き場所 |
| `SWITCHYARD_IDLE_EXIT_MS=0` | 2 分で終わる | 仕事の無いデーモンを常駐させる |
| `SWITCHYARD_UPDATE_CHECK=1` | 無効 | 1 日 1 回まで GitHub の版を見る(これ以外に外へは通信しない) |
| `SWITCHYARD_HOOK_SIEVE=0` | 有効 | PreToolUse の sh のふるいを外す(常に Node の判定へ) |
| `SWITCHYARD_BASH` | 自動で探す | Windows の Git Bash の `bash.exe` の場所 |

走行の子に渡るもの(読んで使える): `SWITCHYARD_CPUS`・`SWITCHYARD_THREADS`・`SWITCHYARD_JOB_ID`・`SWITCHYARD_IN_JOB`・`SWITCHYARD_HELD_LOCKS`。

## 7. 記録するもの(`~/.switchyard`。置き場所は 0700、ファイルは 0600)

| ファイル | 中身 |
|---|---|
| `state.json` | いま走っているもの・待っているもの |
| `events.jsonl` | すべての決定とジョブ(コマンド・repo のパス・セッション id・終了コード・所要) |
| `hooks.jsonl` | PreToolUse の判断と、時間切れ・ポートの失敗・待つループの背景化 |
| `timeouts.json`・`timeouts.txt` | 時間切れで切られたコマンド(直近 50 個・30 日) |
| `unmanaged.jsonl` | デーモンに届かず管理なしで走った走行 |
| `observed.jsonl` | 観察だけのモードで、重い走行の始まりと終わり |

- 記録は 8MB を超えると 1 世代だけ残して回す。
- 外へは何も送らない。

`~/.switchyard` の外に書くのは、Claude Code がセッションに渡す環境ファイル(`CLAUDE_ENV_FILE`)の PATH の 1 行だけ。

## 8. かかる手間

以前の版での計測で、今の版では測り直していない。

- 重い道具の名前を含まない Bash の呼び出し: 約 4ms(sh/awk のふるいが Node を起動せずに返す)
- 重い道具の名前を含む呼び出し: 約 60ms
- 順番待ちに乗せる走行: 1 本あたり約 0.15 秒
- 失敗した Bash の呼び出し: 時間切れかポートの文言があるときだけ Node を起動する。手間は測っていない。

## 9. 分かっている限界と未確認のこと

- **効果の数字**: 1 台の機械で条件をそろえた実測と、1 人の利用者の記録だけ。普段使いの複数の利用者のデータは無い。
- **待たせた時間の元**: 待たせたことで、それ以上の時間を取り戻せたかは測れていない。入出力待ちが中心の走行は、並べても本当はぶつからないことがある。
- **学ぶ前**: 新しいコマンドの最初の 1〜2 回は控えめに扱う。上の実測では 19.4 秒のところが 24.4 秒かかった。
- **自分で書く必要があるもの**:
  - ポートや DB の取り合いは、自動では鍵にならない。
  - 既定の表に無いコマンドは、`switchyard.json` に書かないと順番待ちに乗らない。
- **見ていないもの**: GPU・docker のコンテナの中・シミュレータ。
- **Windows**: 実物の Claude Code では試していない。hooks.json の `"shell": "bash"` は Claude Code の公式の文書に載っていない。Linux の Claude Code 2.1.282 では、付いていても hook は動いた。
- **0.18〜0.19 の機能**: 実際の利用でどれだけ時間を減らしたかは未確認。入れた後の `switchyard report` の数で確かめられる(時間切れ・延ばした・背景へ回した・待つループ・ポート)。
- **1 本のセッションで 1 つずつ走らせる使い方**: 並べ替える待ち列が無い。役に立つのは、時間切れ・待つループ・ポート・失敗の手がかりだけ。

## 10. 困ったとき

| こうなった | すること |
|---|---|
| 何かがおかしいので、すぐ止めたい | `SWITCHYARD_OFF=1` を設定する |
| 1 つのコマンドだけ順番待ちの外で走らせたい | `switchyard run --class quick -- <cmd>` |
| 待っている理由を知りたい | `switchyard top`・`switchyard why <job>` |
| 失敗の知らせが残り続ける | `switchyard ack <job>` |
| 更新したのに古い動き | `switchyard restart` |
| 何が起きていたかを見たい | `switchyard report --since 7d` |
| 入れる前に効くか知りたい | `node bin/switchyard.mjs replay --since 30d`(clone するだけで動き、何も書かない) |
