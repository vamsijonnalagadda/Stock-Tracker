const fs=require('fs');
const s=fs.readFileSync('index.html','utf8');
const scriptMatch = s.match(/<script[^>]*>([\s\S]*)<\/script>/i);
if(!scriptMatch){ console.log('NO_SCRIPT_BLOCK'); process.exit(0); }
const script = scriptMatch[1];
try{ new Function(script); console.log('PARSE_OK'); }catch(e){ console.log('SYNTAX_ERROR', e.message); console.log(e.stack.split('\n').slice(0,6).join('\n')); }
