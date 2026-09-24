#!/usr/bin/env node
// @ts-check
import { readFileSync } from 'node:fs';
import { runHook } from '../src/hooks/main.mjs';
import { t } from '../src/i18n.mjs';

const event = process.argv[2] ?? '';
runHook(event, readFileSync(0, 'utf8')).catch((e) => {
  // hook の失敗で作業を止めない: 1 行出して、止めない失敗(終了コード 1)で終わる(設計 §9.2)
  process.stderr.write(`${t(`[switchyard] hook ${event} が失敗`, `[switchyard] hook ${event} failed`)}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
