# plugin の前置きの token(conductor 1b)

設計 §9.6「前置きとして食う token は、`claude plugin details` で測って記録する」の記録。

- 測った日: 2026-09-15(Task 9 の走行)
- `claude --version`: 2.1.251 (Claude Code)
- 測り方: `claude --plugin-dir <この repo の根> plugin details conductor`
- この記録を足した修正の波(1b の最後の全体レビューの後)では `claude` を呼んでいない。下の出力は Task 9 の走行で出たものの写し。

## 出力(Task 9 の走行の写し)

```
conductor 0.2.0
  Description: 同じマシンの Claude Code セッションが重い走行を取り合わないように、CPU と排他の鍵を割り振る司令塔
  Source: conductor@inline

Component inventory
  Skills (1)  conductor
  Agents (0)
  Hooks (3)  SessionStart, PreToolUse, Stop  (harness-only — no model context cost)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~101 tok   added to every session

Per-component (rounded)
  component  always-on  on-invoke
  conductor       ~100       ~920
```

## 測り直し(最後の全体レビューの修正の後)

- 測った日: 2026-09-15 22 時台(修正の波 fe904e6 の後。`skills/conductor/SKILL.md` を書き足した後)
- `claude --version`: 2.1.251 (Claude Code)
- 測り方: 上と同じ(API は呼ばず、plugin の導入もしない)。終了コード 0

```
Projected token cost
  Always-on:   ~101 tok   added to every session

Per-component (rounded)
  component  always-on  on-invoke
  conductor       ~100      ~1.1k
```

## 要点

| 項目 | Task 9 の走行 | 修正の後(いまの値) |
|---|---|---|
| Always-on(毎セッションに足される) | ~101 | ~101 |
| skill `conductor` の on-invoke(skill を読んだときに足される) | ~920 | ~1.1k |

- hooks 3 本は、出力のとおりモデルの文脈には入らない(`harness-only — no model context cost`)。
- on-invoke が増えたのは、`skills/conductor/SKILL.md` の本文(「何もしなくてよいこと」と「拒否されたとき」の節)を書き足したため(最後の全体レビューの C1・I1)。frontmatter の `description` は変えていないので、Always-on は変わらない。
