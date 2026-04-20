#!/usr/bin/env python3
import json
import urllib.request
import urllib.parse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = ROOT / 'data' / 'earnings_next.json'
API_NEXT_URL = 'http://localhost:4000/api/earnings/next-week'
YAHOO_QUOTE_SUMMARY = 'https://query2.finance.yahoo.com/v10/finance/quoteSummary'

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

def main(symbols):
    try:
        with urllib.request.urlopen(API_NEXT_URL, timeout=15) as r:
            data = json.load(r)
    except Exception as e:
        print('failed fetching next-week API:', e)
        return

    days = data.get('days', {})
    updated = 0
    for sym in symbols:
        name = yf_shortname(sym) or sym
        for day_rows in days.values():
            for row in day_rows:
                if (row.get('symbol') or '').upper() == sym:
                    cur = row.get('companyName')
                    if not cur or str(cur).strip().upper() == sym:
                        row['companyName'] = name
                        updated += 1

    out = {'updatedAt': data.get('updatedAt') or None, 'weekStart': data.get('weekStart'), 'days': days}
    try:
        OUT_PATH.write_text(json.dumps(out, indent=2))
        print('wrote', OUT_PATH)
    except Exception as e:
        print('failed writing file:', e)
    print('updated_fields=', updated)

if __name__ == '__main__':
    syms = [s.upper() for s in (sys.argv[1:] or ['AAPL','MSFT','AMZN'])]
    main(syms)
