import fetch from 'node-fetch';
import fs from 'fs/promises';

const FMP_API = process.env.FMP_API || 'https://financialmodelingprep.com/api/v3';
const OUT_PATH = './data/stock_historical.json';
const WATCHLIST_PATH = './data/stock_watchlist.json';

export default async function (context) {
  context.log('stockAggregator triggered');
  const apiKey = process.env.FMP_API_KEY;
  try {
    const watchlistRaw = await fs.readFile(WATCHLIST_PATH, 'utf8').catch(() => JSON.stringify(['AAPL','MSFT']));
    const watch = JSON.parse(watchlistRaw || '[]');
    const out = {};
    for (const ticker of watch) {
      try {
        if (!apiKey) {
          context.log('FMP_API_KEY not set — skipping remote fetch for', ticker);
          continue;
        }
        const url = `${FMP_API}/ratios/${encodeURIComponent(ticker)}?period=annual&limit=10&apikey=${apiKey}`;
        const r = await fetch(url, { timeout: 20000 });
        if (!r.ok) {
          let body = null;
          try { body = await r.text(); } catch (e) { body = String(e.message || e); }
          context.log('FMP ratios failed for', ticker, r.status, '-', body);
          // Try alternate method: income statement + historical prices to compute trailing averages
          try {
            // Fallback to local yfinance microservice trailing computation
            const yfUrl = `http://127.0.0.1:4001/trailing/${encodeURIComponent(ticker)}?years=5`;
            const yfR = await fetch(yfUrl, { timeout: 20000 });
            if (!yfR.ok) { const b = await yfR.text().catch(()=>null); context.log('yfinance trailing failed for', ticker, yfR.status, b); continue; }
            const jf = await yfR.json();
            const fetchedAt = new Date().toISOString();
            const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
            out[ticker] = {
              avg3: jf.avg3_pe ?? jf.avg3 ?? null,
              avg5: jf.avg5_pe ?? jf.avg5 ?? null,
              avg3_fcfYield: jf.avg3_fcfYield ?? null,
              avg3_evEbitda: jf.avg3_evEbitda ?? null,
              avg5_fcfMargin: jf.avg5_fcfMargin ?? null,
              avg5_evEbitda: jf.avg5_evEbitda ?? null,
              fetchedAt,
              expiresAt
            };
            context.log('Computed trailing via yfinance for', ticker, out[ticker]);
            continue;
          } catch (altErr) {
            context.log('Alternate trailing compute failed for', ticker, altErr.message || altErr);
            continue;
          }
        }
        let arr = null;
        try { arr = await r.json(); } catch (e) {
          let txt = null;
          try { txt = await r.text(); } catch (_) { txt = null; }
          context.log('FMP ratios parse failed for', ticker, e.message || e, 'body:', txt);
          continue;
        }
        if (!Array.isArray(arr) || arr.length === 0) { context.log('No ratios for', ticker); continue; }
        // Try to extract forwardPE or falling back to pe
        const peVals = arr.map(o => (o.forwardPE ?? o.pe ?? o.priceEarningsRatio ?? o.peTTM)).filter(v => v != null).map(Number);
        const last10 = peVals.slice(0,10);
        const last5 = peVals.slice(0,5);
        const avg = (a) => a.length ? a.reduce((s,x)=>s+x,0)/a.length : null;
        const fetchedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
        // Compute 3-year average (most recent 3 annual values)
        const last3 = last10.slice(0,3);
        out[ticker] = {
          avg3: avg(last3),
          avg5: avg(last5),
          fetchedAt,
          expiresAt
        };
        context.log('Computed historical for', ticker, out[ticker]);
      } catch (e) {
        context.log('Error fetching ratios for', ticker, e.message || e);
      }
    }
    await fs.mkdir('./data', { recursive: true });
    // Merge with existing file to preserve prior entries for tickers not in watchlist
    let existing = {};
    try { existing = JSON.parse(await fs.readFile(OUT_PATH, 'utf8')); } catch (e) {}
    // Merge with existing file to preserve prior entries for tickers not in watchlist
    // and overwrite/refresh entries for tickers we just computed.
    const merged = { ...existing, ...out };
    await fs.writeFile(OUT_PATH, JSON.stringify(merged, null, 2), 'utf8');
    context.log('Wrote', OUT_PATH);
  } catch (err) {
    context.log('stockAggregator error', err.message || err);
  }
}
