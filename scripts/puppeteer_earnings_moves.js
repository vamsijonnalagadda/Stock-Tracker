#!/usr/bin/env node
import fs from 'fs/promises';
import puppeteer from 'puppeteer';

function isoFromTimestamp(ts) {
  return new Date(Number(ts) * 1000).toISOString().slice(0, 10);
}

async function fetchYahooQuoteSummary(symbol, modules) {
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&corsDomain=finance.yahoo.com`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`yahoo summary HTTP ${res.status}`);
  const j = await res.json();
  return j?.quoteSummary?.result?.[0] || null;
}

async function fetchChartCloses(symbol, fromUnix, toUnix) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${fromUnix}&period2=${toUnix}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) return null;
  const j = await res.json();
  const timestamps = j?.chart?.result?.[0]?.timestamp || [];
  const closes = j?.chart?.result?.[0]?.indicators?.adjclose?.[0]?.adjclose || j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
  const map = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const d = isoFromTimestamp(timestamps[i]);
    const c = closes[i];
    if (c != null) map.set(d, Number(c));
  }
  return map;
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

async function scrapeEarningsDatesWithPuppeteer(symbol) {
  const url = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const raw = await page.evaluate(() => {
      try {
        const scripts = Array.from(document.querySelectorAll('script'));
        for (const s of scripts) {
          const t = s.textContent || '';
          if (t.includes('root.App.main')) return t;
        }
      } catch (e) {}
      return null;
    });
    if (!raw) return null;
    const m = raw.match(/root\.App\.main\s*=\s*(\{.*\})\s*;/s);
    if (!m) return null;
    const obj = JSON.parse(m[1]);
    const events = [];
    try {
      const es = obj?.context?.dispatcher?.stores?.QuoteSummaryStore?.earnings?.earningsChart?.quarterly || obj?.context?.dispatcher?.stores?.QuoteSummaryStore?.earnings?.history || null;
      if (Array.isArray(es)) {
        for (const e of es) {
          if (e?.date) events.push({ dateIso: e.date.slice(0,10), hour: e.hour || 'amc' });
        }
      }
    } catch (e) {}
    await page.close();
    return events.length ? events : null;
  } finally {
    await browser.close();
  }
}

async function computeMovesForSymbol(symbol) {
  try {
    const summary = await fetchYahooQuoteSummary(symbol, 'earningsHistory');
    const hist = summary?.earningsHistory?.history || summary?.earningsHistory?.earnings || null;
    let events = null;
    if (Array.isArray(hist) && hist.length) {
      events = hist.map((h) => ({ dateIso: String(h?.epsDate || h?.date || '').slice(0,10), hour: (h?.time || h?.hour || 'amc') }));
    }
    if (!events || !events.length) {
      events = await scrapeEarningsDatesWithPuppeteer(symbol);
    }
    if (!events || !events.length) return null;

    events = Array.from(new Set(events.map(e=>e.dateIso))).map(d=>({dateIso:d,hour:'amc'})).slice(0,6);
    const oldest = events[events.length-1].dateIso;
    const newest = events[0].dateIso;
    const fromUnix = Math.floor(new Date(oldest + 'T00:00:00Z').getTime()/1000) - 7*24*3600;
    const toUnix = Math.floor(new Date(newest + 'T00:00:00Z').getTime()/1000) + 7*24*3600;
    const candleByDate = await fetchChartCloses(symbol, fromUnix, toUnix);
    if (!candleByDate || candleByDate.size === 0) return null;
    const sortedDates = Array.from(candleByDate.keys()).sort();
    const moves = [];
    for (const ev of events) {
      const idx = sortedDates.indexOf(ev.dateIso);
      let preIdx = idx - 1;
      let postIdx = idx + 1;
      if (preIdx < 0) preIdx = 0;
      if (postIdx >= sortedDates.length) postIdx = sortedDates.length - 1;
      const pre = candleByDate.get(sortedDates[preIdx]);
      const post = candleByDate.get(sortedDates[postIdx]);
      if (!Number.isFinite(pre) || !Number.isFinite(post) || pre <= 0) continue;
      const mv = round2(((post - pre) / pre) * 100);
      moves.push(mv);
      if (moves.length >= 4) break;
    }
    if (!moves.length) return null;
    return { lastMove: moves[0], avg4Move: round2(moves.reduce((s,v)=>s+Math.abs(v),0)/moves.length), moves };
  } catch (e) {
    return null;
  }
}

async function main() {
  const p = 'data/earnings_next.json';
  const raw = await fs.readFile(p, 'utf8');
  const d = JSON.parse(raw);
  const rows = [];
  Object.values(d.days || {}).forEach(arr => arr.forEach(r => rows.push(r)));
  const arg = (process.argv[2] || '').toUpperCase();
  const targets = arg ? [arg] : rows.filter(r => r.isSp500 && (r.avgLast4EarningsMove == null || r.lastEarningsMove == null)).map(r=>r.symbol).slice(0,300);
  console.log('targets', targets.length);
  let updated = 0;
  for (const sym of targets) {
    process.stdout.write(`.${sym}`);
    try {
      const moves = await computeMovesForSymbol(sym);
      if (moves && (Number.isFinite(moves.avg4Move) || Number.isFinite(moves.lastMove))) {
        for (const dateIso of Object.keys(d.days || {})) {
          d.days[dateIso] = d.days[dateIso].map(row => {
            if (String(row.symbol||'').toUpperCase() === sym) {
              const next = { ...row };
              if (next.avgLast4EarningsMove == null && Number.isFinite(moves.avg4Move)) next.avgLast4EarningsMove = moves.avg4Move;
              if (next.lastEarningsMove == null && Number.isFinite(moves.lastMove)) next.lastEarningsMove = moves.lastMove;
              if (next.avgLast4EarningsMove !== row.avgLast4EarningsMove || next.lastEarningsMove !== row.lastEarningsMove) updated += 1;
              return next;
            }
            return row;
          });
        }
        await fs.writeFile(p, JSON.stringify(d, null, 2), 'utf8');
      }
    } catch (e) {
      // continue
    }
    await new Promise(r=>setTimeout(r, 800));
  }
  console.log('\nupdated', updated);
}

if (require.main === module) main().catch(e=>{ console.error(e); process.exit(1); });
