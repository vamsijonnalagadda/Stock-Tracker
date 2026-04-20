#!/usr/bin/env python3
"""Backfill companyName, avgLast4EarningsMove, lastEarningsMove for S&P500 symbols in earnings_next.json

Runs inside the container where `yfinance` is available. Only fills missing fields
and never overwrites non-empty values.
"""
import json
import time
import urllib.request
import urllib.parse
from pathlib import Path
import re

import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
NEXT_PATH = ROOT / 'data' / 'earnings_next.json'
API_SET_NEXT = 'http://localhost:4000/internal/set-next-week'

SUFFIX_RE = re.compile(r"\b(inc\.?|corp\.?|corporation|company|co\.?|limited|ltd\.?|plc|holdings?)\b", flags=re.I)
YF_RE = re.compile(r"\bYahoo Finance\b", flags=re.I)

def sanitize(name, fallback=None):
    if not name:
        return fallback
    s = str(name)
    s = YF_RE.sub('', s)
    s = SUFFIX_RE.sub('', s)
    s = re.sub(r'[\s\.,:;\-\u00B7\u2013\u2014]+$', '', s)
    s = re.sub(r'^[\s\.,:;\-\u00B7\u2013\u2014]+', '', s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s or fallback


def compute_moves_for_symbol(sym, max_events=6):
    t = yf.Ticker(sym)
    try:
        edf = t.get_earnings_dates(max_events)
    except Exception:
        return None
    if edf is None or len(edf) == 0:
        return None

    hist = t.history(period='6y', interval='1d')
    if hist is None or hist.empty:
        return None
    try:
        hist.index = hist.index.tz_localize(None)
    except Exception:
        pass
    date_list = [d.strftime('%Y-%m-%d') for d in hist.index]

    moves = []
    for idx in list(edf.index)[:max_events]:
        try:
            ev_date = idx.strftime('%Y-%m-%d')
            hour = getattr(idx, 'hour', 12)
        except Exception:
            continue
        hour_code = 'amc' if (hour >= 16) else 'bmo'
        if ev_date in date_list:
            i = date_list.index(ev_date)
        else:
            i = next((j for j,d in enumerate(date_list) if d > ev_date), None)
            if i is None:
                continue
        pre_idx = i if hour_code != 'bmo' else i - 1
        post_idx = i + 1 if hour_code != 'bmo' else i
        if pre_idx < 0 or post_idx >= len(date_list):
            continue
        pre_close = None
        post_close = None
        try:
            pre_close = float(hist['Close'].iloc[pre_idx])
            post_close = float(hist['Close'].iloc[post_idx])
        except Exception:
            continue
        if pre_close is None or post_close is None or pre_close <= 0:
            continue
        mv = round(((post_close - pre_close) / pre_close) * 100, 2)
        moves.append(mv)
        if len(moves) >= 4:
            break

    if not moves:
        return None
    last = moves[0]
    avg4 = round(sum(abs(x) for x in moves) / len(moves), 2)
    return {'lastMove': last, 'avg4Move': avg4, 'moves': moves}


def yf_shortname(sym):
    try:
        t = yf.Ticker(sym)
        info = t.info if hasattr(t, 'info') else {}
        name = info.get('shortName') or info.get('longName')
        return name
    except Exception:
        return None


def main():
    nxt = json.loads(NEXT_PATH.read_text())
    days = nxt.get('days', {})
    rows = [r for day in days.values() for r in day]

    # Filter to S&P500 symbols only
    targets = []
    for r in rows:
        if not r.get('isSp500'):
            continue
        sym = str(r.get('symbol') or '').upper()
        if not sym:
            continue
        # only consider if any of the three fields are missing/blank
        need_name = (not r.get('companyName')) or (str(r.get('companyName')).strip().upper() == sym)
        need_avg = r.get('avgLast4EarningsMove') in (None, '')
        need_last = r.get('lastEarningsMove') in (None, '')
        if need_name or need_avg or need_last:
            targets.append(sym)

    targets = list(dict.fromkeys(targets))
    print(f"S&P500 backfill targets: {len(targets)}")

    updated = 0
    examples = []
    for i, sym in enumerate(targets, 1):
        print(f"[{i}/{len(targets)}] {sym}", flush=True)
        # Try to fill name if needed
        name = None
        for day_rows in days.values():
            for row in day_rows:
                if str(row.get('symbol') or '').upper() == sym:
                    if (not row.get('companyName')) or (str(row.get('companyName')).strip().upper() == sym):
                        name = yf_shortname(sym)
                        name = sanitize(name, fallback=sym)
                        if name and ((not row.get('companyName')) or (str(row.get('companyName')).strip().upper() == sym)):
                            row['companyName'] = name
                            updated += 1
        # Try to compute moves
        res = compute_moves_for_symbol(sym)
        if res:
            for day_rows in days.values():
                for row in day_rows:
                    if str(row.get('symbol') or '').upper() == sym:
                        if row.get('avgLast4EarningsMove') in (None, '') and res.get('avg4Move') is not None:
                            row['avgLast4EarningsMove'] = res['avg4Move']
                            updated += 1
                        if row.get('lastEarningsMove') in (None, '') and res.get('lastMove') is not None:
                            row['lastEarningsMove'] = res['lastMove']
                            updated += 1
        if i % 30 == 0:
            time.sleep(1.2)
        else:
            time.sleep(0.6)

    if updated > 0:
        out = {
            'updatedAt': int(time.time() * 1000),
            'weekStart': nxt.get('weekStart'),
            'days': days
        }
        NEXT_PATH.write_text(json.dumps(out, indent=2))
        print('wrote', NEXT_PATH)
        # POST to internal endpoint
        try:
            req = urllib.request.Request(API_SET_NEXT, data=json.dumps(out).encode('utf8'), headers={'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(req, timeout=20) as r:
                resp = r.read()
                print('server response:', resp.decode('utf8'))
        except Exception as e:
            print('failed posting to server internal endpoint:', e)

    print('updated_fields=', updated)


if __name__ == '__main__':
    main()
