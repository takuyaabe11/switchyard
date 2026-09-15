// @ts-check
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 一時の CONDUCTOR_HOME。socket のパス長の上限に収まるよう、短い名前にする */
export function tempHome() {
  return mkdtempSync(join(tmpdir(), 'cd-'));
}
