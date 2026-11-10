#!/usr/bin/env node
// `tension` — the entry point npm links as `node_modules/.bin/tension`.
//
// Everything is in `src/cli.js`; this file exists so the bin entry is a path
// npm can link and a debugger can step through without a wrapper, and so the
// executable bit belongs to one small file rather than to the dispatcher.

import { main } from '../src/cli.js';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // `main` already prints the errors it expects. Anything here is a defect in
  // the CLI, so the stack is the useful output.
  process.stderr.write(`tension: internal error: ${error?.stack ?? error}\n`);
  process.exitCode = 70;
}
