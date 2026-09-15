// @ts-check
// 入場の判断(設計 §6.2〜§6.5 の第 1 段)。純関数で、入出力も時計も使わない。
import { sortWaiting } from './score.mjs';

/** @typedef {import('./types.mjs').State} State */
/** @typedef {import('./types.mjs').Waiting} Waiting */
/** @typedef {import('./types.mjs').Lease} Lease */
/** @typedef {import('./types.mjs').JobSpec} JobSpec */
/** @typedef {import('./types.mjs').Action} Action */

/** @param {State} s @returns {number} */
export function usedCpus(s) {
  return s.leases.reduce((n, l) => n + l.cpus, 0);
}

/** 鍵だけのジョブか(CPU を使わない。設計 §5.2) @param {JobSpec} job @returns {boolean} */
export function isLockOnly(job) {
  return job.cpus.max === 0;
}

/** CPU を持つリース(計測の単独実行はこれだけで数える。設計 §6.5) @param {State} s @returns {Lease[]} */
function cpuLeases(s) {
  return s.leases.filter((l) => l.cpus > 0);
}

/** @param {State} s @param {string} key @returns {number} */
function capOf(s, key) {
  return s.lockCaps[key] ?? 1;
}

/** @param {State} s @param {string} key @returns {Lease[]} */
function holders(s, key) {
  return s.leases.filter((l) => l.job.locks.includes(key));
}

/** @param {State} s @param {string[]} locks @returns {boolean} */
function locksFree(s, locks) {
  return locks.every((k) => holders(s, k).length < capOf(s, k));
}

/** @param {Lease} l @returns {number | null} */
function endAt(l) {
  return l.job.expectedMs === null ? null : l.grantedAt + l.job.expectedMs;
}

/** CPU を持つ走行中の全リースが終わる見込み時刻。どれかに見込みが無ければ null。 @param {State} s @returns {number | null} */
function allEnd(s) {
  let at = -Infinity;
  for (const l of cpuLeases(s)) {
    const e = endAt(l);
    if (e === null) return null;
    at = Math.max(at, e);
  }
  return at === -Infinity ? null : at;
}

/**
 * job が入場できる見込み時刻。必要な資源を持つリースのどれかに見込みが無ければ null。
 * @param {State} s @param {JobSpec} job @param {number} now @returns {number | null}
 */
export function estimateStart(s, job, now) {
  let at = now;
  for (const key of job.locks) {
    const hs = holders(s, key);
    const cap = capOf(s, key);
    if (hs.length < cap) continue;
    /** @type {number[]} */
    const ends = [];
    for (const h of hs) {
      const e = endAt(h);
      if (e === null) return null;
      ends.push(e);
    }
    ends.sort((a, b) => a - b);
    // 空きが 1 つできるのは、保持者のうち (保持数 − 容量 + 1) 本目が終わったとき
    at = Math.max(at, ends[hs.length - cap]);
  }
  let free = s.capacity - usedCpus(s);
  if (free < job.cpus.min) {
    const byEnd = cpuLeases(s)
      .map((l) => ({ l, e: endAt(l) }))
      .sort((a, b) => (a.e ?? Number.MAX_VALUE) - (b.e ?? Number.MAX_VALUE));
    /** @type {number | null} */
    let cpuAt = null;
    for (const { l, e } of byEnd) {
      if (e === null) return null;
      free += l.cpus;
      if (free >= job.cpus.min) {
        cpuAt = e;
        break;
      }
    }
    if (cpuAt === null) return null;
    at = Math.max(at, cpuAt);
  }
  return at;
}

/** @param {State} s @param {JobSpec} job @returns {string} */
function blockReason(s, job) {
  const held = job.locks.find((k) => holders(s, k).length >= capOf(s, k));
  if (held !== undefined) return `鍵 ${held} を ${holders(s, held).map((l) => l.job.id).join(', ')} が保持`;
  return `CPU 不足(空き ${s.capacity - usedCpus(s)} / 必要 ${job.cpus.min})`;
}

/**
 * 待ち列を見て、入場させるジョブと、待たせるジョブの理由を決める。
 * 入力の状態は書き換えない。この回に作ったリースだけを書き換える。
 * @param {State} input @param {number} now @returns {{ state: State, actions: Action[] }}
 */
export function schedule(input, now) {
  /** @type {State} */
  const s = { ...input, waiting: [...input.waiting], leases: [...input.leases], notes: {} };
  /** @type {Lease[]} */
  const granted = [];

  let ordered = sortWaiting(s.waiting.filter((w) => !w.recovering), now);
  if (s.favorNonMeasure) {
    const others = ordered.filter((w) => w.job.class !== 'measure' && !isLockOnly(w.job));
    if (others.length === 0) {
      s.favorNonMeasure = false;
    } else {
      // 計測の直後は、一番長く待っている計測以外のジョブを先頭に置く(計測が続いても飢えさせない)
      const oldest = others.reduce((a, b) => (b.arrivedAt < a.arrivedAt ? b : a));
      ordered = [oldest, ...ordered.filter((w) => w !== oldest)];
    }
  }

  /** @param {Waiting} w @param {number} cpus */
  const admit = (w, cpus) => {
    s.waiting = s.waiting.filter((x) => x !== w);
    /** @type {Lease} */
    const lease = { job: w.job, cpus, grantedAt: now, phase: 'granted', pid: null, pgid: null, recovering: false };
    s.leases = [...s.leases, lease];
    granted.push(lease);
  };

  const runningMeasure = s.leases.find((l) => l.job.class === 'measure');
  /** @type {string | null} 入場を止めている理由 */
  let gate = runningMeasure ? `計測 ${runningMeasure.job.id} の走行中は入場しない` : null;
  /** @type {{ id: string, etaAt: number | null } | null} 入場できなかった最初のジョブ */
  let head = null;
  /** @type {Set<string>} 前に居て入場できなかったジョブが要る鍵(鍵だけのジョブはこれを追い越さない) */
  const blocked = new Set();
  /** @param {JobSpec} job */
  const block = (job) => {
    for (const k of job.locks) blocked.add(k);
  };

  for (const [i, w] of ordered.entries()) {
    const job = w.job;
    /** @param {string} reason @param {number | null} etaAt */
    const note = (reason, etaAt) => {
      s.notes[job.id] = { jobId: job.id, position: i + 1, reason, etaAt };
    };
    if (isLockOnly(job)) {
      // 鍵だけのジョブは CPU を使わないので、計測の走行中や入場待ちでも止めない(設計 §6.2・§6.5)
      const ahead = job.locks.find((k) => blocked.has(k));
      if (ahead === undefined && locksFree(s, job.locks)) {
        admit(w, 0);
      } else {
        note(ahead !== undefined ? `鍵 ${ahead} を先に待つジョブがいる` : blockReason(s, job), null);
        block(job);
      }
      continue;
    }
    if (gate !== null) {
      note(gate, null);
      block(job);
      continue;
    }
    const free = s.capacity - usedCpus(s);
    if (job.class === 'measure') {
      if (head === null && cpuLeases(s).length === 0 && locksFree(s, job.locks)) {
        admit(w, Math.min(job.cpus.max, free));
        gate = `計測 ${job.id} の走行中は入場しない`;
      } else {
        if (head !== null) note(`先頭 ${head.id} の後ろ(計測は後ろ詰めしない)`, null);
        else if (cpuLeases(s).length > 0) note(`走行中 ${cpuLeases(s).length} 本の終了を待つ(計測は単独で走る)`, allEnd(s));
        else note(blockReason(s, job), null);
        gate = `計測 ${job.id} の入場待ちのため入場しない`;
        block(job);
      }
      continue;
    }
    const fits = free >= job.cpus.min && locksFree(s, job.locks);
    if (head === null) {
      if (fits) {
        admit(w, job.cpus.min);
        continue;
      }
      head = { id: job.id, etaAt: estimateStart(s, job, now) };
      note(blockReason(s, job), head.etaAt);
      block(job);
      continue;
    }
    // 後ろ詰め: 先頭が入場できる見込み時刻までに終わると見込めるときだけ
    const endsBeforeHead = head.etaAt !== null && job.expectedMs !== null && now + job.expectedMs <= head.etaAt;
    if (endsBeforeHead && fits) {
      admit(w, job.cpus.min);
      continue;
    }
    note(endsBeforeHead ? `先頭 ${head.id} の後ろ(${blockReason(s, job)})` : `先頭 ${head.id} の後ろ(後ろ詰めの見込みなし)`, null);
    block(job);
  }

  // 計測の直後の優先は、CPU を持つ計測以外のジョブが入場したときに外す(鍵だけのジョブでは外さない)
  if (granted.some((l) => l.job.class !== 'measure' && l.cpus > 0)) s.favorNonMeasure = false;

  // 余った CPU を、この回に入場したジョブへ順に max まで配る(走行中のジョブは増やさない)
  let free = s.capacity - usedCpus(s);
  for (const lease of granted) {
    const add = Math.min(lease.job.cpus.max - lease.cpus, free);
    if (add > 0) {
      lease.cpus += add;
      free -= add;
    }
  }

  /** @type {Action[]} */
  const actions = [];
  for (const l of granted) actions.push({ type: 'grant', jobId: l.job.id, cpus: l.cpus });
  for (const n of Object.values(s.notes)) {
    const prev = input.notes[n.jobId];
    const changed = prev === undefined || prev.position !== n.position || prev.reason !== n.reason || prev.etaAt !== n.etaAt;
    if (changed) actions.push({ type: 'queued', ...n });
  }
  return { state: s, actions };
}
