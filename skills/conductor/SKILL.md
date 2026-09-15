---
name: conductor
description: 同じマシンの複数セッションで重い走行(テスト全件・build・e2e・ベンチ)を回すときに読む。conductor が順番待ちや背景実行に回した理由の読み方、失敗の確認のしかた、してはいけない抜け道
---

# conductor の使い方

conductor は、同じマシンで動く Claude Code のセッションが重い走行を取り合わないように、CPU と排他の鍵(ポート・git の index など)を割り振る。

## 何もしなくてよいこと

- 重いコマンド(`npm test`・`npm run build`・`npx vitest run`・`npx playwright test`・`cargo build` / `cargo test`・`pytest`・`go test`・`make`・名前に `bench` か `measure` を含むもの。repo の `conductor.json` があればその分類)は、PATH の先頭に入った shim が自動で conductor に通す。コマンドを書き換える必要はない。
- 前景で打っても、conductor が背景実行に切り替える。`bash -c "…"`・`( … )` の中や、`conductor run -- …` で包んだコマンドも、重ければ同じく背景に回る。背景タスクの終わりを待ってから結果を読む。
- `git commit` / `merge` / `rebase` / `cherry-pick` / `stash` / `am` は、同じ作業ツリーの index を別のセッションと同時に書き換えないよう、順番に通る。

## 待っているとき

- 出力に `[conductor] 待機 N 番目: 理由(見込み HH:MM)` が出る。待ちの間に同じコマンドを打ち直さない(列に二重に並ぶ)。
- 全体は `conductor top`、1 本の理由は `conductor why <job>` で読む。
- 計測(ベンチなど)が走っている間は、重い走行は計測が終わるまで待ちになる。

## 止まろうとして差し戻されたとき

- 「このセッションのジョブに、まだ確認されていない終わり方がある」と差し戻されたら、挙がったジョブの失敗を確かめる(`conductor why <job>`・記録 `~/.conductor/events.jsonl`)。
- 直すか、直さないと決めてから `conductor ack <job>` で確認済みにする。確かめずに ack しない。

## 拒否されたとき

- 「shim を迂回して起動する部分がある」と拒否されるのは、管理対象のコマンドをパスで直に呼んだ(`./node_modules/.bin/vitest run`・`/usr/bin/git commit`)か、shim の無い語で起動した(`scripts/probe-run.sh benchmark` など)ときだけ。
- PATH から呼べる形(例: `npx vitest run`・`git commit`)に書き直す。書き直せないときだけ `conductor run -- <その部分>` で包む(包んだコマンドには普段どおり権限の確認が出る)。
- `cat` / `grep` / `ls` / `cd` のような読むだけのコマンドは、引数に `bench` や `measure` があっても拒否されない。包まない(包むと重い走行として順番を待つ)。

## してはいけないこと

- `CONDUCTOR_IN_JOB` / `CONDUCTOR_HELD_LOCKS` を自分で立てる、PATH から shims を外す、本物のコマンドをパスで直に呼んで順番待ちを避ける。
- 他のセッションに、順番を譲らせる・抜け道を使わせるよう頼む。順番の判断は conductor が理由と見込みつきで出す。
