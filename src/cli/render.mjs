// @ts-check
// top と why の表示。
/** @typedef {import('../protocol/messages.mjs').Snapshot} Snapshot */
/** @typedef {import('../core/types.mjs').JobClass} JobClass */
/** @typedef {import('../core/types.mjs').Unacked} Unacked */

/** @type {Record<JobClass, string>} */
const CLASS_LABEL = { quick: '短', batch: '重', measure: '計測' };

/** @param {number} ms @returns {string} */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分`;
  return `${Math.floor(m / 60)}時間${m % 60}分`;
}

/** @param {number} wall @returns {string} */
export function clock(wall) {
  return new Date(wall).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

/** @param {Unacked} u */
const unackedText = (u) => `${u.kind}${u.code === null ? '' : `(終了コード ${u.code})`} ${u.cmd}`;

/** @param {Snapshot} snap @param {number} nowWall @returns {string} */
export function renderTop(snap, nowWall) {
  const lines = [`CPU ${snap.used} / ${snap.capacity} 使用中  走行 ${snap.leases.length} 本  待ち ${snap.waiting.length} 本`];
  if (snap.leases.length === 0 && snap.waiting.length === 0) lines.push('走行も待ちも無い');
  if (snap.leases.length > 0) {
    lines.push('走行:');
    for (const l of snap.leases) {
      const phase = l.phase === 'orphan' ? '孤児' : l.phase === 'granted' ? '起動待ち' : '走行';
      const extras = [l.recovering ? '再接続待ち' : '', l.why === null ? '' : `目的: ${l.why}`, l.locks.length === 0 ? '' : `鍵: ${l.locks.join(', ')}`].filter((x) => x !== '');
      lines.push(`  ${l.id} [${CLASS_LABEL[l.class]}] ${phase} CPU ${l.cpus} ${duration(nowWall - l.sinceWall)}  ${l.cmd}${extras.length === 0 ? '' : `  (${extras.join(' / ')})`}`);
    }
  }
  if (snap.waiting.length > 0) {
    lines.push('待ち:');
    snap.waiting.forEach((w, i) => {
      const reason = w.recovering ? '再起動したデーモンが包みの再接続を待っている' : w.note === null ? '判断待ち' : w.note.reason;
      const eta = w.note !== null && w.note.etaWall !== null ? `  見込み ${clock(w.note.etaWall)}` : '';
      lines.push(`  ${i + 1}. ${w.id} [${CLASS_LABEL[w.class]}] ${w.cmd}  ${duration(nowWall - w.sinceWall)}待ち  理由: ${reason}${eta}`);
    });
  }
  const sessions = Object.entries(snap.unacked).filter(([, list]) => list.length > 0);
  if (sessions.length > 0) {
    lines.push('未確認(conductor ack <job> で確認済みにする):');
    for (const [session, list] of sessions) for (const u of list) lines.push(`  ${session}: ${u.jobId} ${unackedText(u)}`);
  }
  if (snap.badRecords > 0) lines.push(`記録の読めない行: ${snap.badRecords}`);
  return `${lines.join('\n')}\n`;
}

/**
 * @param {Snapshot} snap @param {string} jobId @param {number} nowWall
 * @returns {{ text: string, found: boolean }}
 */
export function renderWhy(snap, jobId, nowWall) {
  const l = snap.leases.find((x) => x.id === jobId);
  if (l !== undefined) {
    if (l.phase === 'orphan') return { text: `${jobId} は孤児: 包みを見失ったが、子はまだ生きている。子が終わると資源を返す。\n`, found: true };
    const state = l.recovering ? '再起動したデーモンが包みの再接続を待っている' : l.phase === 'granted' ? '割り振り済みで、子の起動を待っている' : '走行中';
    return { text: `${jobId} は${state}(CPU ${l.cpus}・${duration(nowWall - l.sinceWall)})。\n`, found: true };
  }
  const i = snap.waiting.findIndex((x) => x.id === jobId);
  if (i >= 0) {
    const w = snap.waiting[i];
    if (w.recovering) return { text: `${jobId} は待ち列に居る。再起動したデーモンが包みの再接続を待っている。\n`, found: true };
    const reason = w.note === null ? '判断待ち' : w.note.reason;
    const eta = w.note !== null && w.note.etaWall !== null ? `。見込み ${clock(w.note.etaWall)}` : '';
    return { text: `${jobId} は待ち列の ${i + 1} 番目(${duration(nowWall - w.sinceWall)}待ち)。理由: ${reason}${eta}。\n`, found: true };
  }
  for (const [session, list] of Object.entries(snap.unacked)) {
    const u = list.find((x) => x.jobId === jobId);
    if (u !== undefined) return { text: `${jobId} は終わっている: ${unackedText(u)}(セッション ${session})。conductor ack ${jobId} で確認済みにする。\n`, found: true };
  }
  return { text: `${jobId} は見つからない(正常に終わったか、確認済みか、存在しない)。\n`, found: false };
}
