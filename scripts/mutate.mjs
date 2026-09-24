#!/usr/bin/env node
// @ts-check
// 門番の検出力を測る(設計 §15)。原本は触らず、一時ディレクトリの写しに変異を 1 つずつ入れて、組ごとのテストを回す。
// 使い方: node scripts/mutate.mjs <組の名前>   全部の変異が赤になれば終了コード 0、生き残った変異があれば 1。
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {{ name: string, file: string, from: string, to: string }} Mutation */
/** @type {Record<string, { tests: string[], mutations: Mutation[] }>} */
const SUITES = {
  core: {
    tests: [
      'test/core/decide.test.mjs',
      'test/core/estimate.test.mjs',
      'test/core/invariants.property.test.mjs',
      'test/core/recovery.test.mjs',
      'test/core/schedule.admission.test.mjs',
      'test/core/schedule.backfill.test.mjs',
      'test/core/schedule.lockchild.test.mjs',
      'test/core/schedule.lockonly.test.mjs',
      'test/core/schedule.measure.test.mjs',
      'test/core/schedule.preempt.test.mjs',
      'test/core/score.test.mjs',
      'test/core/usage.test.mjs',
      'test/core/schedule.overcommit.test.mjs',
    ],
    mutations: [
      {
        name: 'M24 実測の空きの大きさを見ずに詰め込む',
        file: 'src/core/schedule.mjs',
        from: 'spareLeft !== null && spareLeft >= job.cpus.min && locksFree(s, job.locks)',
        to: 'spareLeft !== null && locksFree(s, job.locks)',
      },
      {
        name: 'M25 1 回に何本も詰め込む(立ち上がる前の同じ空きで次を入れる)',
        file: 'src/core/schedule.mjs',
        from: 'spareLeft = null;',
        to: '',
      },
      {
        name: 'M26 鍵を見ずに詰め込む',
        file: 'src/core/schedule.mjs',
        from: 'spareLeft !== null && spareLeft >= job.cpus.min && locksFree(s, job.locks)',
        to: 'spareLeft !== null && spareLeft >= job.cpus.min',
      },
      {
        name: 'M40 割り振りを使い切る走行も縮める(割り振りの少なさを学んで縮み続ける)',
        file: 'src/core/usage.mjs',
        from: 'if (median(list.map((x) => x.ratio)) >= UNDERUSE_RATIO) return null;',
        to: '',
      },
      {
        name: 'M41 実測に合わせて宣言より上げる',
        file: 'src/core/usage.mjs',
        from: 'const min = Math.min(job.cpus.min, n);',
        to: 'const min = n;',
      },
      {
        name: 'M42 計測も縮める',
        file: 'src/core/usage.mjs',
        from: "if (cores === null || job.class !== 'batch' || job.cpus.max === 0) return job;",
        to: 'if (cores === null || job.cpus.max === 0) return job;',
      },
      {
        name: 'M43 すぐ落ちた失敗も使い方に数える',
        file: 'src/core/usage.mjs',
        from: 'durationMs < (code === 0 ? USAGE_MIN_DURATION_MS : USAGE_MIN_FAILED_DURATION_MS)',
        to: 'durationMs < USAGE_MIN_DURATION_MS',
      },
      {
        name: 'M44 長く走った失敗を使い方に数えない',
        file: 'src/core/usage.mjs',
        from: 'durationMs < (code === 0 ? USAGE_MIN_DURATION_MS : USAGE_MIN_FAILED_DURATION_MS)',
        to: 'code !== 0 || durationMs < USAGE_MIN_DURATION_MS',
      },
      {
        name: 'M30 後の成功で前の失敗を片付けない',
        file: 'src/core/decide.mjs',
        from: 'else s = resolveBySuccess(s, l.job.session, l.job.repo, l.job.profile, l.job.cmd);',
        to: '',
      },
      {
        name: 'M31 後の成功で、別の profile の失敗まで片付ける',
        file: 'src/core/decide.mjs',
        from: 'u.repo === repo && u.profile === profile &&',
        to: 'u.repo === repo &&',
      },
      {
        name: 'M32 子が走っている孤児も後の成功で片付ける',
        file: 'src/core/decide.mjs',
        from: "const RESOLVED_BY_SUCCESS = new Set(['failed', 'killed', 'lost']);",
        to: "const RESOLVED_BY_SUCCESS = new Set(['failed', 'killed', 'lost', 'orphan']);",
      },
      {
        name: 'M1 鍵の空き判定を緩める',
        file: 'src/core/schedule.mjs',
        from: 'return locks.every((k) => holders(s, k).length < capOf(s, k));',
        to: 'return locks.every((k) => holders(s, k).length <= capOf(s, k));',
      },
      {
        name: 'M2 計測の単独実行を外す',
        file: 'src/core/schedule.mjs',
        from: 'if (head === null && cpuLeases(s).length === 0 && locksFree(s, job.locks)) {',
        to: 'if (head === null && locksFree(s, job.locks)) {',
      },
      {
        name: 'M3 CPU の空き判定を 1 つ緩める',
        file: 'src/core/schedule.mjs',
        from: 'const fits = free >= job.cpus.min && locksFree(s, job.locks);',
        to: 'const fits = free + 1 >= job.cpus.min && locksFree(s, job.locks);',
      },
      {
        name: 'M4 計測の直後の優先を外す',
        file: 'src/core/schedule.mjs',
        from: 'if (s.favorNonMeasure) {',
        to: 'if (false) {',
      },
      {
        name: 'M5 exit でリースを返さない',
        file: 'src/core/decide.mjs',
        from: '      s = removeLease(s, e.jobId);\n      extra.push(',
        to: '      extra.push(',
      },
      {
        name: 'M6 後ろ詰めの時刻条件を外す',
        file: 'src/core/schedule.mjs',
        from: 'const endsBeforeHead = head.etaAt !== null && job.expectedMs !== null && now + job.expectedMs <= head.etaAt;',
        to: 'const endsBeforeHead = true;',
      },
      {
        name: 'M7 CPU 0 のリースも計測の単独に数える',
        file: 'src/core/schedule.mjs',
        from: 'if (head === null && cpuLeases(s).length === 0 && locksFree(s, job.locks)) {',
        to: 'if (head === null && s.leases.length === 0 && locksFree(s, job.locks)) {',
      },
      {
        name: 'M8 鍵だけのジョブも計測の走行中は止める',
        file: 'src/core/schedule.mjs',
        from: 'if (isLockOnly(job)) {',
        to: 'if (isLockOnly(job) && gate === null) {',
      },
      {
        name: 'M9 鍵だけのジョブが前で止まっている鍵を追い越す',
        file: 'src/core/schedule.mjs',
        from: 'const ahead = job.locks.find((k) => blocked.has(k));',
        to: 'const ahead = undefined;',
      },
      {
        // 改善 3: 親の子を点数の順より前に並べない
        name: 'M10 親の子を先頭に並べない',
        file: 'src/core/schedule.mjs',
        from: 'ordered = [...children, ...ordered.filter((w) => !children.includes(w))];',
        to: '',
      },
      {
        // 改善 3: 空きが cpus.min に足りなければ親の子も待たせる(借りを許さない)
        name: 'M11 親の子に容量を超えた借りを許さない',
        file: 'src/core/schedule.mjs',
        from: 'if (measuring === undefined && locksFree(s, job.locks)) {',
        to: 'if (measuring === undefined && locksFree(s, job.locks) && s.capacity - usedCpus(s) >= job.cpus.min) {',
      },
      {
        // 改善 3: 計測の走行中も親の子を入場させる(I3 を破る)
        name: 'M12 計測の走行中も親の子を入場させる',
        file: 'src/core/schedule.mjs',
        from: 'if (measuring === undefined && locksFree(s, job.locks)) {',
        to: 'if (locksFree(s, job.locks)) {',
      },
      {
        // 改善 3: 別のセッションの鍵だけのジョブを親として認める(自己申告で列を飛ばせる)
        name: 'M13 別のセッションの親でも親の子として扱う',
        file: 'src/core/schedule.mjs',
        from: ' && l.job.session === job.session);',
        to: ');',
      },
      {
        // 改善 3: 親の子のリースにも余りを配る
        name: 'M14 親の子のリースにも余りを配る',
        file: 'src/core/schedule.mjs',
        from: 'if (lease.lockChild === true) continue;',
        to: '',
      },
      {
        // 改善 3・最終レビュー I-2: usedCpus が親の子の借りを数えない(二重に貸さないという性質そのものを壊す)
        name: 'M15 usedCpus が親の子の借りを数えない',
        file: 'src/core/schedule.mjs',
        from: 'return s.leases.reduce((n, l) => n + (isHeld(l) ? 0 : l.cpus), 0);',
        to: 'return s.leases.reduce((n, l) => n + (isHeld(l) || l.lockChild === true ? 0 : l.cpus), 0);',
      },
      {
        // 改善 3・最終レビュー I-1(オーナー決定): 親ごとの借りの上限(1 本まで)を外す
        name: 'M16 親ごとの借りの上限を外す',
        file: 'src/core/schedule.mjs',
        from: 'if (s.leases.some((l) => l.lockChild === true && l.job.parent === parent)) return false;',
        to: '',
      },
      {
        // 最終レビュー再レビュー: children の並べ替えで親ごとに 1 本へ絞らない(2 本目以降も先頭へ回ってしまう)
        name: 'M17 親の子の並べ替えで親ごとに 1 本へ絞らない',
        file: 'src/core/schedule.mjs',
        from: 'if (seenParents.has(w.job.parent)) return false;',
        to: '',
      },
      {
        name: 'M19 計測でなくても道を譲らせる(容量が足りないだけで止める)',
        file: 'src/core/schedule.mjs',
        from: "const headMeasure = runningMeasure === undefined && ordered.length > 0 && ordered[0].job.class === 'measure' ? ordered[0].job : null;",
        to: 'const headMeasure = runningMeasure === undefined && ordered.length > 0 ? ordered[0].job : null;',
      },
      {
        name: 'M20 never を宣言したジョブも止める',
        file: 'src/core/schedule.mjs',
        from: "l.job.preempt !== 'never' && l.job.class !== 'measure'",
        to: "l.job.class !== 'measure'",
      },
      {
        name: 'M21 計測と鍵が重なる相手も止める(鍵が返らず永久に待つ)',
        file: 'src/core/schedule.mjs',
        from: ' && !l.job.locks.some((k) => measure.locks.includes(k)),',
        to: ',',
      },
      {
        name: 'M22 止めたリースも単独判定に数える(計測が入場できない)',
        file: 'src/core/schedule.mjs',
        from: 'return s.leases.filter((l) => l.cpus > 0 && !isHeld(l));',
        to: 'return s.leases.filter((l) => l.cpus > 0);',
      },
      {
        name: 'M23 計測が消えても止めたものを戻さない',
        file: 'src/core/schedule.mjs',
        from: "      for (const l of releases) holdActions.push({ type: 'unhold', jobId: l.job.id });\n",
        to: '',
      },
      {
        // 記録: 借りて入場したことを grant に載せない(記録から借りの回数を数えられなくなる)
        name: 'M18 grant に借りの印を載せない',
        file: 'src/core/schedule.mjs',
        from: '...(l.lockChild === true ? { lockChild: true } : {})',
        to: '',
      },
    ],
  },
  report: {
    tests: ['test/report/report.test.mjs', 'test/cli/report.test.mjs'],
    mutations: [
      {
        // 待たせた理由の種別を取り違える(計測待ちが「その他」に落ちる)
        name: 'R1 計測の理由を見ない',
        file: 'src/report/report.mjs',
        from: "if (reason.includes('計測') || reason.includes('measurement')) return 'measure';",
        to: '',
      },
      {
        name: 'R6 重なりを避けた走行を数えない',
        file: 'src/report/report.mjs',
        from: "if (k !== 'other') avoided += 1;",
        to: '',
      },
      {
        name: 'R7 単独で走らせた計測を数えない',
        file: 'src/report/report.mjs',
        from: "if (r.class === 'measure') measureRuns += 1;",
        to: '',
      },
      {
        name: 'R2 借りて入場した件数を数えない',
        file: 'src/report/report.mjs',
        from: 'if (d.lockChild === true) borrows += 1;',
        to: '',
      },
      {
        name: 'R3 中央値の代わりに平均を出す',
        file: 'src/report/report.mjs',
        from: 'return sorted[Math.floor((sorted.length - 1) / 2)];',
        to: 'return sorted.reduce((a, b) => a + b, 0) / sorted.length;',
      },
      {
        name: 'R4 repo と期間の絞り込みを外す',
        file: 'src/report/report.mjs',
        from: '(repoPrefix === null || repo.startsWith(repoPrefix)) && (since === null || (at !== null && at >= since))',
        to: 'true',
      },
      {
        name: 'R5 待ち時間を常に 0 とする',
        file: 'src/report/report.mjs',
        from: 'Math.max(0, (at ?? req.at) - req.at)',
        to: '0',
      },
    ],
  },
  escape: {
    tests: ['test/run/watch.test.mjs', 'test/run/probe.test.mjs', 'test/run/run.test.mjs', 'test/daemon/server.test.mjs', 'test/cli/main.test.mjs'],
    mutations: [
      {
        name: 'E1 グループの違いを見ない',
        file: 'src/run/watch.mjs',
        from: 'for (const [, v] of seen) if (v.pgid !== pgid) counts.set',
        to: 'for (const [, v] of seen) if (v.pgid !== v.pgid) counts.set',
      },
      {
        name: 'E2 走行中に子孫を見ない',
        file: 'src/run/run.mjs',
        from: 'let everyMs = watchMs;',
        to: 'let everyMs = 86_400_000;',
      },
      {
        name: 'E6 見張りの間隔を後退させたまま戻さない',
        file: 'src/run/watch.mjs',
        from: 'return changed ? baseMs : Math.min(current * 2, maxMs);',
        to: 'return Math.min(current * 2, maxMs);',
      },
      {
        name: 'E7 子孫が増えても変化なしと答える',
        file: 'src/run/watch.mjs',
        from: 'if (known === undefined || known.pgid !== r.pgid || known.comm !== comm) changed = true;',
        to: 'if (known !== undefined && known.pgid !== r.pgid) changed = true;',
      },
      {
        // I2: 開始時刻(started)の照合をやめ、使い回された pid を同じ子とみなしてしまう変異
        name: 'E3 使い回された pid を同じ子とみなす(開始時刻を照合しない)',
        file: 'src/run/watch.mjs',
        from: 'const orphanedSame = known !== undefined && r.ppid === 1 && known.started === r.started;',
        to: 'const orphanedSame = known !== undefined;',
      },
      {
        name: 'E4 デーモンが抜けた子の名前を覚えない',
        file: 'src/daemon/server.mjs',
        from: 'for (const e of escape.escaped) names.add(e.comm);',
        to: '',
      },
      {
        // 記録: 入場と待たせた理由を events.jsonl に残さない(後から待ち時間と理由を数えられなくなる)
        name: 'E5 決定(grant / queued)を記録しない',
        file: 'src/daemon/server.mjs',
        from: "appendRecord(p.events, { at: wallNow(), kind: 'decision', decision: a });",
        to: '',
      },
    ],
  },
  wrap: {
    tests: ['test/run/nest.test.mjs', 'test/run/signals.test.mjs', 'test/daemon/unmanaged.test.mjs'],
    mutations: [
      {
        name: 'W1 祖先が持つ鍵を外さない',
        file: 'src/run/run.mjs',
        from: '.filter((k) => !held.has(k)),',
        to: ',',
      },
      {
        name: 'W2 CPU を持つジョブの子に入れ子の印を立てない',
        file: 'src/run/run.mjs',
        from: "if (cpus > 0) childEnv.SWITCHYARD_IN_JOB = '1';",
        to: '',
      },
      {
        name: 'W3 入れ子で何も要らなくてもデーモンに要求する',
        file: 'src/run/run.mjs',
        from: 'if (job.cpus.max === 0 && job.locks.length === 0) {',
        to: 'if (false) {',
      },
      {
        name: 'W4 CPU を持つジョブの中でも CPU を要求する',
        file: 'src/run/run.mjs',
        from: "cpus: env.SWITCHYARD_IN_JOB === '1' ? { min: 0, max: 0 } : flags.cpus",
        to: 'cpus: flags.cpus',
      },
      {
        name: 'W5 グループの確かめ方を差し替えられない',
        file: 'src/run/run.mjs',
        from: 'pgid = verifyGroup(c.pid, ownPgid);',
        to: 'pgid = verifiedGroup(c.pid, ownPgid);',
      },
      {
        name: 'W6 デーモンが管理なしの失敗を ack 待ちに積まない',
        file: 'src/daemon/server.mjs',
        from: "apply({ type: 'unmanagedExit', now: monoNow(),",
        to: "void ({ type: 'unmanagedExit', now: monoNow(),",
      },
      {
        name: 'W7 管理なしで走っても控えない',
        file: 'src/run/run.mjs',
        from: 'if (unmanaged) {',
        to: 'if (false) {',
      },
      {
        name: 'W8 待っている間にデーモンが要求を拒んでも待ち続ける',
        file: 'src/run/run.mjs',
        from: "} else if (m.t === 'error' && phase === 'waiting') {",
        to: '} else if (false) {',
      },
      {
        // I3: 生きているデーモンの横で書かれた控えを、次の起動まで取り込まない(直す前の形)
        name: 'W9 tick で控えを取り込まない',
        file: 'src/daemon/server.mjs',
        from: '    try {\n      ingestUnmanaged();',
        to: '    try {\n      void 0;',
      },
      {
        // m4: rename と unlink の間で落ちて残った別名を拾わない
        name: 'W10 残った別名(.taking)を拾わない',
        file: 'src/daemon/store.mjs',
        from: ".filter((name) => name.startsWith(prefix) && name.endsWith('.taking'))",
        to: '.filter(() => false)',
      },
      {
        // 改善 3: 鍵だけのジョブの子の要求に、親のジョブの id を載せない(規則層が親の子として先に入れられない)
        name: 'W11 鍵だけのジョブの子の要求に parent を載せない',
        file: 'src/run/run.mjs',
        from: "const parent = held.size > 0 && env.SWITCHYARD_IN_JOB !== '1' && env.SWITCHYARD_JOB_ID ? env.SWITCHYARD_JOB_ID : null;",
        to: 'const parent = null;',
      },
    ],
  },
  shim: {
    tests: ['test/shim/decide.test.mjs', 'test/shim/shims.test.mjs', 'test/hooks/agreement.test.mjs'],
    mutations: [
      {
        name: 'D1 CPU を持つジョブの中でも分類する',
        file: 'src/shim/decide.mjs',
        from: "if (env.SWITCHYARD_IN_JOB === '1') return { kind: 'pass' };",
        to: '',
      },
      {
        // I2: bin/switchyard が PATH の node(node の shim)を通っても、switchyard の CLI 自身を外側のジョブに包まない
        name: 'D2 switchyard の CLI 自身も分類して包む',
        file: 'src/shim/decide.mjs',
        from: "if (word === 'node' && isOwnCli(args[0], cwd)) return { kind: 'pass' };",
        to: '',
      },
      {
        // I4: 分類器が失敗したら本物へ行く(shim の失敗で作業を止めない)
        name: 'S6 分類器が失敗したら作業を止める',
        file: 'shims/_shim.sh',
        from: '2>/dev/null) || exec "$real" "$@"',
        to: '2>/dev/null) || exit 1',
      },
      {
        // I4: 想定外の答えでも本物へ行く
        name: 'S7 分類器の想定外の答えで作業を止める',
        file: 'shims/_shim.sh',
        from: '\n  *) exec "$real" "$@" ;;\nesac',
        to: '\n  *) exit 1 ;;\nesac',
      },
      {
        name: 'S2 node が無いと作業を止める',
        file: 'shims/_shim.sh',
        from: '[ -n "$node" ] || exec "$real" "$@"',
        to: '[ -n "$node" ] || exit 1',
      },
      {
        name: 'S3 祖先が持つ git の鍵も取りに行く',
        file: 'src/shim/decide.mjs',
        from: "return heldLocks(env).has(lock) ? { kind: 'pass' } : { kind: 'lock', lock };",
        to: "return { kind: 'lock', lock };",
      },
      {
        name: 'S4 管理対象を包まない',
        file: 'shims/_shim.sh',
        from: '"run "*) exec',
        to: '"never-run "*) exec',
      },
      {
        name: 'S5 git の鍵だけのジョブを作らない',
        file: 'shims/_shim.sh',
        from: '"lock "*) exec',
        to: '"never-lock "*) exec',
      },
    ],
  },
  hooks: {
    tests: ['test/hooks/pretooluse.test.mjs', 'test/hooks/main.test.mjs', 'test/hooks/session.test.mjs', 'test/hooks/agreement.test.mjs', 'test/hooks/shell.test.mjs', 'test/hooks/sieve.test.mjs'],
    mutations: [
      {
        name: 'H1 既に背景でも書き換える',
        file: 'src/hooks/pretooluse.mjs',
        from: 'if (heavy.length > 0 && ti.run_in_background !== true && shouldBackground(heavy)) {',
        to: 'if (heavy.length > 0 && shouldBackground(heavy)) {',
      },
      {
        // 待ちが見込まれないのに背景へ回す(エージェントが完了の通知を待たされる)
        name: 'H20 CPU の空きを見ずに、重ければ背景へ回す',
        file: 'src/hooks/pretooluse.mjs',
        from: 'if (need <= snap.capacity - snap.used) return false;',
        to: '',
      },
      {
        name: 'H25 待ちの見込みに、実測の空き(詰め込み)を使わない',
        file: 'src/hooks/pretooluse.mjs',
        from: "return !(heavy.length === 1 && typeof snap.spare === 'number' && need <= snap.spare);",
        to: 'return true;',
      },
      {
        name: 'H26 重い部分が 2 つ以上でも詰め込まれると見込む',
        file: 'src/hooks/pretooluse.mjs',
        from: "return !(heavy.length === 1 && typeof snap.spare === 'number' && need <= snap.spare);",
        to: "return !(typeof snap.spare === 'number' && need <= snap.spare);",
      },
      {
        name: 'H27 ふるいが npm を見落とす',
        file: 'bin/switchyard-pretooluse.awk',
        from: '(npm|npx|',
        to: '(npx|',
      },
      {
        name: 'H28 ふるいが switchyard.json を見ない',
        file: 'bin/switchyard-pretooluse.awk',
        from: 'if (exists(d "/switchyard.json") || exists(d "/conductor.json")) exit 1',
        to: 'if (exists(d "/conductor.json")) exit 1',
      },
      {
        name: 'H29 ふるいが改行のエスケープを語の境目にしない',
        file: 'bin/switchyard-pretooluse.awk',
        from: '  gsub(/\\\\[nrtbf]/, " ", cmd)\n',
        to: '',
      },
      {
        name: 'H30 ふるいが git の index を書き換えるサブコマンドを見落とす',
        file: 'bin/switchyard-pretooluse.awk',
        from: '(commit|merge|',
        to: '(merge|',
      },
      {
        name: 'H23 shim から見えない重い形を拒否しない',
        file: 'src/hooks/pretooluse.mjs',
        from: 'if (invisible.length > 0) {',
        to: 'if (false) {',
      },
      {
        name: 'H24 仮想環境を有効にした後の走行を見逃す',
        file: 'src/hooks/pretooluse.mjs',
        from: '(isVenvPath(head) || (activated && !pathHead))',
        to: 'isVenvPath(head)',
      },
      {
        name: 'H22 待ちの見込みに、実測で縮めた要求を使わない',
        file: 'src/hooks/pretooluse.mjs',
        from: "const min = cores === undefined ? h.cpusMin : rightSize({ class: h.jobClass, cpus: { min: h.cpusMin, max: h.cpusMin } }, cores).cpus.min;",
        to: 'const min = h.cpusMin;',
      },
      {
        name: 'H21 auto の方針でもデーモンの盤面を見ない',
        file: 'src/hooks/main.mjs',
        from: "out = preToolUse(input, { ...base, shouldBackground: (heavy) => snap !== null && waitExpected(snap, heavy, repo) });",
        to: '',
      },
      {
        name: 'H2 背景への書き換えに allow を付ける(権限の確認を飛ばす)',
        file: 'src/hooks/pretooluse.mjs',
        from: "return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, run_in_background: true } } };",
        to: "return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...ti, run_in_background: true } } };",
      },
      {
        // 改善 2: 拒否するのは shim の語の実行ファイルをパスで直に呼ぶ形(/usr/local/bin/npm test)だけ
        name: 'H3 shim の語をパスで直に呼ぶ形を拒否しない',
        file: 'src/hooks/pretooluse.mjs',
        from: '} else if (!wrapped) {',
        to: '} else if (false) {',
      },
      {
        // 改善 2: 直す前の形。shim の語でないものをパスで呼ぶ形(scripts/probe-run.sh)と shim の無い語も拒否する
        name: 'H10 shim の語でないものをパスで呼ぶ形・shim の無い語も拒否へ戻す',
        file: 'src/hooks/pretooluse.mjs',
        from: "if (!wrapped && hit !== null && launches && hit.profile.class !== 'quick') heavy.push(needOf(hit.profile, hit.name));",
        to: 'if (!wrapped && hit !== null && launches) unshimmed.push(text);',
      },
      {
        // 改善 2: scripts/probe-run.sh gates npm run bench の中の npm は PATH の shim が包むので、背景に回す
        name: 'H17 パスで呼ぶスクリプトの引数の中の shim の語を見ない',
        file: 'src/hooks/pretooluse.mjs',
        from: 'if (at >= 0) visit(rest.slice(at), true);',
        to: '',
      },
      {
        // 改善 2: node -e のコードの中身(benchmarks・vitest run など)で分類する(直す前の形)
        name: 'H18 node -e のコードの中身で分類する',
        file: 'src/config/profiles.mjs',
        from: "if (basename(words[0]) !== 'node') return words.join(' ');",
        to: "return words.join(' ');",
      },
      {
        // 改善 2: 既定表の measure(全文に当たる *bench* / *measure*)を戻す(直す前の形)
        name: 'H19 既定表に *bench* / *measure* の measure を戻す',
        file: 'src/config/profiles.mjs',
        from: 'export const DEFAULT_PROFILES = [\n',
        to: "export const DEFAULT_PROFILES = [\n  { name: 'default:measure', profile: { match: ['*bench*', '*measure*'], class: 'measure', cpus: { min: 1, max: 1000 } } },\n",
      },
      {
        name: 'H4 timeout の値を読み飛ばさない',
        file: 'src/hooks/pretooluse.mjs',
        from: "while (i < words.length && words[i].startsWith('-')) i += words[i] === '-s' || words[i] === '-k' ? 2 : 1;\n      i += 1;",
        to: '',
      },
      {
        name: 'H5 switchyard run で包んだ中も拒否の判定にかける',
        file: 'src/hooks/pretooluse.mjs',
        from: 'visit(w.argv, true);',
        to: 'visit(w.argv, false);',
      },
      {
        // C1(改善 2 で拒否から背景へ移した後も同じ守り): glob が語の途中に当たっただけの読むだけのコマンド(grep -rn "vitest run" src)を重い走行と見なさない
        name: 'H20 glob が語の途中に当たっただけの部分も背景に回す',
        file: 'src/hooks/pretooluse.mjs',
        from: 'const launches = pathHead || profiles.some((np) => np.profile.match.some((g) => leadWord(g) === head && globMatch(g, ownText)));',
        to: 'const launches = true;',
      },
      {
        // C1: shim は git を profile で分類しないのに、PreToolUse だけが分類する(直す前の形)
        name: 'H11 git の部分も profile で分類する',
        file: 'src/hooks/pretooluse.mjs',
        from: "if (base === 'git') {",
        to: "if (base === 'never-git') {",
      },
      {
        // I1: switchyard run の `--` の後ろを見ない(直す前は switchyard run を含むコマンドを丸ごと素通しした)
        name: 'H12 switchyard run の包みの性格と -- の後ろを見ない',
        file: 'src/hooks/pretooluse.mjs',
        from: "if (w.jobClass !== 'quick') heavy.push({ jobClass: w.jobClass, cpusMin: w.cpusMin, locks: w.locks });\n      visit(w.argv, true);",
        to: '',
      },
      {
        // I1: bash -c "…" の中を見ない
        name: 'H13 bash -c の引用の中を見ない',
        file: 'src/hooks/pretooluse.mjs',
        from: 'for (const inner of simpleCommands(script)) visit(inner, wrapped);',
        to: '',
      },
      {
        // I1: env -u NAME の値を読み飛ばさない
        name: 'H14 env の値つきオプションの値を読み飛ばさない',
        file: 'src/hooks/pretooluse.mjs',
        from: 'i += ENV_VALUE_OPTIONS.has(words[i]) ? 2 : 1;',
        to: 'i += 1;',
      },
      {
        // C1: heredoc の本文をコマンドとして読む(本文の行の npm test や ; で判定が変わる)
        name: 'H15 heredoc の本文を読み飛ばさない',
        file: 'src/hooks/shell.mjs',
        from: 'i = skipHeredocs(src, i + 1, heredocs);',
        to: 'i += 1;',
      },
      {
        // I1: ( … ) の中の単純コマンドを捨てる
        name: 'H16 ( … ) の中を見ない',
        file: 'src/hooks/shell.mjs',
        from: "      endCommand();\n      i = parse(src, i + 1, ')', out);",
        to: "      endCommand();\n      i = parse(src, i + 1, ')', []);",
      },
      {
        name: 'H6 考える層の中でも判定する',
        file: 'src/hooks/pretooluse.mjs',
        from: "if (env.SWITCHYARD_THINKER === '1') return null;",
        to: '',
      },
      {
        name: 'H7 Stop が 2 度目の停止も差し戻す',
        file: 'src/hooks/session.mjs',
        from: "if (env.SWITCHYARD_THINKER === '1' || input.stop_hook_active === true) return null;",
        to: "if (env.SWITCHYARD_THINKER === '1') return null;",
      },
      {
        name: 'H8 SessionStart が同じ行を何度も足す',
        file: 'src/hooks/session.mjs',
        from: "if (!text.split('\\n').includes(line)) appendFileSync(",
        to: 'if (true) appendFileSync(',
      },
      {
        name: 'H9 SessionStart が版の違いを知らせない',
        file: 'src/hooks/session.mjs',
        from: 'if (snap.version !== version) {',
        to: 'if (false) {',
      },
      {
        // 記録: 背景へ回した判断を hooks.jsonl に残さない
        name: 'H21 hook の判断を記録しない',
        file: 'src/hooks/main.mjs',
        from: '  recordPreToolUse(input, out, env);\n',
        to: '',
      },
      {
        // 記録: 拒否も背景として記録する(種別が読めなくなる)
        name: 'H22 拒否を背景として記録する',
        file: 'src/hooks/main.mjs',
        from: "const decision = h.permissionDecision === 'deny' ? 'deny' : 'background';",
        to: "const decision = 'background';",
      },
      {
        // 記録: 何もしなかった分(out が null)まで書こうとする
        name: 'H23 何もしなかった分まで記録しようとする',
        file: 'src/hooks/main.mjs',
        from: '  if (out === null) return;\n',
        to: '',
      },
    ],
  },
  pack: {
    tests: ['test/daemon/overcommit.test.mjs', 'test/daemon/server.test.mjs'],
    mutations: [
      {
        name: 'P1 学んでいない走行の立ち上がりを待たない',
        file: 'src/daemon/server.mjs',
        from: '(l.typical === null ? RAMP_UNKNOWN_MS : RAMP_KNOWN_MS)',
        to: 'RAMP_KNOWN_MS',
      },
      {
        name: 'P2 学んだ使い方の見込みを空きの計算に使わない',
        file: 'src/daemon/server.mjs',
        from: 'capacity - Math.max(busyCores, predicted)',
        to: 'capacity - busyCores',
      },
      {
        name: 'P3 窓の長さを見ずに測る',
        file: 'src/daemon/server.mjs',
        from: 'x.at >= settled && last.at - x.at >= SPARE_WINDOW_MS',
        to: 'x.at >= settled',
      },
      {
        name: 'P4 標本を取っても割り振りを見直さない(tick まで待つ)',
        file: 'src/daemon/server.mjs',
        from: 'if (sp !== null && sp >= 1) apply',
        to: 'if (false) apply',
      },
    ],
  },
  group: {
    tests: ['test/run/group.test.mjs'],
    mutations: [
      {
        name: 'G1 孫(子の pgid ≠ 子の pid)の拒否を外す',
        file: 'src/run/group.mjs',
        from: 'if (pgid !== childPid || pgid === ownPgid) return null;',
        to: 'if (pgid === ownPgid) return null;',
      },
      {
        name: 'G2 自分のグループと同じ pgid の拒否を外す',
        file: 'src/run/group.mjs',
        from: 'if (pgid !== childPid || pgid === ownPgid) return null;',
        to: 'if (pgid !== childPid) return null;',
      },
    ],
  },
};

/** 変異で止まったテストに、走行ごと付き合わない上限 */
const TEST_TIMEOUT_MS = 180_000;

/**
 * 写しでテストを走らせる。テストは自分のプロセスグループで起動し、時間切れにはそのグループごと SIGKILL する
 * (親だけを殺すと、テストファイルのプロセスが孤児として残る)。時間切れは件数の行が出ないので「生き残り」に数える
 * (外から殺された走行を赤に見せない)。
 * @param {string} dir @param {string[]} tests
 * @returns {Promise<{ stdout: string, stderr: string, timedOut: boolean }>}
 */
function runTests(dir, tests) {
  return new Promise((resolve) => {
    // SWITCHYARD_HOME は写しの中へ向ける(env を渡さないと、テストの試算が実際の ~/.switchyard/ を汚す)
    // テストは日本語の文言で照合する(package.json の npm test と同じ)
    const env = { ...process.env, SWITCHYARD_HOME: join(dir, '.switchyard-home'), SWITCHYARD_LANG: 'ja', SWITCHYARD_UPDATE_CHECK: '0' };
    // 入れ子の印を落とす(package.json の `env -u` と同じ)。この script 自身が switchyard に包まれて走ると
    // SWITCHYARD_IN_JOB=1 が立ち、それが test へ漏れると、その印を読む側の振る舞いを試す試験が別物になる
    delete env.SWITCHYARD_IN_JOB;
    delete env.SWITCHYARD_HELD_LOCKS;
    delete env.SWITCHYARD_JOB_ID;
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', ...tests], { cwd: dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', (s) => (stdout += s));
    child.stderr.setEncoding('utf8').on('data', (s) => (stderr += s));
    const timer = setTimeout(() => {
      timedOut = true;
      // detached で起動したので、子の pgid は子の pid(このスクリプトのグループではない)
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // 既に居ない
        }
      }
    }, TEST_TIMEOUT_MS);
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut });
    });
  });
}

const suiteName = process.argv[2] ?? '';
const suite = SUITES[suiteName];
if (suite === undefined) {
  console.error(`使い方: node scripts/mutate.mjs <${Object.keys(SUITES).join(' | ')}>`);
  process.exit(2);
}

let survived = 0;
for (const m of suite.mutations) {
  const dir = mkdtempSync(join(tmpdir(), 'cmut-'));
  try {
    for (const sub of ['bin', 'shims', 'src', 'test', 'testkit']) {
      if (existsSync(join(root, sub))) cpSync(join(root, sub), join(dir, sub), { recursive: true });
    }
    cpSync(join(root, 'package.json'), join(dir, 'package.json'));
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    const file = join(dir, m.file);
    const src = readFileSync(file, 'utf8');
    const count = src.split(m.from).length - 1;
    if (count !== 1) throw new Error(`${m.name}: 置き換え元が ${count} 箇所ある(1 箇所であるべき)`);
    writeFileSync(file, src.replace(m.from, m.to));
    const r = await runTests(dir, suite.tests);
    const out = `${r.stdout}${r.stderr}`;
    if (r.timedOut) console.log(`   走行が ${TEST_TIMEOUT_MS}ms で終わらず、テストのプロセスグループごと止めた`);
    const num = (/** @type {string} */ k) => (out.match(new RegExp(`^ℹ ${k} (\\d+)`, 'm')) ?? [])[1] ?? '?';
    const section = out.includes('✖ failing tests:') ? out.split('✖ failing tests:')[1] : '';
    /** @type {string[]} */
    const red = [];
    for (const line of section.split('\n')) {
      const hit = line.match(/^✖ (.+?) \(\d/);
      if (hit && !red.includes(hit[1])) red.push(hit[1]);
    }
    // テストごとの時間の上限で打ち切られたテストは fail ではなく cancelled に数えられる。どちらも赤とする
    const redCount = (/** @type {string} */ k) => num(k) !== '0' && num(k) !== '?';
    const killed = redCount('fail') || redCount('cancelled');
    if (!killed) survived += 1;
    console.log(`== ${m.name} | ${m.file} | ${killed ? '赤' : '生き残り'} | tests ${num('tests')} / fail ${num('fail')} / cancelled ${num('cancelled')} / pass ${num('pass')}`);
    console.log(`   壊した行: ${m.to.trim() === '' ? '(行を消した)' : m.to.trim()}`);
    for (const name of red) console.log(`   赤: ${name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(survived === 0 ? '全部の変異が赤になった' : `生き残った変異: ${survived}`);
process.exitCode = survived === 0 ? 0 : 1;
