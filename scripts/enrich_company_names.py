#!/usr/bin/env python3
import json
import re
import time
from pathlib import Path
import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
EW_PATH = ROOT / 'data' / 'earnings_week.json'

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

def main():
    ew = json.loads(EW_PATH.read_text())
    days = ew.get('days', {})
    rows = [r for day in days.values() for r in day]
    # symbols needing enrichment: companyName equal to symbol or falsy
    need = [r for r in rows if not r.get('companyName') or str(r.get('companyName')).strip().upper() == str(r.get('symbol') or '').strip().upper()]
    symbols = list(dict.fromkeys([str(r.get('symbol') or '').upper() for r in need if r.get('symbol')]))
    print(f"symbols needing enrichment: {len(symbols)}")

    updated = 0
    examples = []
    for i, sym in enumerate(symbols, 1):
        try:
            t = yf.Ticker(sym)
            info = getattr(t, 'info', {}) or {}
            name = info.get('shortName') or info.get('longName')
            name = sanitize(name, fallback=sym)
        except Exception:
            name = sym
        # apply to all rows with this symbol
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

    if updated:
        EW_PATH.write_text(json.dumps(ew, indent=2))

    print(f"updated_fields={updated}")
    print('examples:', examples[:10])

if __name__ == '__main__':
    main()
