// @ts-check
// state.json(規則層の状態の正本)と events.jsonl(追記のみの記録)。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { EstimateBook } from '../core/estimate.mjs';

/** @typedef {import('../core/types.mjs').State} State */
/** @typedef {{ at: number, session: string, repo: string, profile: string, cmd: string, code: number | null, durationMs: number }} UnmanagedRun */

/** 一時ファイルに書いて rename で置き換える(書きかけの state.json を残さない) @param {string} file @param {unknown} value */
export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, file);
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
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
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
