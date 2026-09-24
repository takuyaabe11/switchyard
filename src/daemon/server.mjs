// @ts-check
// デーモンの殻。socket・時計・ファイルを持ち、判断は decide に任せる(設計 §4.2)。
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { connect as netConnect, createServer } from 'node:net';
import { availableParallelism, cpus as osCpus, freemem, totalmem } from 'node:os';
import { decide, initialState } from '../core/decide.mjs';
import { rebaseForRecovery } from '../core/recovery.mjs';
import { usedCpus } from '../core/schedule.mjs';
import { sortWaiting } from '../core/score.mjs';
import { numOrNull, parseEscape, parseJobRequest } from '../protocol/messages.mjs';
import { createDecoder, encode } from '../protocol/ndjson.mjs';
import { groupHasLiveMembers, rssByGroup } from '../run/group.mjs';
import { effectiveAvailableMb } from '../core/memory.mjs';
import { environmentalReasons } from '../core/diagnose.mjs';
import { VERSION } from '../version.mjs';
import { ensurePrivateDir, pathsOf, SOCKET_PATH_LIMIT, tightenFiles } from './paths.mjs';
import { IS_WINDOWS } from '../platform.mjs';
import { rightSize } from '../core/usage.mjs';
import { appendRecord, createStateWriter, loadEscapes, loadEstimates, loadMemory, loadUsage, parseState, readJournal, readJson, rotateRecords, takeUnmanaged } from './store.mjs';
import { t } from '../i18n.mjs';

/** @typedef {import('../core/types.mjs').State} State */
/** @typedef {import('../core/types.mjs').Event} Event */
/** @typedef {import('../core/types.mjs').Action} Action */
/** @typedef {import('../protocol/messages.mjs').Snapshot} Snapshot */
/** @typedef {import('node:net').Socket} Socket */

/**
 * @typedef {{
 *   home: string,
 *   capacity: number,
 *   lockCaps?: Record<string, number>,
 *   tickMs?: number,
 *   heartbeatTimeoutMs?: number,
 *   recoveryGraceMs?: number,
 *   idleExitMs?: number | null,
 *   adaptive?: boolean,
 *   overcommit?: boolean,
 *   sampleMs?: number,
 *   readBusyMs?: () => number,
 *   cores?: number,
 *   memory?: boolean,
 *   memFloorMb?: number,
 *   memSampleMs?: number,
 *   readAvailableMb?: () => number,
 *   readRss?: () => Promise<Map<number, number>>,
 *   onIdleExit?: () => void,
 *   onShutdown?: (() => void) | null,
 *   isAlive?: (pgid: number) => boolean,
 *   monoNow?: () => number,
 *   wallNow?: () => number
 * }} DaemonOptions
 */

/**
 * プロセスグループがまだ存在するか(信号 0 は存在確認だけで、何も起こさない)。
 * ゾンビだけが残ったグループは終わったとみなす(init が回収しないコンテナで、孤児のリースが返らなくなる)。
 * @param {number} pgid
 */
export function isGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
  return groupHasLiveMembers(pgid);
}

const defaultMono = () => Number(process.hrtime.bigint() / 1_000_000n);

/** 機械全体で CPU が働いた時間の累計(全コアの合計・ms)。idle 以外の時間 */
export function busyMsOfMachine() {
  let busy = 0;
  for (const c of osCpus()) busy += c.times.user + c.times.nice + c.times.sys + c.times.irq;
  return busy;
}

/**
 * 走行に並列度として渡すスレッド数。
 * - ふつうは割り当てたコア数(他の走行と機械を分け合っているときに、取り分を超えて取り合わせない)
 * - 実測で取り分を縮めた走行(待ちと入出力が中心)は、宣言の最大(容量まで)。CPU をあまり使わないのでスレッドを増やしても
 *   取り合わず、縮めたコア数に縛ると待ちが直列になって遅くなる
 * - 容量いっぱいを割り当てた走行は、機械の全コア数。予約のコアは人とエージェントのためだが、テストの結果を待つ間は
 *   ほとんど使われない。縛ると単独の走行が 1/コア数 ほど遅くなるだけ(実測: go test 9.4 秒 → 10.4 秒)
 * @param {{ cpus: number, job: { sizedFrom?: { min: number, max: number } } }} lease @param {number} capacity @param {number} cores
 * @returns {number}
 */
export function threadsOf(lease, capacity, cores) {
  const from = lease.job.sizedFrom;
  const n = from === undefined ? lease.cpus : Math.max(lease.cpus, Math.min(from.max, capacity));
  return n >= capacity ? Math.max(n, cores) : n;
}

/** 機械(コンテナなら cgroup の上限の中)で使えるメモリ(MB) */
export function availableMbOfMachine() {
  const avail = typeof process.availableMemory === 'function' ? process.availableMemory() : freemem();
  return avail / 1_048_576;
}

/** 全体のメモリ(MB)。コンテナの上限があればそちら */
export function totalMbOfMachine() {
  const limit = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  return (limit > 0 && limit < totalmem() ? limit : totalmem()) / 1_048_576;
}

/** 残しておくメモリの既定(全体の 10%) */
export const MEM_FLOOR_RATIO = 0.1;

/** 実測の空きを測る窓の長さ(ms) */
export const SPARE_WINDOW_MS = 1_500;
/** 入場した走行が立ち上がるまで待つ時間(ms)。使い方を学んだ profile の走行 */
export const RAMP_KNOWN_MS = 1_000;
/** 使い方をまだ学んでいない profile の走行(テストランナーの起動・コンパイルの間は CPU を使わないことがある) */
export const RAMP_UNKNOWN_MS = 3_000;

/**
 * 実測の空き(schedule の詰め込みに渡す)。直近の窓(SPARE_WINDOW_MS)で測った機械全体の使用コア数に、窓の間に立ち上がりの途中だった
 * 走行の見込み(学んだ使い方。学んでいなければ割り当てたコア数)を足し、学んだ使い方の見込みの合計と比べて大きい方を容量から引く。
 * 立ち上がりの途中の走行はまだ使い切っていないので、実測だけでは空いて見える。以前は全ての走行が立ち上がるまで測らなかったが、
 * 短い走行が次々に入る混み合った時間には一度も測れず、詰め込みが働かなかった(利用者の 6 日間の記録で詰め込み 0 回・CPU 待ち 86 本)。
 * 窓の長さの標本が無ければ null。
 * @param {{ capacity: number, samples: Array<{ at: number, busy: number }>, leases: Array<{ grantedAt: number, typical: number | null, cpus: number }> }} input
 * @returns {number | null}
 */
export function spareOf({ capacity, samples, leases }) {
  const last = samples[samples.length - 1];
  if (last === undefined) return null;
  // 窓の始まり: 最後の標本から窓の長さ以上さかのぼった、最も新しい標本
  /** @type {{ at: number, busy: number } | undefined} */
  let first;
  for (let i = samples.length - 2; i >= 0; i -= 1) {
    if (last.at - samples[i].at >= SPARE_WINDOW_MS) {
      first = samples[i];
      break;
    }
  }
  if (first === undefined) return null;
  const busyCores = Math.max(0, last.busy - first.busy) / (last.at - first.at);
  const from = first.at;
  const ramping = leases.filter((l) => l.grantedAt + (l.typical === null ? RAMP_UNKNOWN_MS : RAMP_KNOWN_MS) > from);
  const rampingCores = ramping.reduce((n, l) => n + (l.typical ?? l.cpus), 0);
  const predicted = leases.reduce((n, l) => n + (l.typical ?? 0), 0);
  return capacity - Math.max(busyCores + rampingCores, predicted);
}

/** 残っている socket ファイルに誰かが応答すれば投げ、応答しなければ消す @param {string} sock */
async function removeStaleSocket(sock) {
  // Windows の名前付きパイプはファイルとして残らない(待ち受けを閉じれば消える)。誰かが応答するかだけを見る
  if (!IS_WINDOWS && !existsSync(sock)) return;
  const answered = await new Promise((resolve) => {
    const c = netConnect(sock);
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
  if (answered) throw new Error(t(`別のデーモンが応答している: ${sock}`, `another daemon is answering: ${sock}`));
  if (!IS_WINDOWS) unlinkSync(sock);
}

/**
 * @param {DaemonOptions} opts
 * @returns {Promise<{ sock: string, getState: () => State, close: () => Promise<void> }>}
 */
export async function startDaemon(opts) {
  const {
    home,
    capacity,
    lockCaps = {},
    tickMs = 5_000,
    heartbeatTimeoutMs = 30_000,
    recoveryGraceMs = 60_000,
    idleExitMs = 120_000,
    adaptive = true,
    // 既定は無効(startDaemon を直に使うテストで、機械の実際の空きで入場が変わらないように)。switchyardd は既定で有効にして渡す
    overcommit = false,
    sampleMs = 1_000,
    readBusyMs = busyMsOfMachine,
    // メモリを見た受け入れ。既定は無効(startDaemon を直に使うテストで、機械の実際の空きで入場が変わらないように)
    // 機械の論理コア数(容量いっぱいを割り当てた走行に並列度として渡す)
    cores = availableParallelism(),
    memory = false,
    memFloorMb = totalMbOfMachine() * MEM_FLOOR_RATIO,
    memSampleMs = 2_000,
    readAvailableMb = availableMbOfMachine,
    readRss = rssByGroup,
    onIdleExit = null,
    // 止める要求(switchyard stop)を受けたとき。Windows では SIGTERM が後片付けの機会の無い強制終了になるので、接続で頼む
    onShutdown = null,
    isAlive = isGroupAlive,
    monoNow = defaultMono,
    wallNow = Date.now,
  } = opts;
  const p = pathsOf(home);
  const sockBytes = Buffer.byteLength(p.sock);
  if (!IS_WINDOWS && sockBytes > SOCKET_PATH_LIMIT) throw new Error(t(`socket のパスが長すぎる(${sockBytes} バイト > ${SOCKET_PATH_LIMIT}): ${p.sock}`, `socket path too long (${sockBytes} bytes > ${SOCKET_PATH_LIMIT}): ${p.sock}`));
  ensurePrivateDir(home);
  // 0.7.0 以前に他のユーザーからも読める権限で作った記録を締め直す
  tightenFiles(home);
  await removeStaleSocket(p.sock);

  // 回した 1 世代前も含めて読んでから、上限を超えていれば回す(見込みの帳簿を切らさない)
  const journal = readJournal(p.events);
  // PreToolUse の判断の記録はデーモンが読まないので、回すだけ
  const rotateJournals = () => {
    rotateRecords(p.events);
    rotateRecords(p.hooks);
  };
  rotateJournals();
  const estimates = loadEstimates(journal.records);
  const usage = loadUsage(journal.records);
  const memBook = loadMemory(journal.records);
  const escapes = loadEscapes(journal.records);
  /** @param {string} repo @param {string} profile @returns {string[]} */
  const escapesOf = (repo, profile) => [...(escapes.get(JSON.stringify([repo, profile])) ?? [])].sort();
  const loaded = parseState(readJson(p.state));
  /** @type {State} */
  let state = loaded === null ? initialState({ capacity, lockCaps }) : rebaseForRecovery({ ...loaded, capacity, lockCaps }, monoNow());
  /** @type {number | null} 包みの再接続を待つ期限 */
  let recoveryDeadline = state.waiting.some((w) => w.recovering) || state.leases.some((l) => l.recovering) ? monoNow() + recoveryGraceMs : null;
  // 状態は変わったときだけ書く。tick は何も起きなくても来るので、書き分けないと待ちも走行も無い間ずっと書き続ける
  const writeState = createStateWriter(p.state);
  writeState(state);

  /** @type {Map<string, Socket>} jobId → 包みの接続 */
  const wrappers = new Map();
  /** @type {Map<string, number>} jobId → 最後に包みの声を聞いた単調時刻 */
  const lastHeard = new Map();
  /** @type {Set<Socket>} */
  const conns = new Set();
  let closing = false;
  let seq = 0;
  const newJobId = () => `j${wallNow().toString(36)}${(seq++).toString(36)}`;

  /** @param {Socket} conn @param {unknown} msg */
  const send = (conn, msg) => {
    if (!conn.destroyed) conn.write(encode(msg));
  };

  /** @param {Action} a */
  const dispatch = (a) => {
    if (a.type === 'history') {
      // 見込みの帳簿は、同じ git の本体を共有する worktree の一族(family)で引く。記録にも残し、次の起動で同じ鍵に読み戻す
      const learn = a.family ?? a.repo;
      estimates.record(learn, a.profile, a.durationMs, a.code);
      usage.record(learn, a.profile, { durationMs: a.durationMs, cpuMs: a.cpuMs ?? null, cpus: a.cpus, code: a.code });
      memBook.record(learn, a.profile, a.peakMemMb);
      appendRecord(p.events, { at: wallNow(), kind: 'history', repo: a.repo, ...(a.family === undefined ? {} : { family: a.family }), profile: a.profile, class: a.class, cpus: a.cpus, durationMs: a.durationMs, code: a.code, cpuMs: a.cpuMs ?? null, peakMemMb: a.peakMemMb ?? null, ...(a.environmental === undefined ? {} : { environmental: a.environmental }) });
      return;
    }
    // 決定(入場と、待たせた順番・理由)も記録に残す。包みが繋がっていなくても残すので、
    // 後から「なぜ・どれだけ待ったか」「容量を超えて借りたか」を数えられる(switchyard report)
    appendRecord(p.events, { at: wallNow(), kind: 'decision', decision: a });
    // 包みが繋がっていなくても、入場を出したなら「仕事をした」(アイドル終了の対象から外す)
    if (a.type === 'grant') everGranted = true;
    const conn = wrappers.get(a.jobId);
    if (conn === undefined) return;
    if (a.type === 'grant') {
      // grant を送った時点を心拍とみなす(声を聞いたのと同じ扱い)。
      // 待っている包みは心拍を送らないので、更新しないと grant から started までの間に途絶の判定へ落ちる
      lastHeard.set(a.jobId, monoNow());
      const lease = state.leases.find((l) => l.job.id === a.jobId);
      send(conn, { t: 'grant', jobId: a.jobId, cpus: a.cpus, threads: lease === undefined ? a.cpus : threadsOf(lease, state.capacity, cores) });
    } else if (a.type === 'hold') {
      // 止める / 降格する側も声を聞いた扱いにする(止まっている間も包みは心拍を送り続けるが、往復を待たない)
      lastHeard.set(a.jobId, monoNow());
      send(conn, { t: 'hold', jobId: a.jobId, mode: a.mode });
    } else if (a.type === 'unhold') {
      send(conn, { t: 'unhold', jobId: a.jobId });
    } else send(conn, { t: 'queued', jobId: a.jobId, position: a.position, reason: a.reason, etaWall: a.etaAt === null ? null : wallNow() + (a.etaAt - monoNow()) });
  };

  /** @type {Array<{ at: number, busy: number }>} 機械全体の CPU の使い方の標本(新しいものが後ろ) */
  const samples = [];
  /** 実測の空き。測れていなければ null(詰め込みを止めていれば標本を取らないので、いつも null) */
  const spare = () =>
    state.leases.length === 0
      ? null
      : spareOf({ capacity: state.capacity, samples, leases: state.leases.map((l) => ({ grantedAt: l.grantedAt, typical: usage.typical(l.job.family ?? l.job.repo, l.job.profile), cpus: l.cpus })) });

  /** @type {Map<string, { rssMb: number, peakMb: number }>} jobId → 今の RSS とピーク(MB)。メモリを見るときだけ測る */
  const rss = new Map();
  /** 空きメモリの見積もりと下限。メモリを見ないなら null @returns {import('../core/schedule.mjs').MemoryView | null} */
  const memoryView = () =>
    !memory
      ? null
      : {
          availableMb: effectiveAvailableMb({
            availableMb: readAvailableMb(),
            leases: state.leases.map((l) => ({ memMb: l.job.memMb ?? null, rssMb: rss.get(l.job.id)?.rssMb ?? null })),
          }),
          floorMb: memFloorMb,
        };

  /** @type {Map<string, import('../core/diagnose.mjs').RunStats & { lastAt: number }>} jobId → 走行中に測った機械の様子(環境のせいの失敗の手がかり) */
  const runStats = new Map();
  /**
   * 走行中のジョブごとに、重なった他の重い走行の数・機械の忙しさ・空きメモリの最小・止められていた時間を覚える。
   * 標本を取るたびと tick ごとに呼ぶ(何度呼んでも、止められていた時間は前回からの差だけを足す)。
   */
  const observeRuns = () => {
    const now = monoNow();
    const running = state.leases.filter((l) => l.phase === 'running' && l.cpus > 0);
    const a = samples[samples.length - 2];
    const b = samples[samples.length - 1];
    const busy = a !== undefined && b !== undefined && b.at > a.at ? Math.max(0, b.busy - a.busy) / (b.at - a.at) : null;
    const avail = memory ? readAvailableMb() : null;
    for (const l of running) {
      const st = runStats.get(l.job.id) ?? { maxOthers: 0, maxBusyCores: null, maxOtherLoad: null, minAvailMb: null, heldMs: 0, lastAt: now };
      st.maxOthers = Math.max(st.maxOthers, running.filter((o) => o !== l && o.held === undefined).length);
      if (busy !== null) {
        st.maxBusyCores = Math.max(st.maxBusyCores ?? 0, busy);
        // この走行が使いうるのは、道具に渡したスレッド数まで。それを超える分は他の処理
        st.maxOtherLoad = Math.max(st.maxOtherLoad ?? 0, busy - threadsOf(l, state.capacity, cores));
      }
      if (avail !== null) st.minAvailMb = Math.min(st.minAvailMb ?? Infinity, avail);
      if (l.held !== undefined) st.heldMs += now - st.lastAt;
      st.lastAt = now;
      runStats.set(l.job.id, st);
    }
  };

  /** @param {Event} e */
  const apply = (e) => {
    if (e.type !== 'tick') appendRecord(p.events, { at: wallNow(), kind: 'event', event: e });
    const r = decide(state, e, { spare: spare(), memory: memoryView() });
    state = r.state;
    writeState(state);
    for (const a of r.actions) dispatch(a);
  };

  /** 控えの通し番号(同じ時刻に終わった控えの id を分ける) */
  let unmanagedSeq = 0;
  // 管理なしで走ったジョブの控えを取り込む(設計 §4.2)。記録に写し、失敗は ack 待ちに積む。
  // 起動時と tick ごとに呼ぶ(デーモンが生きている間に書かれた控えも、持ち主のセッションが続いているうちに Stop へ届くように)
  const ingestUnmanaged = () => {
    for (const u of takeUnmanaged(p.unmanaged)) {
      const jobId = `u${u.at.toString(36)}${(unmanagedSeq++).toString(36)}`;
      appendRecord(p.events, { kind: 'unmanaged', jobId, ...u });
      apply({ type: 'unmanagedExit', now: monoNow(), session: u.session, jobId, code: u.code, cmd: u.cmd, repo: u.repo, profile: u.profile });
    }
  };
  ingestUnmanaged();

  /** @returns {Snapshot} */
  const snapshot = () => {
    const now = monoNow();
    const wall = wallNow();
    const toWall = (/** @type {number} */ t) => wall - (now - t);
    return {
      capacity: state.capacity,
      used: usedCpus(state),
      leases: state.leases.map((l) => ({
        id: l.job.id, session: l.job.session, class: l.job.class, cmd: l.job.cmd, why: l.job.why,
        cpus: l.cpus, locks: l.job.locks, phase: l.phase, recovering: l.recovering, sinceWall: toWall(l.grantedAt), expectedMs: l.job.expectedMs,
        escapes: escapesOf(l.job.repo, l.job.profile),
        sizedFrom: l.job.sizedFrom ?? null,
        measuredCores: l.job.measuredCores ?? null,
        overcommit: l.overcommit === true,
      })),
      waiting: sortWaiting(state.waiting, now).map((w) => {
        const n = state.notes[w.job.id];
        return {
          id: w.job.id, session: w.job.session, class: w.job.class, cmd: w.job.cmd, why: w.job.why,
          cpus: w.job.cpus, locks: w.job.locks, recovering: w.recovering, sinceWall: toWall(w.arrivedAt),
          escapes: escapesOf(w.job.repo, w.job.profile),
          sizedFrom: w.job.sizedFrom ?? null,
          measuredCores: w.job.measuredCores ?? null,
          note: n === undefined ? null : { jobId: n.jobId, position: n.position, reason: n.reason, etaWall: n.etaAt === null ? null : toWall(n.etaAt) },
        };
      }),
      unacked: state.unacked,
      badRecords: journal.bad,
      // 起動したときの版。plugin を更新した後も古いデーモンが走り続けるので、SessionStart が食い違いを知らせる(設計 §9.6)
      version: VERSION,
      // 実測で要求を縮める repo × profile と使用コア数。PreToolUse が「待たされるか」の見込みに使う
      sized: adaptive ? usage.sizedAll() : {},
      // 空きメモリの見積もりと下限(メモリを見ないなら null)
      memory: memoryView(),
      // 実測の空き(詰め込みに使う)。測れていなければ null
      spare: spare(),
    };
  };

  /** 包みを見失ったときの出来事 @param {string} id */
  const lose = (id) => {
    const l = state.leases.find((x) => x.job.id === id);
    if (l === undefined) {
      if (state.waiting.some((w) => w.job.id === id)) apply({ type: 'cancel', now: monoNow(), jobId: id });
      return;
    }
    if (l.phase === 'orphan') return;
    // 止めたジョブの包みを見失った(設計 §6.7)。包みが SIGCONT を送れないまま消えると、
    // 子は永久に止まったままで、生きているので孤児のリースも返らない。デーモンが代わりに動かし直す
    if (l.held === 'pause' && l.pgid !== null) {
      try {
        process.kill(-l.pgid, 'SIGCONT');
      } catch {
        // 既に居ない
      }
    }
    apply({ type: 'heartbeatLost', now: monoNow(), jobId: id, alive: l.pgid !== null && isAlive(l.pgid) });
  };

  const server = createServer((conn) => {
    conns.add(conn);
    conn.setEncoding('utf8');
    /** @type {string | null} この接続が包んでいるジョブ */
    let bound = null;
    let exited = false;

    /** @param {string} id */
    const bind = (id) => {
      bound = id;
      exited = false;
      wrappers.set(id, conn);
      lastHeard.set(id, monoNow());
    };
    /** @param {unknown} jobId @returns {string} */
    const own = (jobId) => {
      if (bound === null || jobId !== bound) throw new Error(t('この接続のジョブではない', 'not the job of this connection'));
      return bound;
    };

    /** @param {unknown} raw */
    const handle = (raw) => {
      const m = /** @type {Record<string, unknown>} */ (typeof raw === 'object' && raw !== null ? raw : {});
      switch (m.t) {
        case 'request': {
          const parsed = parseJobRequest(m.job);
          // 上限を容量に切り詰めてから縮める(既定の表の「容量いっぱい」を、top や記録に大きな数のまま出さない)
          const req = parsed.cpus.max > state.capacity ? { ...parsed, cpus: { min: Math.min(parsed.cpus.min, state.capacity), max: state.capacity } } : parsed;
          const id = newJobId();
          bind(id);
          send(conn, { t: 'accepted', jobId: id });
          const learn = req.family ?? req.repo;
          const memMb = memory ? memBook.expected(learn, req.profile) : null;
          const job = rightSize({ ...req, id, expectedMs: estimates.expected(learn, req.profile), ...(memMb === null ? {} : { memMb }) }, adaptive ? usage.cores(learn, req.profile) : null);
          apply({ type: 'request', now: monoNow(), job });
          return;
        }
        case 'resume': {
          const id = String(m.jobId);
          const lease = state.leases.find((l) => l.job.id === id && l.phase !== 'orphan');
          if (lease === undefined && !state.waiting.some((w) => w.job.id === id)) {
            send(conn, { t: 'unknown', jobId: id });
            return;
          }
          bind(id);
          send(conn, { t: 'accepted', jobId: id });
          apply({ type: 'resume', now: monoNow(), jobId: id, pid: numOrNull(m.pid), pgid: numOrNull(m.pgid) });
          // 割り振りの後、受け取る前に切れていた包みには知らせ直す。
          // この resume で初めて入場したときは、apply の中の dispatch が既に grant を送っているので送らない
          if (lease !== undefined && m.phase === 'waiting') send(conn, { t: 'grant', jobId: id, cpus: lease.cpus, threads: threadsOf(lease, state.capacity, cores) });
          return;
        }
        case 'started': {
          const id = own(m.jobId);
          lastHeard.set(id, monoNow());
          apply({ type: 'started', now: monoNow(), jobId: id, pid: Number(m.pid), pgid: numOrNull(m.pgid) });
          return;
        }
        case 'hb': {
          lastHeard.set(own(m.jobId), monoNow());
          return;
        }
        case 'exit': {
          const id = own(m.jobId);
          exited = true;
          wrappers.delete(id);
          lastHeard.delete(id);
          const done = state.leases.find((l) => l.job.id === id);
          const escape = parseEscape(m.escape);
          if (done !== undefined && escape !== null && (escape.escaped.length > 0 || escape.survivors.length > 0)) {
            appendRecord(p.events, { at: wallNow(), kind: 'escape', jobId: id, repo: done.job.repo, profile: done.job.profile, escaped: escape.escaped, survivors: escape.survivors });
            const key = JSON.stringify([done.job.repo, done.job.profile]);
            const names = escapes.get(key) ?? new Set();
            for (const e of escape.escaped) names.add(e.comm);
            escapes.set(key, names);
          }
          const peakMemMb = rss.get(id)?.peakMb ?? null;
          rss.delete(id);
          observeRuns();
          const code = numOrNull(m.code);
          const killedByCaller = m.killedByCaller === true;
          // 失敗が環境のせいかもしれないか(混雑・メモリ不足・計測のための一時停止・SIGKILL)。包みが Claude に伝え、確認待ちにも添える
          const environmental = done === undefined ? [] : environmentalReasons({ code, killedByCaller, stats: runStats.get(id) ?? null, cores, memFloorMb: memory ? memFloorMb : null });
          runStats.delete(id);
          apply({ type: 'exit', now: monoNow(), jobId: id, code, killedByCaller, durationMs: Number(m.durationMs), cpuMs: numOrNull(m.cpuMs), peakMemMb: peakMemMb === null ? null : Math.round(peakMemMb), ...(environmental.length > 0 ? { environmental } : {}) });
          send(conn, { t: 'ok', ...(environmental.length > 0 ? { environmental } : {}) });
          return;
        }
        case 'status':
          send(conn, { t: 'status', snapshot: snapshot() });
          return;
        case 'ack': {
          // session を省いた要求(人の端末から)は、そのジョブを持つセッションを探す。
          // 確認待ちに無いジョブは黙って ok を返さない(効いていないのに「確認済みにした」と出ていた)
          const jobId = String(m.jobId);
          const has = (/** @type {string} */ s) => (state.unacked[s] ?? []).some((u) => u.jobId === jobId);
          const session = typeof m.session === 'string' ? m.session : Object.keys(state.unacked).find(has);
          if (session === undefined || !has(session)) {
            const message =
              typeof m.session === 'string'
                ? t(`セッション ${m.session} の確認待ちにも ${jobId} は無い(switchyard top の「未確認」で id とセッションを確かめる)`, `${jobId} is not waiting to be acked in session ${m.session} (check the id and session under "Not looked at yet" in switchyard top)`)
                : t(`どのセッションの確認待ちにも ${jobId} は無い(switchyard top の「未確認」で id とセッションを確かめる)`, `${jobId} is not waiting to be acked in any session (check the id under "Not looked at yet" in switchyard top)`);
            send(conn, { t: 'error', message });
            return;
          }
          apply({ type: 'ack', now: monoNow(), session, jobId });
          send(conn, { t: 'ok', session });
          return;
        }
        case 'unacked':
          send(conn, { t: 'unacked', jobs: state.unacked[String(m.session)] ?? [] });
          return;
        case 'shutdown':
          if (onShutdown === null) {
            send(conn, { t: 'error', message: t('このデーモンは接続からは止められない', 'this daemon cannot be stopped over the connection') });
            return;
          }
          send(conn, { t: 'ok', pid: process.pid });
          setImmediate(onShutdown);
          return;
        default:
          send(conn, { t: 'error', message: t(`知らないメッセージ: ${String(m.t)}`, `unknown message: ${String(m.t)}`) });
      }
    };

    const feed = createDecoder(
      (raw) => {
        try {
          handle(raw);
        } catch (err) {
          send(conn, { t: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      },
      () => send(conn, { t: 'error', message: t('JSON として読めない行', 'a line that is not valid JSON') }),
    );
    conn.on('data', (chunk) => feed(String(chunk)));
    conn.on('error', () => {});
    conn.on('close', () => {
      conns.delete(conn);
      if (closing || bound === null || exited) return;
      if (wrappers.get(bound) === conn) wrappers.delete(bound);
      lastHeard.delete(bound);
      lose(bound);
    });
  });

  // 一度も仕事をしていないデーモンは、しばらく誰も来なければ終わる。
  // テストは `SWITCHYARD_HOME` を一時ディレクトリにするので、包みが自動起動したデーモンが誰にも見られないまま
  // 居座り続けていた(実測: 仕事を 1 件もしていないデーモンが 3 本・合計 144MB)。
  // grant を 1 度でも出したデーモンは落とさない — 走行の見込みの帳簿と ack 待ちを抱えているため。
  const startedAt = monoNow();
  let everGranted = false;
  /** 誰も待っておらず、走っておらず、繋がってもいないか */
  const quiet = () => state.leases.length === 0 && state.waiting.length === 0 && Object.keys(state.unacked).length === 0 && conns.size === 0;

  /** 記録を回すかを見るまでの tick の数(既定の tick で 1 時間ごと) */
  const rotateEvery = Math.max(1, Math.round(3_600_000 / tickMs));
  let ticks = 0;
  const timer = setInterval(() => {
    const now = monoNow();
    if (++ticks % rotateEvery === 0) rotateJournals();
    observeRuns();
    for (const id of [...runStats.keys()]) if (!state.leases.some((l) => l.job.id === id)) runStats.delete(id);
    // 終わり方を持たない呼び出し元(startDaemon を直に使うテストなど)では、黙って tick を止めない
    if (onIdleExit !== null && !everGranted && idleExitMs !== null && now - startedAt >= idleExitMs && quiet()) {
      clearInterval(timer);
      onIdleExit?.();
      return;
    }
    for (const l of [...state.leases]) {
      if (l.phase === 'orphan' || l.recovering) continue;
      const heard = lastHeard.get(l.job.id);
      if (heard !== undefined && now - heard > heartbeatTimeoutMs) {
        lastHeard.delete(l.job.id);
        const conn = wrappers.get(l.job.id);
        wrappers.delete(l.job.id);
        lose(l.job.id);
        conn?.destroy();
      }
    }
    for (const l of [...state.leases]) {
      if (l.phase === 'orphan' && (l.pgid === null || !isAlive(l.pgid))) apply({ type: 'orphanGone', now, jobId: l.job.id });
    }
    if (recoveryDeadline !== null && now >= recoveryDeadline) {
      recoveryDeadline = null;
      for (const w of [...state.waiting]) if (w.recovering) apply({ type: 'cancel', now, jobId: w.job.id });
      for (const l of [...state.leases]) {
        if (l.recovering) apply({ type: 'heartbeatLost', now, jobId: l.job.id, alive: l.pgid !== null && isAlive(l.pgid) });
      }
    }
    try {
      ingestUnmanaged();
    } catch (e) {
      // 控えを読めなくても割り振りの tick は止めない(次の tick で試し直す)
      process.stderr.write(`${t('[switchyardd] 管理なしの走行の控えを取り込めない', '[switchyardd] cannot ingest unmanaged runs')}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    apply({ type: 'tick', now });
  }, tickMs);

  // 機械全体の CPU の使い方を測り続け、待っているジョブがあって実測の空きがあれば、tick を待たずに割り振りを見直す(詰め込み)
  const sampler = overcommit
    ? setInterval(() => {
        const now = monoNow();
        samples.push({ at: now, busy: readBusyMs() });
        while (samples.length > 0 && now - samples[0].at > SPARE_WINDOW_MS * 4) samples.shift();
        observeRuns();
        const sp = state.waiting.length > 0 ? spare() : null;
        if (sp !== null && sp >= 1) apply({ type: 'tick', now });
      }, sampleMs)
    : null;

  // 走行中のジョブのプロセスグループの RSS を測り、ピークを覚える(終わったときに記録へ残し、次の見込みにする)。
  // 待っているジョブがあれば、測った後に割り振りを見直す(空きメモリが戻ったら tick を待たずに入れる)
  let memBusy = false;
  const memSampler = memory
    ? setInterval(() => {
        const running = state.leases.filter((l) => l.pgid !== null);
        if (memBusy || (running.length === 0 && state.waiting.length === 0)) return;
        memBusy = true;
        readRss()
          .then((byGroup) => {
            for (const l of state.leases) {
              if (l.pgid === null) continue;
              const now = byGroup.get(l.pgid) ?? 0;
              const prev = rss.get(l.job.id);
              rss.set(l.job.id, { rssMb: now, peakMb: Math.max(prev?.peakMb ?? 0, now) });
            }
            for (const id of [...rss.keys()]) if (!state.leases.some((l) => l.job.id === id)) rss.delete(id);
            observeRuns();
            if (!closing && state.waiting.length > 0) apply({ type: 'tick', now: monoNow() });
          })
          .catch(() => {})
          .finally(() => {
            memBusy = false;
          });
      }, memSampleMs)
    : null;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(p.sock, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });

  return {
    sock: p.sock,
    getState: () => state,
    close: () =>
      new Promise((resolve) => {
        closing = true;
        clearInterval(timer);
        if (sampler !== null) clearInterval(sampler);
        if (memSampler !== null) clearInterval(memSampler);
        for (const c of conns) c.destroy();
        server.close(() => resolve(undefined));
      }),
  };
}
