#!/usr/bin/env node
// @ts-check
import { main } from '../src/daemon/main.mjs';

main().catch((e) => {
  console.error(`[conductord] 起動に失敗: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
