// @ts-check
// 出来事ごとの状態遷移(設計 §6.1)。遷移のあとで必ず schedule を通す。純関数。
import { schedule } from './schedule.mjs';

/** @typedef {import('./types.mjs').State} State */
/** @typedef {import('./types.mjs').Event} Event */
/** @typedef {import('./types.mjs').Action} Action */
/** @typedef {import('./types.mjs').JobSpec} JobSpec */
/** @typedef {import('./types.mjs').Lease} Lease */
/** @typedef {import('./types.mjs').UnackedKind} UnackedKind */

/** @param {{ capacity: number, lockCaps?: Record<string, number> }} opts @returns {State} */
export function initialState({ capacity, lockCaps = {} }) {
  return { capacity, lockCaps, waiting: [], leases: [], favorNonMeasure: false, unacked: {}, notes: {} };
}

/**
 * 要求を整える。cpus を 1..容量 に収める(min が容量を超えたまま待たせると永遠に入場しない)。
 * 鍵の重複も除く(表示と記録に同じ鍵を 2 度出さないため。入場の判断はリース単位で数えるので重複の有無で変わらない)。
 * 鍵だけのジョブ(0..0 で鍵を 1 本以上持つ)は、CPU を 0 のまま保つ(設計 §5.2)。
 * @param {JobSpec} job @param {number} capacity @returns {JobSpec}
 */
export function clampJob(job, capacity) {
  const locks = [...new Set(job.locks)];
  if (job.cpus.max === 0 && locks.length > 0) return { ...job, cpus: { min: 0, max: 0 }, locks };
  const min = Math.max(1, Math.min(job.cpus.min, capacity));
  const max = Math.max(min, Math.min(job.cpus.max, capacity));
  return { ...job, cpus: { min, max }, locks };
}

/** @param {State} s @param {string} id */
const hasJob = (s, id) => s.waiting.some((w) => w.job.id === id) || s.leases.some((l) => l.job.id === id);

/** @param {State} s @param {string} id @returns {State} */
const removeWaiting = (s, id) => ({ ...s, waiting: s.waiting.filter((w) => w.job.id !== id) });

/** @param {State} s @param {string} id @returns {State} */
const removeLease = (s, id) => ({ ...s, leases: s.leases.filter((l) => l.job.id !== id) });

/** @param {State} s @param {string} id @param {(l: Lease) => Lease} f @returns {State} */
const mapLease = (s, id, f) => ({ ...s, leases: s.leases.map((l) => (l.job.id === id ? f(l) : l)) });

/** @param {State} s @param {Lease} l @param {UnackedKind} kind @param {number | null} code @returns {State} */
function addUnacked(s, l, kind, code) {
  const list = s.unacked[l.job.session] ?? [];
  return { ...s, unacked: { ...s.unacked, [l.job.session]: [...list, { jobId: l.job.id, kind, code, cmd: l.job.cmd, repo: l.job.repo, profile: l.job.profile }] } };
}

/** 後の成功で片付く終わり方。orphan は子がまだ走っているので片付けない */
const RESOLVED_BY_SUCCESS = new Set(['failed', 'killed', 'lost']);

/**
 * 同じセッションで同じ走行(同じ repo と profile。分類されなかった cmd:… の profile は同じコマンド文字列)が成功したら、
 * その前の失敗は確かめ終えたとみなして消す。失敗してから直して走らせ直す流れ(テストを先に赤くする開発)で、
 * 直した後も Stop が差し戻し続けるのを避ける。
 * @param {State} s @param {string} session @param {string} repo @param {string} profile @param {string} cmd @returns {State}
 */
export function resolveBySuccess(s, session, repo, profile, cmd) {
  const list = s.unacked[session];
  if (list === undefined) return s;
  const same = (/** @type {import('./types.mjs').Unacked} */ u) =>
    RESOLVED_BY_SUCCESS.has(u.kind) && u.repo === repo && u.profile === profile && (!profile.startsWith('cmd:') || u.cmd === cmd);
  const rest = list.filter((u) => !same(u));
  if (rest.length === list.length) return s;
  const { [session]: _dropped, ...others } = s.unacked;
  return { ...s, unacked: rest.length > 0 ? { ...others, [session]: rest } : others };
}

/** @param {State} s @param {Lease} l @returns {State} */
const afterMeasure = (s, l) => (l.job.class === 'measure' ? { ...s, favorNonMeasure: true } : s);

/**
 * @param {State} input @param {Event} e @returns {{ state: State, actions: Action[] }}
 */
export function decide(input, e) {
  let s = input;
  /** @type {Action[]} */
  const extra = [];
  switch (e.type) {
    case 'request': {
      if (!hasJob(s, e.job.id)) {
        s = { ...s, waiting: [...s.waiting, { job: clampJob(e.job, s.capacity), arrivedAt: e.now, recovering: false }] };
      }
      break;
    }
    case 'started': {
      s = mapLease(s, e.jobId, (l) => ({ ...l, phase: 'running', pid: e.pid, pgid: e.pgid }));
      break;
    }
    case 'exit': {
      const l = s.leases.find((x) => x.job.id === e.jobId);
      if (l === undefined) {
        // 入場前に包みが終わった
        s = removeWaiting(s, e.jobId);
        break;
      }
      s = removeLease(s, e.jobId);
      extra.push({ type: 'history', repo: l.job.repo, profile: l.job.profile, class: l.job.class, cpus: l.cpus, durationMs: e.durationMs, code: e.code });
      if (e.killedByCaller) s = addUnacked(s, l, 'killed', e.code);
      else if (e.code !== 0) s = addUnacked(s, l, 'failed', e.code);
      else s = resolveBySuccess(s, l.job.session, l.job.repo, l.job.profile, l.job.cmd);
      s = afterMeasure(s, l);
      break;
    }
    case 'cancel': {
      s = removeWaiting(s, e.jobId);
      break;
    }
    case 'heartbeatLost': {
      const l = s.leases.find((x) => x.job.id === e.jobId);
      if (l === undefined) {
        s = removeWaiting(s, e.jobId);
        break;
      }
      if (l.phase === 'orphan') break;
      if (e.alive) {
        // 子は生きているが制御できない。終わるまで資源を持たせる
        s = mapLease(s, e.jobId, (x) => ({ ...x, phase: 'orphan', recovering: false }));
        s = addUnacked(s, l, 'orphan', null);
      } else {
        s = removeLease(s, e.jobId);
        s = addUnacked(s, l, 'lost', null);
        s = afterMeasure(s, l);
      }
      break;
    }
    case 'orphanGone': {
      const l = s.leases.find((x) => x.job.id === e.jobId);
      if (l === undefined || l.phase !== 'orphan') break;
      s = afterMeasure(removeLease(s, e.jobId), l);
      break;
    }
    case 'resume': {
      if (s.waiting.some((w) => w.job.id === e.jobId)) {
        s = { ...s, waiting: s.waiting.map((w) => (w.job.id === e.jobId ? { ...w, recovering: false } : w)) };
        break;
      }
      s = mapLease(s, e.jobId, (l) => ({
        ...l,
        recovering: false,
        pid: e.pid ?? l.pid,
        pgid: e.pgid ?? l.pgid,
        phase: e.pid !== null ? 'running' : l.phase,
      }));
      break;
    }
    case 'ack': {
      const rest = (s.unacked[e.session] ?? []).filter((u) => u.jobId !== e.jobId);
      const { [e.session]: _dropped, ...others } = s.unacked;
      s = { ...s, unacked: rest.length > 0 ? { ...others, [e.session]: rest } : others };
      break;
    }
    case 'unmanagedExit': {
      // 管理なしで走ったジョブ(設計 §4.2)。リースは無いので、失敗なら ack 待ちに積むだけ(同じ id は 2 度積まない)。
      // 成功なら、同じ走行の前の失敗を片付ける
      if (e.code === 0) {
        if (e.repo !== undefined && e.profile !== undefined) s = resolveBySuccess(s, e.session, e.repo, e.profile, e.cmd);
        break;
      }
      const list = s.unacked[e.session] ?? [];
      if (!list.some((u) => u.jobId === e.jobId)) {
        const where = e.repo !== undefined && e.profile !== undefined ? { repo: e.repo, profile: e.profile } : {};
        s = { ...s, unacked: { ...s.unacked, [e.session]: [...list, { jobId: e.jobId, kind: 'failed', code: e.code, cmd: e.cmd, ...where }] } };
      }
      break;
    }
    case 'tick':
      break;
  }
  const r = schedule(s, e.now);
  return { state: r.state, actions: [...extra, ...r.actions] };
}
