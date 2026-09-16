// @ts-check
// switchyard の版(package.json の version)。デーモンと plugin の版の食い違いを知らせるのに使う(設計 §9.6)。
import { readFileSync } from 'node:fs';

/** @type {string} */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
