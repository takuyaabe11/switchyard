# 0.9.0 の実測(フックのふるい・実測の空きへの詰め込み・メモリを見た受け入れ)

## 環境

- 日時: 2026-09-24
- Linux(コンテナ)・論理コア 4・メモリ 16GB・Node v22.22.2
- switchyard の容量は `SWITCHYARD_CAPACITY=4`
- 前の実測は [2026-09-24-effect.md](2026-09-24-effect.md)

## 1. PreToolUse の 1 回あたりの時間

同じ hook の入力を 30 回ずつ渡した平均。

| 入力 | node の判定を直に(0.8.0) | sh のふるいを通す(0.9.0) |
|---|---|---|
| `ls -la src \| head`(重い道具の名前が無い) | 58ms | 4ms |
| `npm install`(名前があるので node の判定へ) | 64ms | 68ms |

このセッションの Bash の呼び出し 324 件をふるいに通すと、123 件(38%)が node を起動せずに終わった。
switchyard 自身を作っているセッションで、`npm test` や `switchyard` を含む呼び出しが普段より多い。
ふるいが通したものについて node の判定も何もしないことは、`test/hooks/sieve.test.mjs` が確かめている。

## 2. 待ちが中心のテストの全件を 3 本同時に(学ぶ前)

switchyard 自身の `npm test`(平均 0.8 コア)を、新しい `SWITCHYARD_HOME`(何も学んでいない)で `--cpus 2..4` として
3 本同時に始めた。各条件 2 回。数字は各走行が終わった時刻(始めてから)。

| 条件 | 1 回目 | 2 回目 | 平均の完了 | 最後 |
|---|---|---|---|---|
| 素のまま | 19.0 / 19.2 / 19.5 秒 | 19.5 / 19.5 / 19.6 秒 | 19.4 秒 | 19.6 秒 |
| 詰め込みなし(`SWITCHYARD_OVERCOMMIT=0`・0.8.0 と同じ) | 17.6 / 35.8 / 35.9 秒 | 17.9 / 35.4 / 35.4 秒 | 29.7 秒 | 35.9 秒 |
| 詰め込みあり(既定) | 18.0 / 25.4 / 30.2 秒 | 17.8 / 25.0 / 30.1 秒 | 24.4 秒 | 30.2 秒 |

詰め込みありでは、2 本目と 3 本目が実測の空きに入った(`report` の「実測の空きに詰め込んだ入場: 2 件」)。
学ぶ前は、まだ素のままより遅い(平均 +26%)。走行が立ち上がるまで待ってから 1 本ずつ入れるため。

同じ全件を 2 回走らせて学んだ後に 3 本同時に始めると、20.0 / 20.5 / 20.6 秒だった(待ちなし。1 コアずつに縮めて入った)。
素のまま(19.4 秒)との差は約 5%。0.8.0 までは学ぶのに 3 回要った。

## 3. CPU を使い切る全件を 3 本同時に(詰め込まないこと)

4 本のスレッドで固定量を計算する全件(単独で約 4 秒)を `--cpus 4` で 3 本同時に。

| 条件 | 各走行が終わった時刻 | 平均の完了 | 最後 |
|---|---|---|---|
| 素のまま | 12.2 / 12.2 / 12.2 秒 | 12.2 秒 | 12.2 秒 |
| 詰め込みなし | 4.8 / 8.9 / 13.0 秒 | 8.9 秒 | 13.0 秒 |
| 詰め込みあり | 4.6 / 8.4 / 12.2 秒 | 8.4 秒 | 12.2 秒 |

機械が実際に忙しいので実測の空きが出ず、詰め込みは 0 件だった。平均の完了が約 30% 早いのはそのまま。

## 4. メモリを見た受け入れ(仕組みの確認)

この環境で本当に OOM を起こすと、作業しているシェルごと落ちかねない。そこで下限を高くして(`SWITCHYARD_MEM_FLOOR_MB=10500`・
空きは約 13GB)小さい機械を模した。1.5GB を確保して 4 秒持つ走行を 1 回走らせてピークを学び(1581MB と記録)、
その後 3 本同時に始めた。

| 条件 | 各走行が終わった時刻 | 待たせた理由 |
|---|---|---|
| メモリを見ない(`SWITCHYARD_MEMORY=0`) | 9.2 / 9.3 / 9.6 秒(3 本同時) | なし |
| メモリを見る(2 回) | 5.4 / 10.4 / 15.5 秒、6.1 / 11.0 / 16.1 秒 | メモリ待ち 1 件・先頭の後ろ 1 件 |

重ねると空きが下限を割る 2 本が、前の走行が終わるまで待った。スワップや OOM が避けられたときの時間の差は、この環境では
測っていない(起こしていないため)。

## スクリプト

```sh
# 2: 待ちが中心の全件を 3 本同時に(新しい SWITCHYARD_HOME = 学ぶ前)
export SWITCHYARD_HOME=$(mktemp -d) SWITCHYARD_CAPACITY=4 SWITCHYARD_OVERCOMMIT=1   # 0 で詰め込みなし
for j in 1 2 3; do switchyard run --cpus 2..4 -- npm test & done; wait
# 学んだ後
for k in 1 2; do switchyard run --cpus 2..4 -- npm test; done
for j in 1 2 3; do switchyard run --cpus 2..4 -- npm test & done; wait

# 3: CPU を使い切る全件(suite.js は 2026-09-24-effect.md と同じ)
for j in 1 2 3; do switchyard run --cpus 4 -- node suite.js & done; wait

# 4: メモリ(alloc.js は引数の MB を確保して触り、引数の ms だけ持つ)
export SWITCHYARD_MEMORY=1 SWITCHYARD_MEM_FLOOR_MB=10500
switchyard run --cpus 1 -- node alloc.js 1500 3000
for j in 1 2 3; do switchyard run --cpus 1 -- node alloc.js 1500 4000 & done; wait
```

```js
// alloc.js
const mb = Number(process.argv[2]); const ms = Number(process.argv[3]);
const bufs = []; for (let i = 0; i < mb; i += 64) { const b = Buffer.alloc(64 * 1048576); b.fill(1); bufs.push(b); }
setTimeout(() => console.log(bufs.length), ms);
```
