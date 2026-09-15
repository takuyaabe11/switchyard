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
    preempt: 'throttle',
    why: null,
    expectedMs: null,
    ...over,
  };
}

/** @param {Partial<JobSpec>} [over] @param {number} [arrivedAt] @returns {Waiting} */
export function waiting(over = {}, arrivedAt = 0) {
  return { job: job(over), arrivedAt, recovering: false };
}
