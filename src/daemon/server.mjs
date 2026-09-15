// @ts-check
// デーモンの殻。socket・時計・ファイルを持ち、判断は decide に任せる(設計 §4.2)。
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { connect as netConnect, createServer } from 'node:net';
import { decide, initialState } from '../core/decide.mjs';
import { rebaseForRecovery } from '../core/recovery.mjs';
import { usedCpus } from '../core/schedule.mjs';
import { sortWaiting } from '../core/score.mjs';
import { numOrNull, parseEscape, parseJobRequest } from '../protocol/messages.mjs';
import { createDecoder, encode } from '../protocol/ndjson.mjs';
import { pathsOf, SOCKET_PATH_LIMIT } from './paths.mjs';
import { appendRecord, loadEscapes, loadEstimates, parseState, readJson, readRecords, writeJsonAtomic } from './store.mjs';

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
 *   isAlive?: (pgid: number) => boolean,
 *   monoNow?: () => number,
 *   wallNow?: () => number
 * }} DaemonOptions
 */

/** プロセスグループがまだ存在するか(信号 0 は存在確認だけで、何も起こさない) @param {number} pgid */
export function isGroupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

const defaultMono = () => Number(process.hrtime.bigint() / 1_000_000n);

/** 残っている socket ファイルに誰かが応答すれば投げ、応答しなければ消す @param {string} sock */
async function removeStaleSocket(sock) {
  if (!existsSync(sock)) return;
  const answered = await new Promise((resolve) => {
    const c = netConnect(sock);
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
  if (answered) throw new Error(`別のデーモンが応答している: ${sock}`);
  unlinkSync(sock);
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
    isAlive = isGroupAlive,
    monoNow = defaultMono,
    wallNow = Date.now,
  } = opts;
  const p = pathsOf(home);
  const sockBytes = Buffer.byteLength(p.sock);
  if (sockBytes > SOCKET_PATH_LIMIT) throw new Error(`socket のパスが長すぎる(${sockBytes} バイト > ${SOCKET_PATH_LIMIT}): ${p.sock}`);
  mkdirSync(home, { recursive: true });
  await removeStaleSocket(p.sock);

  const journal = readRecords(p.events);
  const estimates = loadEstimates(journal.records);
  const escapes = loadEscapes(journal.records);
  /** @param {string} repo @param {string} profile @returns {string[]} */
  const escapesOf = (repo, profile) => [...(escapes.get(JSON.stringify([repo, profile])) ?? [])].sort();
  const loaded = parseState(readJson(p.state));
  /** @type {State} */
  let state = loaded === null ? initialState({ capacity, lockCaps }) : rebaseForRecovery({ ...loaded, capacity, lockCaps }, monoNow());
  /** @type {number | null} 包みの再接続を待つ期限 */
  let recoveryDeadline = state.waiting.some((w) => w.recovering) || state.leases.some((l) => l.recovering) ? monoNow() + recoveryGraceMs : null;
  writeJsonAtomic(p.state, state);

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
      estimates.record(a.repo, a.profile, a.durationMs, a.code);
      appendRecord(p.events, { at: wallNow(), kind: 'history', repo: a.repo, profile: a.profile, class: a.class, cpus: a.cpus, durationMs: a.durationMs, code: a.code });
      return;
    }
    const conn = wrappers.get(a.jobId);
    if (conn === undefined) return;
    if (a.type === 'grant') send(conn, { t: 'grant', jobId: a.jobId, cpus: a.cpus });
    else send(conn, { t: 'queued', jobId: a.jobId, position: a.position, reason: a.reason, etaWall: a.etaAt === null ? null : wallNow() + (a.etaAt - monoNow()) });
  };

  /** @param {Event} e */
  const apply = (e) => {
    if (e.type !== 'tick') appendRecord(p.events, { at: wallNow(), kind: 'event', event: e });
    const r = decide(state, e);
    state = r.state;
    writeJsonAtomic(p.state, state);
    for (const a of r.actions) dispatch(a);
  };

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
      })),
      waiting: sortWaiting(state.waiting, now).map((w) => {
        const n = state.notes[w.job.id];
        return {
          id: w.job.id, session: w.job.session, class: w.job.class, cmd: w.job.cmd, why: w.job.why,
          cpus: w.job.cpus, locks: w.job.locks, recovering: w.recovering, sinceWall: toWall(w.arrivedAt),
          escapes: escapesOf(w.job.repo, w.job.profile),
          note: n === undefined ? null : { jobId: n.jobId, position: n.position, reason: n.reason, etaWall: n.etaAt === null ? null : toWall(n.etaAt) },
        };
      }),
      unacked: state.unacked,
      badRecords: journal.bad,
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
      if (bound === null || jobId !== bound) throw new Error('この接続のジョブではない');
      return bound;
    };

    /** @param {unknown} raw */
    const handle = (raw) => {
      const m = /** @type {Record<string, unknown>} */ (typeof raw === 'object' && raw !== null ? raw : {});
      switch (m.t) {
        case 'request': {
          const req = parseJobRequest(m.job);
          const id = newJobId();
          bind(id);
          send(conn, { t: 'accepted', jobId: id });
          apply({ type: 'request', now: monoNow(), job: { ...req, id, expectedMs: estimates.expected(req.repo, req.profile) } });
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
          if (lease !== undefined && m.phase === 'waiting') send(conn, { t: 'grant', jobId: id, cpus: lease.cpus });
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
          apply({ type: 'exit', now: monoNow(), jobId: id, code: numOrNull(m.code), killedByCaller: m.killedByCaller === true, durationMs: Number(m.durationMs) });
          send(conn, { t: 'ok' });
          return;
        }
        case 'status':
          send(conn, { t: 'status', snapshot: snapshot() });
          return;
        case 'ack':
          apply({ type: 'ack', now: monoNow(), session: String(m.session), jobId: String(m.jobId) });
          send(conn, { t: 'ok' });
          return;
        case 'unacked':
          send(conn, { t: 'unacked', jobs: state.unacked[String(m.session)] ?? [] });
          return;
        default:
          send(conn, { t: 'error', message: `知らないメッセージ: ${String(m.t)}` });
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
      () => send(conn, { t: 'error', message: 'JSON として読めない行' }),
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

  const timer = setInterval(() => {
    const now = monoNow();
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
    apply({ type: 'tick', now });
  }, tickMs);

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
        for (const c of conns) c.destroy();
        server.close(() => resolve(undefined));
      }),
  };
}
