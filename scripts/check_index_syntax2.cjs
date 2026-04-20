const fs = require('fs');
const s = fs.readFileSync('index.html', 'utf8');
const start = s.indexOf('<script');
if (start === -1) { console.log('NO_SCRIPT_TAG'); process.exit(0); }
const openEnd = s.indexOf('>', start);
if (openEnd === -1) { console.log('NO_SCRIPT_OPEN_END'); process.exit(0); }
const close = s.lastIndexOf('</script>');
if (close === -1) { console.log('NO_SCRIPT_CLOSE'); process.exit(0); }
const script = s.substring(openEnd + 1, close);
try {
  new Function(script);
  console.log('PARSE_OK');
} catch (e) {
  console.log('SYNTAX_ERROR', e.message);
  if (e.lineNumber) {
    const lines = script.split('\n');
    const ln = e.lineNumber;
    const startLine = Math.max(0, ln - 6);
    const endLine = Math.min(lines.length, ln + 4);
    for (let i = startLine; i < endLine; i++) console.log((i+1)+': '+lines[i]);
  }
}
