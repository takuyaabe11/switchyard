// @ts-check
// state.json(規則層の状態の正本)と events.jsonl(追記のみの記録)。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { EstimateBook } from '../core/estimate.mjs';
import { UsageBook } from '../core/usage.mjs';
import { MemoryBook } from '../core/memory.mjs';
import { ensurePrivateDir, PRIVATE_FILE_MODE } from './paths.mjs';

/** @typedef {import('../core/types.mjs').State} State */
/** @typedef {{ at: number, session: string, repo: string, profile: string, cmd: string, code: number | null, durationMs: number }} UnmanagedRun */

/** 一時ファイルに書いて rename で置き換える(書きかけの state.json を残さない) @param {string} file @param {unknown} value @param {string} [text] 既に作ってある JSON */
export function writeJsonAtomic(file, value, text = JSON.stringify(value)) {
  ensurePrivateDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: PRIVATE_FILE_MODE });
  renameSync(tmp, file);
}

/**
 * 中身が前と変わったときだけ書く書き手を作る。
 * デーモンは出来事のたびに状態を書き直すが、tick は何も起きなくても 5 秒ごとに来るので、
 * そのままでは待ちも走行も無い間ずっと write + rename が続く(既定の tick で 1 日 17,280 回)。
 * @param {string} file @returns {(value: unknown) => boolean} 書いたら true
 */
export function createStateWriter(file) {
  /** @type {string | null} */
  let last = null;
  return (value) => {
    const text = JSON.stringify(value);
    if (text === last) return false;
    writeJsonAtomic(file, value, text);
    last = text;
    return true;
  };
}

/** @param {string} file @returns {unknown} 無い・壊れているときは null */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 形を確かめてから State として受け取る。合わなければ null(壊れた状態で動き出さない)。
 * @param {unknown} v @returns {State | null}
 */
export function parseState(v) {
  if (typeof v !== 'object' || v === null) return null;
  const o = /** @type {Record<string, unknown>} */ (v);
  const ok =
    typeof o.capacity === 'number' &&
    typeof o.lockCaps === 'object' && o.lockCaps !== null &&
    Array.isArray(o.waiting) &&
    Array.isArray(o.leases) &&
    typeof o.favorNonMeasure === 'boolean' &&
    typeof o.unacked === 'object' && o.unacked !== null &&
    typeof o.notes === 'object' && o.notes !== null;
  return ok ? /** @type {State} */ (v) : null;
}

/** @param {string} file @param {Record<string, unknown>} record */
export function appendRecord(file, record) {
  ensurePrivateDir(dirname(file));
  appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: PRIVATE_FILE_MODE });
}

/** @param {string} file @returns {{ records: Record<string, unknown>[], bad: number }} */
export function readRecords(file) {
  if (!existsSync(file)) return { records: [], bad: 0 };
  /** @type {Record<string, unknown>[]} */
  const records = [];
  let bad = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v = JSON.parse(line);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) records.push(v);
      else bad += 1;
    } catch {
      bad += 1;
    }
  }
  return { records, bad };
}

/** 追記だけの記録の上限。超えたら 1 世代だけ別名(`<file>.1`)へ回す */
export const JOURNAL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 記録が上限を超えていたら、いまのファイルを `<file>.1` へ回して本体を空にする。
 * 追記しか無いと、デーモンの起動のたびに全行を読んで見込みと escape の表を作るのが際限なく重くなる。
 * 消さずに 1 世代残す(readJournal が両方を読む)ので、直前ぶんは失われない。
 * 2 世代前は落ちるので、ディスクは上限の約 2 倍で止まる。
 * @param {string} file @param {number} [maxBytes] @returns {boolean} 回したか
 */
export function rotateRecords(file, maxBytes = JOURNAL_MAX_BYTES) {
  /** @type {number} */
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return false; // 無ければ回すものが無い
  }
  if (size <= maxBytes) return false;
  try {
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false; // 回せなくても、記録の追記は続く
  }
}

/**
 * 回した 1 世代前(`<file>.1`)と本体を、古い順につないで読む。
 * @param {string} file @returns {{ records: Record<string, unknown>[], bad: number }}
 */
export function readJournal(file) {
  const old = readRecords(`${file}.1`);
  const now = readRecords(file);
  return { records: [...old.records, ...now.records], bad: old.bad + now.bad };
}

/**
 * 管理なしで走ったジョブの控えを取り出す(設計 §4.2)。包みの書き込みとぶつからないよう、別名へ rename してから読み、
 * 読み終えたら消す。無ければ空。形の合わない行は捨てる。
 * rename と unlink の間で落ちたデーモンが残した別名(`<file>.<pid>.taking`)も拾う。取り込みは消した後にしか起きないので、
 * 残っている別名はまだ取り込まれていない。消せなかった別名は読まなかったことにして、次の取り込みに回す(2 度は取り込まない)。
 * @param {string} file @returns {UnmanagedRun[]}
 */
export function takeUnmanaged(file) {
  const dir = dirname(file);
  const prefix = `${basename(file)}.`;
  /** @param {string} path @returns {Record<string, unknown>[]} */
  const drain = (path) => {
    const { records } = readRecords(path);
    try {
      unlinkSync(path);
      return records;
    } catch {
      return [];
    }
  };
  /** @type {Record<string, unknown>[]} */
  const records = [];
  // 先に残った別名を読んで消す(同じ pid の別名を、下の rename で上書きしない)
  const leftovers = existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.taking')).sort() : [];
  for (const name of leftovers) records.push(...drain(join(dir, name)));
  if (existsSync(file)) {
    const taken = `${file}.${process.pid}.taking`;
    let renamed = true;
    try {
      renameSync(file, taken);
    } catch {
      // 読む前に他のデーモンが取った
      renamed = false;
    }
    if (renamed) records.push(...drain(taken));
  }
  /** @type {UnmanagedRun[]} */
  const out = [];
  for (const r of records) {
    const ok =
      typeof r.at === 'number' && typeof r.session === 'string' && typeof r.repo === 'string' && typeof r.profile === 'string' &&
      typeof r.cmd === 'string' && typeof r.durationMs === 'number' && (typeof r.code === 'number' || r.code === null);
    if (ok) out.push({ at: Number(r.at), session: String(r.session), repo: String(r.repo), profile: String(r.profile), cmd: String(r.cmd), code: /** @type {number | null} */ (r.code), durationMs: Number(r.durationMs) });
  }
  return out;
}

/** 記録の history 行から所要時間の帳簿を作る @param {Record<string, unknown>[]} records @returns {EstimateBook} */
export function loadEstimates(records) {
  const book = new EstimateBook();
  for (const r of records) {
    if (r.kind !== 'history') continue;
    if (typeof r.repo !== 'string' || typeof r.profile !== 'string' || typeof r.durationMs !== 'number') continue;
    book.record(r.repo, r.profile, r.durationMs, typeof r.code === 'number' ? r.code : null);
  }
  return book;
}

/**
 * 記録の history 行から、repo × profile ごとの CPU の使い方の帳簿を作る(cpuMs を持たない古い行は数えない)。
 * @param {Record<string, unknown>[]} records @returns {UsageBook}
 */
export function loadUsage(records) {
  const book = new UsageBook();
  for (const r of records) {
    if (r.kind !== 'history' || typeof r.repo !== 'string' || typeof r.profile !== 'string') continue;
    if (typeof r.durationMs !== 'number' || typeof r.cpus !== 'number') continue;
    book.record(r.repo, r.profile, { durationMs: r.durationMs, cpuMs: typeof r.cpuMs === 'number' ? r.cpuMs : null, cpus: r.cpus, code: typeof r.code === 'number' ? r.code : null });
  }
  return book;
}

/** 記録の history 行から、repo × profile ごとのピークの RSS を集める @param {Record<string, unknown>[]} records */
export function loadMemory(records) {
  const book = new MemoryBook();
  for (const r of records) {
    if (r.kind !== 'history' || typeof r.repo !== 'string' || typeof r.profile !== 'string') continue;
    book.record(r.repo, r.profile, typeof r.peakMemMb === 'number' ? r.peakMemMb : null);
  }
  return book;
}

/**
 * 記録の escape 行から、repo × profile ごとにプロセスグループから抜けた子の名前を集める(設計 §13 V6)。
 * @param {Record<string, unknown>[]} records @returns {Map<string, Set<string>>} キーは JSON.stringify([repo, profile])
 */
export function loadEscapes(records) {
  /** @type {Map<string, Set<string>>} */
  const map = new Map();
  for (const r of records) {
    if (r.kind !== 'escape' || typeof r.repo !== 'string' || typeof r.profile !== 'string' || !Array.isArray(r.escaped)) continue;
    const key = JSON.stringify([r.repo, r.profile]);
    const names = map.get(key) ?? new Set();
    for (const x of r.escaped) {
      const e = /** @type {Record<string, unknown>} */ (typeof x === 'object' && x !== null ? x : {});
      if (typeof e.comm === 'string') names.add(e.comm);
    }
    map.set(key, names);
  }
  return map;
}
