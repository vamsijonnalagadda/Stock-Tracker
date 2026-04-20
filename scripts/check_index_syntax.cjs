const fs = require('fs');
const s = fs.readFileSync('index.html', 'utf8');
const m = s.match(/<script[^>]*>([\s\S]*)<\\/script>/i);
if (!m) { console.log('NO_SCRIPT_BLOCK'); process.exit(0); }
const script = m[1];
try {
  new Function(script);
  console.log('PARSE_OK');
} catch (e) {
  console.log('SYNTAX_ERROR', e.message);
  if (e.lineNumber) {
    const lines = script.split(/\n/);
    const ln = e.lineNumber;
    const start = Math.max(0, ln - 6);
    const end = Math.min(lines.length, ln + 4);
    for (let i = start; i < end; i++) {
      console.log((i + 1) + ': ' + lines[i]);
    }
  }
}
