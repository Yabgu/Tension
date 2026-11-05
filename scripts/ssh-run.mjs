#!/usr/bin/env node
// Run a shell command on a remote POSIX host over ssh, with LF endings.
//
// Writing this as a script rather than a PowerShell here-string is the whole
// point: PowerShell's strings carry CRLF, and a CR at the end of a shell line
// makes bash report `$'\r': command not found` on every line — noise that hides
// the real output and has, more than once in this session, made a failing check
// look like a passing one.
//
// Usage: node scripts/ssh-run.mjs <host> <file-with-the-script>
//        node scripts/ssh-run.mjs <host> --  <command...>
//
// The script text is normalised to LF here, and the remote side runs it through
// `bash -s` reading stdin, so nothing depends on the remote's terminal settings.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [host, source, ...rest] = process.argv.slice(2);
if (!host || !source) {
  console.error('usage: node scripts/ssh-run.mjs <host> <script-file>');
  console.error('       node scripts/ssh-run.mjs <host> -- <command...>');
  process.exit(2);
}

let script;
if (source === '--') {
  script = rest.join(' ');
} else {
  script = readFileSync(source, 'utf8');
}

// The one line that matters: CRLF -> LF. A stray CR anywhere in a shell script
// breaks the line it ends, and the error names the line rather than the cause.
script = script.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const child = spawn('ssh', ['-o', 'BatchMode=yes', host, 'bash -s'], {
  stdio: ['pipe', 'inherit', 'inherit'],
});
child.stdin.end(script);
child.on('close', (code) => process.exit(code ?? 1));
