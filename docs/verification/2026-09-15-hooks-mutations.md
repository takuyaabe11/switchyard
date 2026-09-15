# hooks の門番の検出力(conductor 1b)

- 実行した日時: 2026-09-15 22:22 JST(最後の全体レビューの修正の後に走らせ直した)
- `uname -sr`: Darwin 25.6.0
- `node --version`: v24.16.0
- 組のテスト: `test/hooks/pretooluse.test.mjs`・`test/hooks/session.test.mjs`・`test/hooks/agreement.test.mjs`(三者の判定の表)・`test/hooks/shell.test.mjs`

## 原本の `npm test`(変異は一時ディレクトリの写しに入れるので、原本は変わらない)

```
ℹ tests 311
ℹ suites 54
ℹ pass 311
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

## `npm run mutate:hooks` の出力

```
> conductor@0.2.0 mutate:hooks
> node scripts/mutate.mjs hooks

== H1 既に背景でも書き換える | src/hooks/pretooluse.mjs | 赤 | tests 71 / fail 1 / cancelled 0 / pass 70
   壊した行: if (found.heavy) {
   赤: 既に背景なら何もしない
== H2 背景への書き換えに allow を付ける(権限の確認を飛ばす) | src/hooks/pretooluse.mjs | 赤 | tests 71 / fail 18 / cancelled 0 / pass 53
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
   赤: batch を前景で打ったら、run_in_background だけを true にし、決定は付けない
   赤: conductor run で包んだ部分は拒否しない。背景への判定は包みが要求する性格で行う
== H3 shim を迂回する形を拒否しない | src/hooks/pretooluse.mjs | 赤 | tests 71 / fail 8 / cancelled 0 / pass 63
   壊した行: (行を消した)
   赤: "./node_modules/.bin/vitest run"
   赤: "./node_modules/.bin/eslint src"
   赤: "eslint src"
   赤: "scripts/probe-run.sh benchmark"
   赤: "/usr/local/bin/npm test"
   赤: "npm test && ./node_modules/.bin/vitest run"
   赤: 管理対象なのに shim を通らない形は拒否し、直し方を示す
   赤: 拒否は背景への書き換えより先に効く
== H4 timeout の値を読み飛ばさない | src/hooks/pretooluse.mjs | 赤 | tests 71 / fail 3 / cancelled 0 / pass 68
   壊した行: (行を消した)
   赤: "timeout 600 node benchmarks/run.mjs"
   赤: VAR=値 と包みのコマンドを読み飛ばして先頭の語を取る
   赤: 包みのコマンドの後ろの measure も背景に回す
== H5 conductor run で包んだ中も拒否の判定にかける | src/hooks/pretooluse.mjs | 赤 | tests 71 / fail 3 / cancelled 0 / pass 68
   壊した行: visit(w.argv, false);
   赤: "conductor run -- ./node_modules/.bin/vitest run"
   赤: "conductor run --class quick -- ./node_modules/.bin/eslint src"
   赤: conductor run で包んだ部分は拒否しない。背景への判定は包みが要求する性格で行う
== H10 拒否の条件を「shim の無い語で当たれば拒否」へ戻す | src/hooks/pretooluse.mjs | 赤 | tests 71 / fail 7 / cancelled 0 / pass 64
   壊した行: const bypass = true;
   赤: "cat benchmarks/standards.json"
   赤: "ls bench"
   赤: "grep -rn measure src"
   赤: "echo measure"
   赤: "grep -rn \"vitest run\" src"
   赤: "cd benchmarks && npm install"
   赤: "cd benchmarks && npm test"
== H11 git の部分も profile で分類する | src/hooks/pretooluse.mjs | 赤 | tests 71 / fail 6 / cancelled 0 / pass 65
   壊した行: if (base === 'never-git') {
   赤: "git commit -m \"fix bench flake\""
   赤: "git diff -- benchmarks/"
   赤: "git log -- benchmarks"
   赤: "/usr/bin/git diff -- benchmarks/"
   赤: "/usr/bin/git commit -m x"
   赤: パスで呼ぶ git commit は拒否し、git commit は通す
== H12 conductor run の包みの性格と -- の後ろを見ない | src/hooks/pretooluse.mjs | 赤 | tests 71 / fail 5 / cancelled 0 / pass 66
   壊した行: (行を消した)
   赤: "conductor run -- npx vitest run"
   赤: "conductor run --lock port:4173 -- node scripts/e2e.mjs"
   赤: "conductor run -- ./node_modules/.bin/vitest run"
   赤: "node <bin/conductor.mjs> run --lock port:4173 -- npm run bench"
   赤: conductor run で包んだ部分は拒否しない。背景への判定は包みが要求する性格で行う
== H13 bash -c の引用の中を見ない | src/hooks/pretooluse.mjs | 赤 | tests 71 / fail 2 / cancelled 0 / pass 69
   壊した行: (行を消した)
   赤: "bash -c \"npm test\""
   赤: "sh -c 'cd sub && npx vitest run'"
== H14 env の値つきオプションの値を読み飛ばさない | src/hooks/pretooluse.mjs | 赤 | tests 71 / fail 2 / cancelled 0 / pass 69
   壊した行: i += 1;
   赤: "env -u FOO npm test"
   赤: env の値つきのオプション(-u NAME・-C DIR など)は値の語も読み飛ばし、time / command のオプションも読み飛ばす
== H15 heredoc の本文を読み飛ばさない | src/hooks/shell.mjs | 赤 | tests 71 / fail 2 / cancelled 0 / pass 69
   壊した行: i += 1;
   赤: "git commit -m \"$(cat <<'EOF'\nfix: flaky test; retry measure step\n\nnpm test is green again\n\nCo-Authored-By: Claude <noreply@example.com>\nEOF\n)\""
   赤: heredoc の本文は語にせず、中の区切りも見ない(引用した区切り語・<<- も)
== H16 ( … ) の中を見ない | src/hooks/shell.mjs | 赤 | tests 71 / fail 3 / cancelled 0 / pass 68
   壊した行: endCommand();
      i = parse(src, i + 1, ')', []);
   赤: "(npm test)"
   赤: ( … )・$( … )・逆引用符の中を、別の単純コマンドとして取り出す
   赤: 閉じていない引用符や括弧でも止まらずに終わる
== H6 考える層の中でも判定する | src/hooks/pretooluse.mjs | 赤 | tests 71 / fail 1 / cancelled 0 / pass 70
   壊した行: (行を消した)
   赤: CONDUCTOR_THINKER=1 と Bash 以外では何もしない
== H7 Stop が 2 度目の停止も差し戻す | src/hooks/session.mjs | 赤 | tests 71 / fail 1 / cancelled 0 / pass 70
   壊した行: if (env.CONDUCTOR_THINKER === '1') return null;
   赤: stop_hook_active が true なら差し戻さない(2 度目の停止は通す)
== H8 SessionStart が同じ行を何度も足す | src/hooks/session.mjs | 赤 | tests 71 / fail 1 / cancelled 0 / pass 70
   壊した行: if (true) appendFileSync(
   赤: shims を PATH の先頭へ足す行を CLAUDE_ENV_FILE に 1 度だけ書き、知らせることが無ければ何も返さない
== H9 SessionStart が版の違いを知らせない | src/hooks/session.mjs | 赤 | tests 71 / fail 2 / cancelled 0 / pass 69
   壊した行: if (false) {
   赤: デーモンの版が plugin の版と違えば知らせる
   赤: 版を名乗らない古いデーモン(1a)には、版を「0.1.0 以前」として知らせる(undefined と出さない)
全部の変異が赤になった
```

## 最後の全体レビューで足した・変えた変異

- **H10・H11(C1)**: 直す前の拒否の条件(shim の無い語で分類が当たれば拒否)と、git を profile で分類する形へ戻す。赤は三者の判定の表の「読むだけのコマンド」と「git の各形」の行で、狙った行だけが落ちている。
- **H12〜H14・H16(I1)**: `conductor run` の `--` の後ろ・`bash -c` の中・`env -u` の値・`( … )` の中を見ない形。どれも表の該当する行が赤になる。
- **H15(C1)**: heredoc の本文を読み飛ばさない形。本文に `npm test` で始まる行を入れてあるので、表の heredoc の commit の行が背景に回って赤になる。
- **H3・H5**: 拒否と `conductor run` の扱いを書き直したので、置き換え元を新しいコードに合わせた(H3 = 拒否の行を消す、H5 = 包んだ中も拒否の判定にかける)。H1 は変数名の変更(`found.heavy`)に合わせた。
- **H2** は、背景に回す行が表に増えたので赤の件数が 18 になった。
