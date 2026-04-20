import fetch from 'node-fetch';
import YahooFinance from 'yahoo-finance2';
import fs from 'fs';

const API_NEXT = 'http://localhost:4000/api/earnings/next-week';
const API_SET_NEXT = 'http://localhost:4000/internal/set-next-week';
const OUT_PATH = './data/earnings_next.json';

function sanitize(name, fallback) {
  if (!name) return fallback;
  return String(name)
    .replace(/\bYahoo Finance\b/ig, '')
    .replace(/\b(inc\.?|corp\.?|corporation|company|co\.?|limited|ltd\.?|plc|holdings?)\b/ig, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+/g, ' ')
    .trim() || fallback;
}

(async function main(){
  try {
    const res = await fetch(API_NEXT, {timeout: 20000});
    const data = await res.json();
    const days = data.days || {};
    const rows = Object.values(days).flat();
    const need = rows.filter(r => !r.companyName || String(r.companyName).trim().toUpperCase() === String(r.symbol||'').trim().toUpperCase());
    const symbols = [...new Set(need.map(r=>String(r.symbol||'').toUpperCase()).filter(Boolean))];
    console.log('symbols needing enrichment:', symbols.length);
    const yf = new YahooFinance();
    let updated = 0;
    const examples = [];
    for (let i=0;i<symbols.length;i++){
      const sym = symbols[i];
      try{
        const q = await yf.quote(sym);
        const name = sanitize(q?.shortName || q?.longName, sym);
        for (const dayKey of Object.keys(days)){
          for (const row of days[dayKey]){
            if (String(row.symbol||'').toUpperCase() === sym){
              if (!row.companyName || String(row.companyName||'').trim().toUpperCase() === sym){
                row.companyName = name;
                updated += 1;
                if (examples.length<10) examples.push([sym,name]);
              }
            }
          }
        }
      } catch (e){
        // ignore per-symbol
      }
      if (i%40===0) await new Promise(r=>setTimeout(r,1200)); else await new Promise(r=>setTimeout(r,200));
    }
    const out = { updatedAt: data.updatedAt || Date.now(), weekStart: data.weekStart, days };
    try{ fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2)); console.log('wrote', OUT_PATH); }catch(e){console.log('write failed', e)}
    try{
      const r2 = await fetch(API_SET_NEXT, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(out), timeout: 20000 });
      const j = await r2.text();
      console.log('server response:', j);
    }catch(e){ console.log('post failed', e); }
    console.log('updated_fields=', updated);
    console.log('examples=', examples.slice(0,10));
  } catch (err) {
    console.error('failed', err);
    process.exit(1);
  }
})();
