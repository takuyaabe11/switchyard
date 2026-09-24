// @ts-check
// 性質テスト用の模擬実行。到着・入場・終了を時刻順に decide へ通し、出来事ごとに不変条件を検査する。
import { decide, initialState } from '../src/core/decide.mjs';
import { job, MIN } from './fixtures.mjs';
import { checkInvariants } from './invariants.mjs';

/** @typedef {import('../src/core/types.mjs').JobSpec} JobSpec */
/** @typedef {import('../src/core/types.mjs').Event} Event */
/** @typedef {{ id: string, arriveAt: number, runMs: number, code: number, spec: Partial<JobSpec> }} PlannedJob */
/** spare は、どの出来事でもデーモンが渡す実測の空き(詰め込み)。省けば渡さない */
/** memory は、どの出来事でも渡す空きメモリの見積もりと下限。省けば渡さない */
/** @typedef {{ capacity: number, lockCaps: Record<string, number>, jobs: PlannedJob[], spare?: number | null, memory?: import('../src/core/schedule.mjs').MemoryView | null }} Scenario */

/**
 * @param {Scenario} sc
 * @returns {{ finished: number, grantOrder: string[], endAt: number }}
 */
export function simulate(sc) {
  let s = initialState({ capacity: sc.capacity, lockCaps: sc.lockCaps });
  const byId = new Map(sc.jobs.map((j) => [j.id, j]));
  const arrivals = [...sc.jobs].sort((a, b) => a.arriveAt - b.arriveAt || (a.id < b.id ? -1 : 1));
  /** @type {Map<string, number>} */
  const exits = new Map();
  /** @type {string[]} */
  const grantOrder = [];
  let finished = 0;
  // 空き時間が生じない規則なので、全部が終わるのは「最後の到着 + 全所要の合計」より前(I5 の上限)
  const horizon = Math.max(0, ...sc.jobs.map((j) => j.arriveAt)) + sc.jobs.reduce((n, j) => n + j.runMs, 0);

  /** @param {Event} first */
  const run = (first) => {
    /** @type {Event[]} */
    const queue = [first];
    while (queue.length > 0) {
      const e = /** @type {Event} */ (queue.shift());
      const r = decide(s, e, { spare: sc.spare ?? null, memory: sc.memory ?? null });
      s = r.state;
      checkInvariants(s);
      for (const a of r.actions) {
        if (a.type !== 'grant') continue;
        const planned = /** @type {PlannedJob} */ (byId.get(a.jobId));
        grantOrder.push(a.jobId);
        exits.set(a.jobId, e.now + planned.runMs);
        queue.push({ type: 'started', now: e.now, jobId: a.jobId, pid: 1000, pgid: 1000 });
      }
    }
  };

  let t = 0;
  while (finished < sc.jobs.length) {
    if (t > horizon) throw new Error(`I5: 時刻 ${t} を過ぎても ${sc.jobs.length - finished} 本が終わらない(上限 ${horizon})`);
    for (const [id, at] of [...exits].filter(([, at]) => at <= t).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))) {
      exits.delete(id);
      const planned = /** @type {PlannedJob} */ (byId.get(id));
      run({ type: 'exit', now: t, jobId: id, code: planned.code, killedByCaller: false, durationMs: planned.runMs });
      finished += 1;
    }
    while (arrivals.length > 0 && arrivals[0].arriveAt <= t) {
      const p = /** @type {PlannedJob} */ (arrivals.shift());
      run({ type: 'request', now: t, job: job({ ...p.spec, id: p.id }) });
    }
    run({ type: 'tick', now: t });
    const nextExit = Math.min(Infinity, ...exits.values());
    const nextArrival = arrivals.length > 0 ? arrivals[0].arriveAt : Infinity;
    t = Math.min(nextExit, nextArrival, t + MIN);
  }
  return { finished, grantOrder, endAt: t };
}
