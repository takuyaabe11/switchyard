// @ts-check
// switchyard report --share: 公開の場(GitHub の issue)に貼れる集計。まだ普段使いの利用者のデータが無い(ペルソナ調査 2 回目で 5 人が指摘)ので、
// 使った人が自分の数字をそのまま出せる形にする。
// 出すのは数だけ。repo・パス・コマンド・switchyard.json の profile 名・セッション id・ホスト名は出さない
// (既定の表の profile 名 default:batch は誰の設定でもないので出す)。集める側で読み比べるので、文言は言語の設定によらず英語。
/** 英語の時間の表記(言語の設定によらない): 45s・4m・1m 30s・2h 5m @param {number} ms @returns {string} */
export function duration(ms) {
  const sec = Math.round(Math.max(0, ms) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return sec % 60 === 0 ? `${min}m` : `${min}m ${sec % 60}s`;
  return min % 60 === 0 ? `${Math.floor(min / 60)}h` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

/**
 * 機械と設定のうち、公開してよいもの。
 * @typedef {{ version: string, node: string, platform: string, arch: string, cores: number, memoryGb: number, settings: Record<string, string> }} ShareMeta
 */

/** 貼られた報告で、既定から変えた設定だけを見せる(値は on/off や方針の名前で、秘密を含まない) */
export const SHARED_SETTINGS = [
  'SWITCHYARD_OBSERVE',
  'SWITCHYARD_STOP',
  'SWITCHYARD_GIT',
  'SWITCHYARD_BACKGROUND',
  'SWITCHYARD_THREAD_ENV',
  'SWITCHYARD_WRAP',
  'SWITCHYARD_RUN_GUARD',
  'SWITCHYARD_TIMEOUT_GUARD',
  'SWITCHYARD_WAIT_LOOPS',
  'SWITCHYARD_OVERCOMMIT',
  'SWITCHYARD_MEMORY',
  'SWITCHYARD_CAPACITY',
];

/**
 * 環境変数のうち、共有してよい設定の値(数か短い語だけ。それ以外の形なら「set」とだけ書く)。
 * @param {NodeJS.ProcessEnv} env @returns {Record<string, string>}
 */
export function sharedSettings(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const k of SHARED_SETTINGS) {
    const v = env[k];
    if (v === undefined || v === '') continue;
    out[k] = /^[A-Za-z0-9_.-]{1,12}$/.test(v) ? v : 'set';
  }
  return out;
}

/**
 * @param {{ summary: import('./report.mjs').Summary, observed: import('./observe.mjs').ObservedSummary | null, meta: ShareMeta }} input
 * @returns {string}
 */
export function formatShare({ summary: s, observed, meta }) {
  const settings = Object.entries(meta.settings).map(([k, v]) => `${k}=${v}`);
  const reasons = Object.entries(s.reasons)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${k} ${n}`);
  // 既定の表の profile は名前ごと、switchyard.json の profile はまとめて(名前は repo の中身を明かしうる)
  /** @type {Map<string, { count: number, medians: number[] }>} */
  const byName = new Map();
  let projectRuns = 0;
  let projectKinds = 0;
  // profile に当たらず switchyard run で包んだ走行(profile の名前が cmd:<コマンドの語>)は、本数だけ
  let unclassifiedRuns = 0;
  for (const p of s.byProfile) {
    if (p.profile.startsWith('cmd:')) {
      unclassifiedRuns += p.count;
    } else if (p.profile.startsWith('default:')) {
      const got = byName.get(p.profile) ?? { count: 0, medians: [] };
      got.count += p.count;
      got.medians.push(p.medianMs);
      byName.set(p.profile, got);
    } else {
      projectRuns += p.count;
      projectKinds += 1;
    }
  }
  const profileText = [...byName].map(([name, v]) => {
    const sorted = [...v.medians].sort((x, y) => x - y);
    return `${name} ${v.count} runs (typical run ${duration(sorted[Math.floor((sorted.length - 1) / 2)])})`;
  });
  if (projectKinds > 0) profileText.push(`project profiles ${projectRuns} runs in ${projectKinds} profile/repo pairs`);
  if (unclassifiedRuns > 0) profileText.push(`wrapped without a profile ${unclassifiedRuns} runs`);

  // 学べた遅れの倍率(数だけ。どの profile かは出さない)
  const slowdowns = s.byProfile.flatMap((p) => (p.slowdown === null ? [] : [p.slowdown.slowdown])).sort((a, b) => a - b);
  const lines = [
    '### switchyard field report',
    '',
    `- switchyard ${meta.version}, Node ${meta.node}, ${meta.platform} ${meta.arch}, ${meta.cores} cores, ${meta.memoryGb} GB`,
    `- settings changed from the defaults: ${settings.length > 0 ? settings.join(', ') : 'none'}`,
    `- period: ${s.spanDays} day(s), ${s.sessions} session(s), ${s.jobs} jobs`,
    `- finished runs: ${s.runs}; held back so they would not overlap: ${s.avoided} (total wait ${duration(s.totalWaitMs)}); measurements run alone: ${s.measureRuns}`,
    `- waited: ${s.waited} (median ${duration(s.waitMs.median)}, max ${duration(s.waitMs.max)})${reasons.length > 0 ? `; why: ${reasons.join(', ')}` : ''}`,
    `- packed into measured spare CPU: ${s.packed}; borrowed beyond capacity: ${s.borrows}; sized down to learned use: ${s.sized}`,
    `- runs by profile: ${profileText.length > 0 ? profileText.join('; ') : 'none'}`,
    `- slowdown when overlapped, learned for ${slowdowns.length} profile/repo pair(s)${slowdowns.length > 0 ? `: ${slowdowns.map((x) => `${x}x`).join(', ')}` : ''}; admitted without waiting as not slowed by overlap: ${s.tolerant}; slowdown avoided by holding back (estimate, not measured): ${duration(s.delay.avoidedMs)} over ${s.delay.runs} run(s)`,
    `- failed runs: ${s.failures} (${s.environmental} flagged as possibly not the code); unmanaged runs: ${s.unmanaged}; escaping children: ${s.escapes}`,
    `- PreToolUse: background ${s.hook.background}, wrapped ${s.hook.wrap}, refused ${s.hook.deny}, asked ${s.hook.ask}`,
    `- Bash time limit: cut off ${s.hook.timeout}, given more time ${s.hook.extend}, sent to background as too long ${s.hook.timeoutBackground}, waiting loops sent to background ${s.hook.waitBackground}; failed on a port in use ${s.hook.port} (holder found ${s.hook.portFound})`,
  ];
  if (observed !== null) {
    lines.push(
      `- observe mode: ${observed.overlapped} of ${observed.heavy} heavy runs overlapped another (${duration(observed.overlapMs)} in total) across ${observed.sessions} session(s); measurements beside a heavy run: ${observed.measureDisturbed}; same-lock overlaps: ${observed.lockClashes}`,
    );
  }
  lines.push('', '_Counts only: no repository, path, command, project profile name or session id is included._');
  return `${lines.join('\n')}\n`;
}
