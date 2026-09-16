# AGENTS.md / CLAUDE.md に貼る一節(switchyard)

この一節は自動では書き込まない。使う repo の AGENTS.md か CLAUDE.md に、オーナーが貼る。

```markdown
## 重い走行(switchyard)

- このマシンでは switchyard が重い走行(テスト全件・build・e2e・ベンチ)の順番と CPU を割り振る。コマンドはそのまま打てばよく、shim が自動で順番待ちと背景実行に回す。
- 待ちの理由は `switchyard top` / `switchyard why <job>` で読む。待ちの間に同じコマンドを打ち直さない。
- Stop で差し戻されたら、挙がったジョブの失敗を確かめてから `switchyard ack <job>` する。
- `SWITCHYARD_IN_JOB` などを自分で立てたり、本物のコマンドをパスで直に呼んだりして順番を避けない。
```
