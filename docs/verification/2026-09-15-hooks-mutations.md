# hooks の門番の検出力(conductor 1b)

- 実行した日時: 2026-09-15 20:41 JST
- `uname -sr`: Darwin 25.6.0
- `node --version`: v24.16.0

## 復元後の原本の `npm test`

```
ℹ tests 245
ℹ pass 245
ℹ fail 0
```

## `npm run mutate:hooks` の出力

```
> conductor@0.1.0 mutate:hooks
> node scripts/mutate.mjs hooks

== H1 既に背景でも書き換える | src/hooks/pretooluse.mjs | 赤 | tests 24 / fail 1 / cancelled 0 / pass 23
   壊した行: if (heavy) {
   赤: 既に背景なら何もしない
== H2 背景への書き換えに allow を付ける(権限の確認を飛ばす) | src/hooks/pretooluse.mjs | 赤 | tests 24 / fail 1 / cancelled 0 / pass 23
   壊した行: return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...ti, run_in_background: true } } };
   赤: batch を前景で打ったら、run_in_background だけを true にし、決定は付けない
== H3 shim を通らない形を拒否しない | src/hooks/pretooluse.mjs | 赤 | tests 24 / fail 3 / cancelled 0 / pass 21
   壊した行: (行を消した)
   赤: 管理対象なのに shim を通らない形は拒否し、直し方を示す
   赤: パスで呼ぶ git commit は拒否し、git commit は通す
   赤: 拒否は背景への書き換えより先に効く
== H4 timeout の値を読み飛ばさない | src/hooks/pretooluse.mjs | 赤 | tests 24 / fail 2 / cancelled 0 / pass 22
   壊した行: (行を消した)
   赤: VAR=値 と包みのコマンドを読み飛ばして先頭の語を取る
   赤: 包みのコマンドの後ろの measure も背景に回す
== H5 conductor run を含むコマンドも判定する | src/hooks/pretooluse.mjs | 赤 | tests 24 / fail 1 / cancelled 0 / pass 23
   壊した行: && p.rest[0] === 'never')) return null;
   赤: conductor run を含むコマンドは素通しする
== H6 考える層の中でも判定する | src/hooks/pretooluse.mjs | 赤 | tests 24 / fail 1 / cancelled 0 / pass 23
   壊した行: (行を消した)
   赤: CONDUCTOR_THINKER=1 と Bash 以外では何もしない
== H7 Stop が 2 度目の停止も差し戻す | src/hooks/session.mjs | 赤 | tests 24 / fail 1 / cancelled 0 / pass 23
   壊した行: if (env.CONDUCTOR_THINKER === '1') return null;
   赤: stop_hook_active が true なら差し戻さない(2 度目の停止は通す)
== H8 SessionStart が同じ行を何度も足す | src/hooks/session.mjs | 赤 | tests 24 / fail 1 / cancelled 0 / pass 23
   壊した行: if (true) appendFileSync(
   赤: shims を PATH の先頭へ足す行を CLAUDE_ENV_FILE に 1 度だけ書き、知らせることが無ければ何も返さない
== H9 SessionStart が版の違いを知らせない | src/hooks/session.mjs | 赤 | tests 24 / fail 1 / cancelled 0 / pass 23
   壊した行: if (false) {
   赤: デーモンの版が plugin の版と違えば知らせる
全部の変異が赤になった
```
