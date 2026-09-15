# hooks の門番の検出力(conductor 1b)

- 実行した日時: 2026-09-16 04:3x JST(改善 2 = 既定表から measure を外す・node -e の中身で分類しない・拒否を shim の語をパスで呼ぶ形に絞る、の後に走らせ直した)
- `uname -sr`: Darwin 25.6.0
- `node --version`: v24.16.0
- 組のテスト: `test/hooks/pretooluse.test.mjs`・`test/hooks/session.test.mjs`・`test/hooks/agreement.test.mjs`(三者の判定の表)・`test/hooks/shell.test.mjs`

## 原本の `npm test`(変異は一時ディレクトリの写しに入れるので、原本は変わらない)

```
ℹ tests 347
ℹ pass 347
ℹ fail 0
ℹ cancelled 0
```

## `npm run mutate:hooks` の出力

```
> conductor@0.2.0 mutate:hooks
> node scripts/mutate.mjs hooks

== H1 既に背景でも書き換える | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 1 / cancelled 0 / pass 77
   壊した行: if (found.heavy) {
   赤: 既に背景なら何もしない
== H2 背景への書き換えに allow を付ける(権限の確認を飛ばす) | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 23 / cancelled 0 / pass 55
   壊した行: return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...ti, run_in_background: true } } };
   赤: "npm test"
   赤: "cd benchmarks && npm test"
   赤: "bash -c \"npm test\""
   赤: "sh -c 'cd sub && npx vitest run'"
   赤: "(npm test)"
   赤: "echo \"$(npm test)\""
   赤: "env -u FOO npm test"
   赤: "time npm test"
   赤: "command npm test"
   赤: "timeout 600 node benchmarks/run.mjs"
   赤: "cd sub\nnpm test"
   赤: "if npm test; then echo ok; fi"
   赤: "conductor run -- npx vitest run"
   赤: "conductor run --lock port:4173 -- node scripts/e2e.mjs"
   赤: "conductor run -- ./node_modules/.bin/vitest run"
   赤: "node <bin/conductor.mjs> run --lock port:4173 -- npm run bench"
   赤: "./node_modules/.bin/vitest run"
   赤: "scripts/probe-run.sh gates npm run bench"
   赤: "npm test && ./node_modules/.bin/vitest run"
   赤: "npm run bench"
   赤: "conductor run -- node -e 'console.log(\"measure-suite\")'"
   赤: batch を前景で打ったら、run_in_background だけを true にし、決定は付けない
   赤: conductor run で包んだ部分は拒否しない。背景への判定は包みが要求する性格で行う
== H3 shim の語をパスで直に呼ぶ形を拒否しない | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 3 / cancelled 0 / pass 75
   壊した行: } else if (false) {
   赤: "/usr/local/bin/npm test"
   赤: shim の語の実行ファイルをパスで直に呼ぶ形は拒否し、直し方を示す
   赤: 拒否は背景への書き換えより先に効く
== H10 shim の語でないものをパスで呼ぶ形・shim の無い語も拒否へ戻す | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 5 / cancelled 0 / pass 73
   壊した行: if (!wrapped && hit !== null && launches) unshimmed.push(text);
   赤: "./node_modules/.bin/vitest run"
   赤: "./node_modules/.bin/eslint src"
   赤: "eslint src"
   赤: "npm test && ./node_modules/.bin/vitest run"
   赤: shim の語でないものをパスで呼ぶ形・shim の無い語は拒否しない。重ければ背景に回すだけ
== H17 パスで呼ぶスクリプトの引数の中の shim の語を見ない | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 2 / cancelled 0 / pass 76
   壊した行: (行を消した)
   赤: "scripts/probe-run.sh gates npm run bench"
   赤: shim の語でないものをパスで呼ぶ形・shim の無い語は拒否しない。重ければ背景に回すだけ
== H18 node -e のコードの中身で分類する | src/config/profiles.mjs | 赤 | tests 78 / fail 3 / cancelled 0 / pass 75
   壊した行: return words.join(' ');
   赤: "node -e 'console.log(\"vitest run\")'"
   赤: "conductor run -- node -e 'console.log(\"measure-suite\")'"
   赤: node -e のコードの中身では分類しない(読むだけのその場のスクリプトを背景に回さない)
== H19 既定表に *bench* / *measure* の measure を戻す | src/config/profiles.mjs | 赤 | tests 78 / fail 3 / cancelled 0 / pass 75
   壊した行: export const DEFAULT_PROFILES = [
  { name: 'default:measure', profile: { match: ['*bench*', '*measure*'], class: 'measure', cpus: { min: 1, max: 1000 } } },
   赤: "scripts/probe-run.sh benchmark"
   赤: "./jc.sh https://example.com/cross-media-measurement"
   赤: shim の語でないものをパスで呼ぶ形・shim の無い語は拒否しない。重ければ背景に回すだけ
== H4 timeout の値を読み飛ばさない | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 3 / cancelled 0 / pass 75
   壊した行: (行を消した)
   赤: "timeout 600 node benchmarks/run.mjs"
   赤: VAR=値 と包みのコマンドを読み飛ばして先頭の語を取る
   赤: 包みのコマンドの後ろの measure も背景に回す
== H5 conductor run で包んだ中も拒否の判定にかける | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 1 / cancelled 0 / pass 77
   壊した行: visit(w.argv, false);
   赤: conductor run で包んだ部分は拒否しない。背景への判定は包みが要求する性格で行う
== H20 glob が語の途中に当たっただけの部分も背景に回す | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 1 / cancelled 0 / pass 77
   壊した行: const launches = true;
   赤: "grep -rn \"vitest run\" src"
== H11 git の部分も profile で分類する | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 2 / cancelled 0 / pass 76
   壊した行: if (base === 'never-git') {
   赤: "/usr/bin/git commit -m x"
   赤: パスで呼ぶ git commit は拒否し、git commit は通す
== H12 conductor run の包みの性格と -- の後ろを見ない | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 6 / cancelled 0 / pass 72
   壊した行: (行を消した)
   赤: "conductor run -- npx vitest run"
   赤: "conductor run --lock port:4173 -- node scripts/e2e.mjs"
   赤: "conductor run -- ./node_modules/.bin/vitest run"
   赤: "node <bin/conductor.mjs> run --lock port:4173 -- npm run bench"
   赤: "conductor run -- node -e 'console.log(\"measure-suite\")'"
   赤: conductor run で包んだ部分は拒否しない。背景への判定は包みが要求する性格で行う
== H13 bash -c の引用の中を見ない | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 3 / cancelled 0 / pass 75
   壊した行: (行を消した)
   赤: "bash -c \"npm test\""
   赤: "sh -c 'cd sub && npx vitest run'"
   赤: shim の語でないものをパスで呼ぶ形・shim の無い語は拒否しない。重ければ背景に回すだけ
== H14 env の値つきオプションの値を読み飛ばさない | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 2 / cancelled 0 / pass 76
   壊した行: i += 1;
   赤: "env -u FOO npm test"
   赤: env の値つきのオプション(-u NAME・-C DIR など)は値の語も読み飛ばし、time / command のオプションも読み飛ばす
== H15 heredoc の本文を読み飛ばさない | src/hooks/shell.mjs | 赤 | tests 78 / fail 2 / cancelled 0 / pass 76
   壊した行: i += 1;
   赤: "git commit -m \"$(cat <<'EOF'\nfix: flaky test; retry measure step\n\nnpm test is green again\n\nCo-Authored-By: Claude <noreply@example.com>\nEOF\n)\""
   赤: heredoc の本文は語にせず、中の区切りも見ない(引用した区切り語・<<- も)
== H16 ( … ) の中を見ない | src/hooks/shell.mjs | 赤 | tests 78 / fail 3 / cancelled 0 / pass 75
   壊した行: endCommand();
      i = parse(src, i + 1, ')', []);
   赤: "(npm test)"
   赤: ( … )・$( … )・逆引用符の中を、別の単純コマンドとして取り出す
   赤: 閉じていない引用符や括弧でも止まらずに終わる
== H6 考える層の中でも判定する | src/hooks/pretooluse.mjs | 赤 | tests 78 / fail 1 / cancelled 0 / pass 77
   壊した行: (行を消した)
   赤: CONDUCTOR_THINKER=1 と Bash 以外では何もしない
== H7 Stop が 2 度目の停止も差し戻す | src/hooks/session.mjs | 赤 | tests 78 / fail 1 / cancelled 0 / pass 77
   壊した行: if (env.CONDUCTOR_THINKER === '1') return null;
   赤: stop_hook_active が true なら差し戻さない(2 度目の停止は通す)
== H8 SessionStart が同じ行を何度も足す | src/hooks/session.mjs | 赤 | tests 78 / fail 1 / cancelled 0 / pass 77
   壊した行: if (true) appendFileSync(
   赤: shims を PATH の先頭へ足す行を CLAUDE_ENV_FILE に 1 度だけ書き、知らせることが無ければ何も返さない
== H9 SessionStart が版の違いを知らせない | src/hooks/session.mjs | 赤 | tests 78 / fail 2 / cancelled 0 / pass 76
   壊した行: if (false) {
   赤: デーモンの版が plugin の版と違えば知らせる
   赤: 版を名乗らない古いデーモン(1a)には、版を「0.1.0 以前」として知らせる(undefined と出さない)
全部の変異が赤になった
EXIT=0
```

走行の後に `ps` で `conductord.mjs` / `.test.mjs` / `scripts/mutate.mjs` を探し、残りは無かった。

## 改善 2 で足した・変えた変異

- **H3**: 拒否の条件を書き直したので、置き換え元を新しいコード(shim の語をパスで呼ぶ形の拒否の枝)に合わせた。赤は `/usr/local/bin/npm test` の行と、拒否のテスト 2 本。
- **H10**: 以前の「拒否の条件を、shim の無い語で当たれば拒否へ戻す」を、改善 2 の前の形(shim の語でないものをパスで呼ぶ形・shim の無い語も拒否する)へ戻す変異に置き換えた。赤は `./node_modules/.bin/vitest run`・`./node_modules/.bin/eslint src`・`eslint src` などの「拒否しない」行。
- **H17**: パスで呼ぶスクリプトの引数の中の shim の語から後ろを見ない形。赤は `scripts/probe-run.sh gates npm run bench`(中の npm は PATH の shim が包むのに、前景のまま残る)。
- **H18**: `node -e` のコードの中身で分類する形(`classifiableCommand` がインラインのコードを除かない)。赤は `node -e 'console.log("vitest run")'` と、`conductor run` の包みの性格の行。
- **H19**: 既定表に `*bench*` / `*measure*` の measure を戻す形。赤は `scripts/probe-run.sh benchmark` と `./jc.sh …measurement`(引数に語を含むだけのスクリプトが背景に回る)。
- **H20**: 以前の H10 が守っていた C1(glob が語の途中に当たっただけの読むだけのコマンドを重いと見なさない)を、拒否から背景への判定へ移した後のコードに当てた。赤は `grep -rn "vitest run" src` の行だけ。
- **H2** は、背景に回す行が表に増えたので赤の件数が 23 になった。

## 最後の全体レビュー(1b)で足した・変えた変異

- **H11(C1)**: git を profile で分類する形へ戻す。赤は三者の判定の表の git の行。
- **H12〜H14・H16(I1)**: `conductor run` の `--` の後ろ・`bash -c` の中・`env -u` の値・`( … )` の中を見ない形。どれも表の該当する行が赤になる。
- **H15(C1)**: heredoc の本文を読み飛ばさない形。本文に `npm test` で始まる行を入れてあるので、表の heredoc の commit の行が背景に回って赤になる。
- **H5**: `conductor run` で包んだ中も拒否の判定にかける形。H1 は変数名(`found.heavy`)に合わせてある。
