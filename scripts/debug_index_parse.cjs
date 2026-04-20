#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const sIdx = html.indexOf('<script');
if (sIdx === -1) {
  console.error('No <script> tag found in', file);
  process.exit(2);
}
const openEnd = html.indexOf('>', sIdx);
const close = html.lastIndexOf('</script>');
const script = html.substring(openEnd + 1, close);
const lines = script.split('\n');
console.log('Debug parse for', file);
console.log('Script length:', script.length, 'lines:', lines.length);

function tryParse(src) {
  try {
    new Function(src);
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e };
  }
}

const full = tryParse(script);
if (full.ok) {
  console.log('PARSE_OK: inline script parses with new Function()');
  process.exit(0);
}

console.error('PARSE_FAIL:', full.err && full.err.message);

// Binary search to find failing line
let lo = 1, hi = lines.length, fail = hi;
while (lo <= hi) {
  const mid = Math.floor((lo + hi) / 2);
  const src = lines.slice(0, mid).join('\n');
  const res = tryParse(src);
  if (!res.ok) {
    fail = mid;
    hi = mid - 1;
  } else {
    lo = mid + 1;
  }
}

console.error('Approx failing line in inline script (1-based):', fail);
const startLine = Math.max(1, fail - 6);
const endLine = Math.min(lines.length, fail + 6);
console.error('Context lines', startLine + '-' + endLine + ':');
for (let i = startLine; i <= endLine; i++) {
  const prefix = (i === fail) ? '>> ' : '   ';
  const text = lines[i - 1].replace(/\t/g, '  ');
  console.error(prefix + (String(i).padStart(4) + ': ') + text);
}

// Bracket/paren balance scan
let curly = 0, paren = 0, brack = 0, badPos = null;
for (let i = 0, lineNo = 1, col = 0; i < script.length; i++) {
  const ch = script[i];
  if (ch === '\n') { lineNo++; col = 0; continue; }
  col++;
  if (ch === '{') curly++; if (ch === '}') curly--; 
  if (ch === '(') paren++; if (ch === ')') paren--; 
  if (ch === '[') brack++; if (ch === ']') brack--; 
  if ((curly < 0 || paren < 0 || brack < 0) && !badPos) {
    badPos = { line: lineNo, col, idx: i, curly, paren, brack };
  }
}

console.error('Final balances: curly=', curly, 'paren=', paren, 'brack=', brack);
if (badPos) {
  console.error('First negative balance at', badPos);
  const ctxStart = Math.max(0, badPos.idx - 160);
  const ctx = script.slice(ctxStart, Math.min(script.length, badPos.idx + 80));
  console.error('Context around negative balance:\n----\n' + ctx + '\n----');
}

process.exit(1);
