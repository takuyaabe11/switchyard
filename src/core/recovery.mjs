// @ts-check
/** @typedef {import('./types.mjs').State} State */

/**
 * 再起動したデーモンが state.json を読んだ直後に通す。
 * 前の起動の単調時計は意味を失うので、時刻を今に付け替え、包みの再接続を待つ印を付ける。
 * 待った時間の加点と、走行中の見込み終了はここで失われる(資源を早く返しすぎない側に倒れる)。
 * 孤児には包みが居ないので印を付けない(デーモンが子の生存を見に行く)。
 * @param {State} s @param {number} now @returns {State}
 */
export function rebaseForRecovery(s, now) {
  return {
    ...s,
    waiting: s.waiting.map((w) => ({ ...w, arrivedAt: now, recovering: true })),
    leases: s.leases.map((l) => (l.phase === 'orphan' ? { ...l, grantedAt: now } : { ...l, grantedAt: now, recovering: true })),
    notes: {},
  };
}
