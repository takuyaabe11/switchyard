// @ts-check
// top と why の表示。
import { t } from '../i18n.mjs';

/** @typedef {import('../protocol/messages.mjs').Snapshot} Snapshot */
/** @typedef {import('../core/types.mjs').JobClass} JobClass */
/** @typedef {import('../core/types.mjs').Unacked} Unacked */
/** @typedef {import('../run/watch.mjs').EscapeReport} EscapeReport */

/** @returns {Record<JobClass, string>} */
const classLabel = () => ({ quick: t('短', 'quick'), batch: t('重', 'batch'), measure: t('計測', 'measure') });

/** @param {number} ms @returns {string} */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t(`${s}秒`, `${s}s`);
  const m = Math.floor(s / 60);
  if (m < 60) return t(`${m}分`, `${m}m`);
  return t(`${Math.floor(m / 60)}時間${m % 60}分`, `${Math.floor(m / 60)}h${m % 60}m`);
}

/** @param {number} wall @returns {string} */
export function clock(wall) {
  return new Date(wall).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

/** @param {Unacked} u */
const unackedText = (u) => `${u.kind}${u.code === null ? '' : t(`(終了コード ${u.code})`, ` (exit code ${u.code})`)} ${u.cmd}`;

/** @param {boolean} inGroup */
const groupWord = (inGroup) => (inGroup ? t('グループ内', 'in group') : t('グループ外', 'outside group'));

const RECONNECT = () => t('再起動したデーモンが包みの再接続を待っている', 'the restarted daemon is waiting for the wrapper to reconnect');

/** @param {Snapshot} snap @param {number} nowWall @returns {string} */
export function renderTop(snap, nowWall) {
  const label = classLabel();
  const lines = [
    t(
      `CPU ${snap.used} / ${snap.capacity} 使用中  走行 ${snap.leases.length} 本  待ち ${snap.waiting.length} 本`,
      `CPU ${snap.used} / ${snap.capacity} in use  running ${snap.leases.length}  waiting ${snap.waiting.length}`,
    ),
  ];
  if (snap.leases.length === 0 && snap.waiting.length === 0) lines.push(t('走行も待ちも無い', 'nothing running or waiting'));
  if (snap.leases.length > 0) {
    lines.push(t('走行:', 'Running:'));
    for (const l of snap.leases) {
      const phase = l.phase === 'orphan' ? t('孤児', 'orphan') : l.phase === 'granted' ? t('起動待ち', 'starting') : t('走行', 'running');
      const extras = [
        l.recovering ? t('再接続待ち', 'awaiting reconnect') : '',
        l.why === null ? '' : t(`目的: ${l.why}`, `why: ${l.why}`),
        l.locks.length === 0 ? '' : t(`鍵: ${l.locks.join(', ')}`, `locks: ${l.locks.join(', ')}`),
        l.escapes.length === 0 ? '' : t(`抜ける子: ${l.escapes.join(', ')}`, `escaping children: ${l.escapes.join(', ')}`),
      ].filter((x) => x !== '');
      lines.push(`  ${l.id} [${label[l.class]}] ${phase} CPU ${l.cpus} ${duration(nowWall - l.sinceWall)}  ${l.cmd}${extras.length === 0 ? '' : `  (${extras.join(' / ')})`}`);
    }
  }
  if (snap.waiting.length > 0) {
    lines.push(t('待ち:', 'Waiting:'));
    snap.waiting.forEach((w, i) => {
      const reason = w.recovering ? RECONNECT() : w.note === null ? t('判断待ち', 'not decided yet') : w.note.reason;
      const eta = w.note !== null && w.note.etaWall !== null ? t(`  見込み ${clock(w.note.etaWall)}`, `  expected ${clock(w.note.etaWall)}`) : '';
      const esc = w.escapes.length === 0 ? '' : t(`  抜ける子: ${w.escapes.join(', ')}`, `  escaping children: ${w.escapes.join(', ')}`);
      const waited = duration(nowWall - w.sinceWall);
      lines.push(
        t(
          `  ${i + 1}. ${w.id} [${label[w.class]}] ${w.cmd}  ${waited}待ち  理由: ${reason}${eta}${esc}`,
          `  ${i + 1}. ${w.id} [${label[w.class]}] ${w.cmd}  waited ${waited}  reason: ${reason}${eta}${esc}`,
        ),
      );
    });
  }
  const sessions = Object.entries(snap.unacked).filter(([, list]) => list.length > 0);
  if (sessions.length > 0) {
    lines.push(t('未確認(switchyard ack <job> で確認済みにする):', 'Not looked at yet (mark with switchyard ack <job>):'));
    for (const [session, list] of sessions) for (const u of list) lines.push(`  ${session}: ${u.jobId} ${unackedText(u)}`);
  }
  if (snap.badRecords > 0) lines.push(t(`記録の読めない行: ${snap.badRecords}`, `unreadable log lines: ${snap.badRecords}`));
  return `${lines.join('\n')}\n`;
}

/**
 * @param {Snapshot} snap @param {string} jobId @param {number} nowWall
 * @returns {{ text: string, found: boolean }}
 */
export function renderWhy(snap, jobId, nowWall) {
  const r = whyText(snap, jobId, nowWall);
  const view = snap.leases.find((x) => x.id === jobId) ?? snap.waiting.find((x) => x.id === jobId);
  if (view === undefined || view.escapes.length === 0) return r;
  const names = view.escapes.join(', ');
  return {
    text:
      r.text +
      t(
        `この profile では過去に子がプロセスグループから抜けた(${names})。信号と使用率の照合が届かない。\n`,
        `Children of this profile have left the process group before (${names}); signals and CPU accounting do not reach them.\n`,
      ),
    found: r.found,
  };
}

/**
 * @param {Snapshot} snap @param {string} jobId @param {number} nowWall
 * @returns {{ text: string, found: boolean }}
 */
function whyText(snap, jobId, nowWall) {
  const l = snap.leases.find((x) => x.id === jobId);
  if (l !== undefined) {
    if (l.phase === 'orphan') {
      return {
        text: t(
          `${jobId} は孤児: 包みを見失ったが、子はまだ生きている。子が終わると資源を返す。\n`,
          `${jobId} is an orphan: its wrapper is gone but the child is still alive. Its resources return when the child ends.\n`,
        ),
        found: true,
      };
    }
    const state = l.recovering ? RECONNECT() : l.phase === 'granted' ? t('割り振り済みで、子の起動を待っている', 'granted and waiting for the child to start') : t('走行中', 'running');
    const since = duration(nowWall - l.sinceWall);
    return { text: t(`${jobId} は${state}(CPU ${l.cpus}・${since})。\n`, `${jobId} is ${state} (CPU ${l.cpus}, ${since}).\n`), found: true };
  }
  const i = snap.waiting.findIndex((x) => x.id === jobId);
  if (i >= 0) {
    const w = snap.waiting[i];
    if (w.recovering) return { text: t(`${jobId} は待ち列に居る。${RECONNECT()}。\n`, `${jobId} is in the queue; ${RECONNECT()}.\n`), found: true };
    const reason = w.note === null ? t('判断待ち', 'not decided yet') : w.note.reason;
    const eta = w.note !== null && w.note.etaWall !== null ? t(`。見込み ${clock(w.note.etaWall)}`, `; expected ${clock(w.note.etaWall)}`) : '';
    const waited = duration(nowWall - w.sinceWall);
    return {
      text: t(`${jobId} は待ち列の ${i + 1} 番目(${waited}待ち)。理由: ${reason}${eta}。\n`, `${jobId} is #${i + 1} in the queue (waited ${waited}). Reason: ${reason}${eta}.\n`),
      found: true,
    };
  }
  for (const [session, list] of Object.entries(snap.unacked)) {
    const u = list.find((x) => x.jobId === jobId);
    if (u !== undefined) {
      return {
        text: t(
          `${jobId} は終わっている: ${unackedText(u)}(セッション ${session})。switchyard ack ${jobId} で確認済みにする。\n`,
          `${jobId} has ended: ${unackedText(u)} (session ${session}). Mark it with switchyard ack ${jobId}.\n`,
        ),
        found: true,
      };
    }
  }
  return {
    text: t(`${jobId} は見つからない(正常に終わったか、確認済みか、存在しない)。\n`, `${jobId} not found (it ended cleanly, was already acked, or never existed).\n`),
    found: false,
  };
}

/**
 * switchyard probe の結果の表示。
 * @param {EscapeReport & { command: string, group: number }} r @returns {string}
 */
export function renderProbe(r) {
  const none = t('なし', 'none');
  const escaped = r.escaped.length === 0 ? none : r.escaped.map((e) => `${e.comm} ×${e.count}`).join(', ');
  const survivors =
    r.survivors.length === 0
      ? none
      : t(
          `${r.survivors.map((x) => `${x.comm}(pid ${x.pid}・${groupWord(x.inGroup)})`).join(', ')}(SIGKILL で片付けた)`,
          `${r.survivors.map((x) => `${x.comm} (pid ${x.pid}, ${groupWord(x.inGroup)})`).join(', ')} (cleaned up with SIGKILL)`,
        );
  return [
    t(`コマンド: ${r.command}`, `command: ${r.command}`),
    t(`観察した子孫: ${r.seen}(プロセスグループ ${r.group})`, `descendants seen: ${r.seen} (process group ${r.group})`),
    t(`グループから抜けた子: ${escaped}`, `children that left the group: ${escaped}`),
    t(`SIGTERM の後も生きていた子: ${survivors}`, `children alive after SIGTERM: ${survivors}`),
    '',
  ].join('\n');
}
