// Checks the source files against .editorconfig: UTF-8 without a byte-order mark, lines of at most 140 characters (120
// for comments), LF line endings, no tabs or trailing spaces, and a final newline. Markdown is left out.
// Usage: npm run check-style
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { GIT } from './git.mjs';

const MAX = 140;
const MAX_COMMENT = 120;
const CHECKED = /\.(m?js|cjs|css|html|ps1|ya?ml)$/;
// a line that is only a comment: //, # (PowerShell, YAML), or a line of a /* */ or /** */ block
const COMMENT = /^\s*(\/\/|#|\/\*|\*)/;

const files = execFileSync(GIT, ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n').filter((f) => CHECKED.test(f));
const problems = [];
for (const f of files) {
  let text;
  // deleted but not yet staged
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (text.startsWith('﻿')) problems.push(`${f}: byte-order mark`);
  if (text.includes('\r')) problems.push(`${f}: CRLF line endings`);
  if (text && !text.endsWith('\n')) problems.push(`${f}: no newline at the end`);
  text.split('\n').forEach((line, i) => {
    const where = `${f}:${i + 1}`;
    const length = [...line].length;
    if (length > MAX) problems.push(`${where}: ${length} characters`);
    else if (length > MAX_COMMENT && COMMENT.test(line)) problems.push(`${where}: a ${length}-character comment`);
    if (line.includes('\t')) problems.push(`${where}: tab`);
    if (/[ \t]+$/.test(line)) problems.push(`${where}: trailing spaces`);
  });
}
for (const p of problems) console.log(p);
console.log(problems.length ? `${problems.length} problems in ${files.length} files` : `${files.length} files checked`);
process.exitCode = problems.length ? 1 : 0;
