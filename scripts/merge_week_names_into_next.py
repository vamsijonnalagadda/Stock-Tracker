#!/usr/bin/env python3
import json
import urllib.request
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEEK_PATH = ROOT / 'data' / 'earnings_week.json'
OUT_PATH = ROOT / 'data' / 'earnings_next.json'
API_NEXT_URL = 'http://localhost:4000/api/earnings/next-week'
API_SET_NEXT = 'http://localhost:4000/internal/set-next-week'

def load_week_map():
    try:
        data = json.loads(WEEK_PATH.read_text())
        rows = [r for day in data.get('days', {}).values() for r in day]
        return { (r.get('symbol') or '').upper(): r for r in rows }
    except Exception:
        return {}

def fetch_next():
    with urllib.request.urlopen(API_NEXT_URL, timeout=20) as r:
        return json.load(r)

def post_next(payload):
    req = urllib.request.Request(API_SET_NEXT, data=json.dumps(payload).encode('utf8'),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode('utf8')

def main():
    week_map = load_week_map()
    try:
        data = fetch_next()
    except Exception as e:
        print('failed fetching next-week API:', e)
        return

    days = data.get('days', {})
    updated = 0
    for day_rows in days.values():
        for row in day_rows:
            sym = (row.get('symbol') or '').upper()
            if not sym:
                continue
            cur = row.get('companyName')
            if cur and str(cur).strip() and str(cur).strip().upper() != sym:
                continue
            w = week_map.get(sym)
            if w:
                wname = w.get('companyName')
                if wname and str(wname).strip() and str(wname).strip().upper() != sym:
                    row['companyName'] = wname
                    updated += 1

    out = {
        'updatedAt': data.get('updatedAt') or None,
        'weekStart': data.get('weekStart'),
        'days': days
    }
    try:
        OUT_PATH.write_text(json.dumps(out, indent=2))
        print('wrote', OUT_PATH)
    except Exception as e:
        print('failed writing next file:', e)

    try:
        resp = post_next(out)
        print('server response:', resp)
    except Exception as e:
        print('failed posting to server:', e)

    print('updated_fields=', updated)

if __name__ == '__main__':
    main()
