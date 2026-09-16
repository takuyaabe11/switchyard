// @ts-check
/** @typedef {import('../src/core/types.mjs').JobSpec} JobSpec */
/** @typedef {import('../src/core/types.mjs').Waiting} Waiting */

export const MIN = 60_000;

/** @param {Partial<JobSpec>} [over] @returns {JobSpec} */
export function job(over = {}) {
  return {
    id: 'j1',
    session: 's1',
    repo: '/repo',
    profile: 'p',
    cmd: 'cmd',
    class: 'batch',
    cpus: { min: 1, max: 1 },
    locks: [],
    preempt: 'never',
    why: null,
    expectedMs: null,
    ...over,
  };
}

/** @param {Partial<JobSpec>} [over] @param {number} [arrivedAt] @returns {Waiting} */
export function waiting(over = {}, arrivedAt = 0) {
  return { job: job(over), arrivedAt, recovering: false };
}

/** @typedef {import('../src/core/types.mjs').State} State */
/** @typedef {import('../src/core/types.mjs').Lease} Lease */
/** @typedef {import('../src/core/types.mjs').Action} Action */

/** @param {Partial<State>} [over] @returns {State} */
export function state(over = {}) {
  return { capacity: 8, lockCaps: {}, waiting: [], leases: [], favorNonMeasure: false, unacked: {}, notes: {}, ...over };
}

/** @param {Partial<JobSpec>} [over] @param {Partial<Omit<Lease, 'job'>>} [rest] @returns {Lease} */
export function lease(over = {}, rest = {}) {
  return { job: job(over), cpus: 1, grantedAt: 0, phase: 'running', pid: null, pgid: null, recovering: false, ...rest };
}

/** grant の処置だけを [jobId, cpus] の列にする @param {Action[]} actions @returns {Array<[string, number]>} */
export function grants(actions) {
  /** @type {Array<[string, number]>} */
  const out = [];
  for (const a of actions) if (a.type === 'grant') out.push([a.jobId, a.cpus]);
  return out;
}
