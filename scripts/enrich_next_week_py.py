#!/usr/bin/env python3
import json
import time
import urllib.request
import urllib.parse
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / 'data' / 'earnings_next.json'
API_NEXT_URL = 'http://localhost:4000/api/earnings/next-week'
API_SET_NEXT = 'http://localhost:4000/internal/set-next-week'
YAHOO_QUOTE_SUMMARY = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary'

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


def main():
    try:
        with urllib.request.urlopen(API_NEXT_URL, timeout=20) as r:
            data = json.load(r)
    except Exception as e:
        print('Failed fetching next-week API:', e)
        return

    days = data.get('days', {})
    rows = [r for day in days.values() for r in day]
    need = [r for r in rows if not r.get('companyName') or str(r.get('companyName')).strip().upper() == str(r.get('symbol') or '').strip().upper()]
    symbols = list(dict.fromkeys([str(r.get('symbol') or '').upper() for r in need if r.get('symbol')]))
    print(f"symbols needing enrichment: {len(symbols)}")

    updated = 0
    examples = []
    for i, sym in enumerate(symbols, 1):
        name = yf_shortname(sym)
        name = sanitize(name, fallback=sym)
        applied = 0
        for day_rows in days.values():
            for row in day_rows:
                if str(row.get('symbol') or '').upper() == sym:
                    if not row.get('companyName') or str(row.get('companyName')).strip().upper() == sym:
                        row['companyName'] = name
                        updated += 1
                        applied += 1
        if applied and len(examples) < 10:
            examples.append((sym, name))
        if i % 40 == 0:
            time.sleep(1.2)
        else:
            time.sleep(0.2)

    out = {
        'updatedAt': data.get('updatedAt') or int(time.time() * 1000),
        'weekStart': data.get('weekStart'),
        'days': days
    }
    try:
        OUT_PATH.write_text(json.dumps(out, indent=2))
        print('wrote', OUT_PATH)
    except Exception as e:
        print('failed writing out file', e)

    try:
        req = urllib.request.Request(API_SET_NEXT, data=json.dumps(out).encode('utf8'), headers={'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(req, timeout=20) as r:
            resp = r.read()
            print('server response:', resp.decode('utf8'))
    except Exception as e:
        print('failed posting to server internal endpoint:', e)

    print('updated_fields=', updated)
    print('examples=', examples[:10])

if __name__ == '__main__':
    main()
