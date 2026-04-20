#!/usr/bin/env python3
import json
import time
import urllib.request
import urllib.parse
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
NEXT_PATH = ROOT / 'data' / 'earnings_next.json'
WEEK_PATH = ROOT / 'data' / 'earnings_week.json'
MOVES_PATH = ROOT / 'data' / 'earnings_moves.json'
API_NEXT_URL = 'http://localhost:4000/api/earnings/next-week'
API_SET_NEXT = 'http://localhost:4000/internal/set-next-week'
YAHOO_QUOTE_SUMMARY = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary'

def load_json(p):
    try:
        return json.loads(Path(p).read_text())
    except Exception:
        return None

def yf_shortname(sym):
    try:
        url = f"{YAHOO_QUOTE_SUMMARY}?formatted=false&modules=price&symbol={urllib.parse.quote(sym)}"
        req = urllib.request.Request(url, headers={ 'User-Agent': 'python-urllib/3' })
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.load(r)
        short = None
        if isinstance(data, dict):
            short = data.get('quoteSummary', {}).get('result', [{}])[0].get('price', {}).get('shortName')
        return short
    except Exception:
        return None

def sanitize(name, fallback=None):
    if not name:
        return fallback
    s = str(name)
    s = re.sub(r"\b(inc\.?|corp\.?|corporation|company|co\.?|limited|ltd\.?|plc|holdings?)\b", '', s, flags=re.I)
    s = re.sub(r'\s+', ' ', s).strip()
    return s or fallback

def main():
    next_data = load_json(NEXT_PATH) or {}
    # If file empty, fetch from API
    if not next_data or not isinstance(next_data.get('days'), dict):
        try:
            with urllib.request.urlopen(API_NEXT_URL, timeout=20) as r:
                next_data = json.load(r)
        except Exception as e:
            print('failed fetching next-week API:', e)
            return

    moves = load_json(MOVES_PATH) or {}
    week = load_json(WEEK_PATH) or {}
    week_map = { (r.get('symbol') or '').upper(): r for day in week.get('days', {}).values() for r in day }

    days = next_data.get('days', {})
    updated = 0
    name_updates = 0
    move_updates = 0

    symbols_to_query = []
    for day_rows in days.values():
        for row in day_rows:
            sym = (row.get('symbol') or '').upper()
            if not sym:
                continue

            # Merge moves if missing
            if row.get('avgLast4EarningsMove') in (None, '') or row.get('lastEarningsMove') in (None, ''):
                m = moves.get(sym) or {}
                last = m.get('lastMove') if isinstance(m.get('lastMove'), (int,float)) or m.get('lastMove') is not None else None
                avg4 = m.get('avg4Move') if isinstance(m.get('avg4Move'), (int,float)) or m.get('avg4Move') is not None else None
                if avg4 is None and 'avg4Move' in m:
                    avg4 = m.get('avg4Move')
                if last is None and 'lastMove' in m:
                    last = m.get('lastMove')
                if avg4 is not None and (row.get('avgLast4EarningsMove') in (None,'')):
                    row['avgLast4EarningsMove'] = avg4
                    move_updates += 1
                    updated += 1
                if last is not None and (row.get('lastEarningsMove') in (None,'')):
                    row['lastEarningsMove'] = last
                    move_updates += 1
                    updated += 1

            # Merge companyName from week if available and target is missing or equals symbol
            cur = row.get('companyName')
            if not cur or str(cur).strip().upper() == sym:
                w = week_map.get(sym)
                if w and w.get('companyName') and str(w.get('companyName')).strip().upper() != sym:
                    row['companyName'] = w.get('companyName')
                    name_updates += 1
                    updated += 1
                else:
                    # schedule for Yahoo lookup
                    symbols_to_query.append(sym)

    # Deduplicate symbol queries
    symbols_to_query = list(dict.fromkeys(symbols_to_query))
    # Query Yahoo for remaining symbols in small batches
    for i, sym in enumerate(symbols_to_query, 1):
        if i % 40 == 0:
            time.sleep(1.2)
        else:
            time.sleep(0.2)
        name = yf_shortname(sym)
        name = sanitize(name, fallback=sym)
        applied = 0
        for day_rows in days.values():
            for row in day_rows:
                if (row.get('symbol') or '').upper() == sym:
                    cur = row.get('companyName')
                    if not cur or str(cur).strip().upper() == sym:
                        row['companyName'] = name
                        applied += 1
                        updated += 1
        if applied:
            name_updates += applied

    out = {
        'updatedAt': next_data.get('updatedAt') or int(time.time() * 1000),
        'weekStart': next_data.get('weekStart'),
        'days': days
    }

    try:
        NEXT_PATH.write_text(json.dumps(out, indent=2))
        print('wrote', NEXT_PATH)
    except Exception as e:
        print('failed writing next file', e)

    # POST to internal endpoint
    try:
        req = urllib.request.Request(API_SET_NEXT, data=json.dumps(out).encode('utf8'), headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = r.read().decode('utf8')
            print('server response:', resp)
    except Exception as e:
        print('failed posting to server internal endpoint:', e)

    print('total_updated=', updated, 'name_updates=', name_updates, 'move_updates=', move_updates)

if __name__ == '__main__':
    main()
