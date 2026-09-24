// @ts-check
// 規則層で共有する型。実行時の値は持たない。

/** @typedef {'quick' | 'batch' | 'measure'} JobClass */
/** @typedef {'pause' | 'throttle' | 'never'} Preempt */
/** @typedef {{ min: number, max: number }} CpuRange */

/**
 * ジョブの宣言。id と expectedMs はデーモンが埋める。
 * @typedef {{
 *   id: string,
 *   session: string,
 *   repo: string,
 *   profile: string,
 *   cmd: string,
 *   class: JobClass,
 *   cpus: CpuRange,
 *   locks: string[],
 *   preempt: Preempt,
 *   why: string | null,
 *   expectedMs: number | null,
 *   parent?: string | null,
 *   sizedFrom?: CpuRange,
 *   measuredCores?: number
 * }} JobSpec
 */

/** @typedef {{ job: JobSpec, arrivedAt: number, recovering: boolean }} Waiting */

/** @typedef {'granted' | 'running' | 'orphan'} LeasePhase */

/**
 * @typedef {{
 *   job: JobSpec,
 *   cpus: number,
 *   grantedAt: number,
 *   phase: LeasePhase,
 *   pid: number | null,
 *   pgid: number | null,
 *   recovering: boolean,
 *   lockChild?: boolean,
 *   held?: 'pause' | 'throttle'
 * }} Lease
 */

/** @typedef {'failed' | 'killed' | 'orphan' | 'lost'} UnackedKind */
/**
 * repo と profile は、後の成功で自動に確認済みにするための手がかり(0.5.0 以前の state.json には無い)。
 * @typedef {{ jobId: string, kind: UnackedKind, code: number | null, cmd: string, repo?: string, profile?: string }} Unacked
 */
/** @typedef {{ jobId: string, position: number, reason: string, etaAt: number | null }} QueueNote */

/**
 * @typedef {{
 *   capacity: number,
 *   lockCaps: Record<string, number>,
 *   waiting: Waiting[],
 *   leases: Lease[],
 *   favorNonMeasure: boolean,
 *   unacked: Record<string, Unacked[]>,
 *   notes: Record<string, QueueNote>
 * }} State
 */

/**
 * @typedef {(
 *   { type: 'request', now: number, job: JobSpec } |
 *   { type: 'started', now: number, jobId: string, pid: number, pgid: number | null } |
 *   { type: 'exit', now: number, jobId: string, code: number | null, killedByCaller: boolean, durationMs: number, cpuMs?: number | null } |
 *   { type: 'cancel', now: number, jobId: string } |
 *   { type: 'heartbeatLost', now: number, jobId: string, alive: boolean } |
 *   { type: 'orphanGone', now: number, jobId: string } |
 *   { type: 'resume', now: number, jobId: string, pid: number | null, pgid: number | null } |
 *   { type: 'ack', now: number, session: string, jobId: string } |
 *   { type: 'unmanagedExit', now: number, session: string, jobId: string, code: number | null, cmd: string, repo?: string, profile?: string } |
 *   { type: 'tick', now: number }
 * )} Event
 */

/**
 * @typedef {(
 *   { type: 'grant', jobId: string, cpus: number, lockChild?: boolean } |
 *   { type: 'queued', jobId: string, position: number, reason: string, etaAt: number | null } |
 *   { type: 'history', repo: string, profile: string, class: JobClass, cpus: number, durationMs: number, code: number | null, cpuMs?: number | null } |
 *   { type: 'hold', jobId: string, mode: 'pause' | 'throttle' } |
 *   { type: 'unhold', jobId: string }
 * )} Action
 */

export {};
