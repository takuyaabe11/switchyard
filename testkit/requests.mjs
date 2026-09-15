// @ts-check
/** @typedef {import('../src/protocol/messages.mjs').JobRequest} JobRequest */

/** @param {Partial<JobRequest>} [over] @returns {JobRequest} */
export function jobRequest(over = {}) {
  return {
    session: 's1',
    repo: '/repo',
    profile: 'p',
    cmd: 'cmd',
    class: 'batch',
    cpus: { min: 1, max: 1 },
    locks: [],
    preempt: 'throttle',
    why: null,
    ...over,
  };
}
