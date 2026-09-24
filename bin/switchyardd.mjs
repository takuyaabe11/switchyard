#!/usr/bin/env node
// @ts-check
import { main } from '../src/daemon/main.mjs';
import { t } from '../src/i18n.mjs';

main().catch((e) => {
  console.error(`${t('[switchyardd] 起動に失敗', '[switchyardd] failed to start')}: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
