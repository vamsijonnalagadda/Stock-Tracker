import fetch from 'node-fetch';
import fs from 'fs/promises';

// Azure Function timer trigger scaffold (Node.js)
// Expects environment variable: FMP_API_KEY
// Writes to workspace `data/sector_averages.json` with historical sector metrics

const FMP_API = process.env.FMP_API || 'https://financialmodelingprep.com/api/v3';
const OUT_PATH = './data/sector_averages.json';

export default async function (context) {
  context.log('sectorAggregator function triggered');
  const apiKey = process.env.FMP_API_KEY;
  try {
    // Load existing seed/values to merge
    let existing = {};
    try { existing = JSON.parse(await fs.readFile(OUT_PATH, 'utf8')); } catch (e) {}

    // If no API key, just refresh fetchedAt and keep existing values
    if (!apiKey) {
      await fs.mkdir('./data', { recursive: true });
      await fs.writeFile(OUT_PATH, JSON.stringify({ ...existing, fetchedAt: new Date().toISOString() }, null, 2), 'utf8');
      context.log('FMP_API_KEY not set — updated timestamp only');
      return;
    }

    // Try to retrieve sector performance or similar metrics
    const sectorUrl = `${FMP_API}/sectors_perfomance?apikey=${apiKey}`; // fallback name — may not exist
    let res = await fetch(`${FMP_API}/sector_performance?apikey=${apiKey}`, { timeout: 20000 }).catch(() => null);
    let body = res ? await res.json().catch(() => null) : null;
    if (!body) {
      res = await fetch(`${FMP_API}/sectors-performance?apikey=${apiKey}`).catch(() => null);
      body = res ? await res.json().catch(() => null) : null;
    }

    // As a robust fallback, attempt per-sector key-metrics aggregation
    const sectorsToCheck = ['Technology','Energy','Financials','S&P500'];
    const computed = { fetchedAt: new Date().toISOString(), raw: body || null };
    for (const s of sectorsToCheck) {
      try {
        // FMP doesn't always expose a straightforward sector 10yr PE endpoint; attempt a search by sector companies
        // We'll attempt an approximation by calling /stock-screener for the sector and averaging forwardPE from profiles
        const screener = `${FMP_API}/stock-screener?sector=${encodeURIComponent(s)}&limit=30&apikey=${apiKey}`;
        const r = await fetch(screener, { timeout: 20000 }).catch(() => null);
        const list = r && r.ok ? await r.json().catch(()=>[]) : [];
        const peVals = [];
        if (Array.isArray(list) && list.length) {
          for (const item of list.slice(0,30)) {
            const profUrl = `${FMP_API}/profile/${encodeURIComponent(item.symbol)}?apikey=${apiKey}`;
            try {
              const rp = await fetch(profUrl, { timeout: 10000 });
              if (!rp.ok) continue;
              const p = await rp.json();
              const v = (p && Array.isArray(p) && p[0] && (p[0].pe || p[0].forwardPE)) ? (p[0].forwardPE ?? p[0].pe) : null;
              if (v != null) peVals.push(Number(v));
            } catch (e) {}
          }
        }
        const avg = peVals.length ? peVals.reduce((a,b)=>a+b,0)/peVals.length : null;
        if (!computed[s]) computed[s] = {};
        if (avg != null) computed[s].histForwardPE = Number(avg.toFixed(2));
      } catch (e) {
        // ignore per-sector failures
      }
    }

    await fs.mkdir('./data', { recursive: true });
    await fs.writeFile(OUT_PATH, JSON.stringify({ ...existing, ...computed }, null, 2), 'utf8');
    context.log('Wrote sector averages to', OUT_PATH);
  } catch (err) {
    context.log('sectorAggregator error:', err.message || err);
  }
}
