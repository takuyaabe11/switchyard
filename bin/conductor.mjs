#!/usr/bin/env node
// @ts-check
import { cli } from '../src/cli/main.mjs';

cli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`[conductor] ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  },
);
