#!/usr/bin/env python3
"""Merge local data/earnings_next.json into server next-week payload without overwriting existing non-empty fields, then POST merged payload to internal endpoint."""
import json
import time
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / 'data' / 'earnings_next.json'
SERVER_URL = 'http://localhost:4000/api/earnings/next-week'
SET_URL = 'http://localhost:4000/internal/set-next-week'


def load_server():
    try:
        with urllib.request.urlopen(SERVER_URL, timeout=10) as r:
            return json.load(r)
    except Exception:
        return {'days': {}}


def main():
    if not LOCAL.exists():
        print('local missing', LOCAL)
        return 1
    local = json.loads(LOCAL.read_text())
    server = load_server()

    updated = 0
    for date, local_rows in (local.get('days') or {}).items():
        srv_rows = server.setdefault('days', {}).setdefault(date, [])
        for l in local_rows:
            sym = (l.get('symbol') or '').upper()
            match = None
            for r in srv_rows:
                if (r.get('symbol') or '').upper() == sym and r.get('hour') == l.get('hour'):
                    match = r
                    break
            if match is None:
                for r in srv_rows:
                    if (r.get('symbol') or '').upper() == sym:
                        match = r
                        break
            if match is None:
                srv_rows.append(l)
                updated += 1
                continue
            for fld in ('companyName', 'avgLast4EarningsMove', 'lastEarningsMove'):
                s_val = match.get(fld)
                l_val = l.get(fld)
                if (s_val in (None, '') ) and (l_val not in (None, '')):
                    match[fld] = l_val
                    updated += 1

    server['updatedAt'] = int(time.time() * 1000)
    merged = json.dumps(server, indent=2).encode('utf8')
    req = urllib.request.Request(SET_URL, data=merged, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            resp = r.read().decode('utf8')
            print('post_resp:', resp)
    except Exception as e:
        print('post_failed', e)
        return 1

    print('merged_updates=', updated)
    # report counts
    rows = [r for day in server.get('days', {}).values() for r in day]
    print('rows', len(rows))
    print('companyName_nonempty', sum(1 for r in rows if r.get('companyName') and str(r.get('companyName')).strip()))
    print('avg_nonnull', sum(1 for r in rows if r.get('avgLast4EarningsMove') not in (None, '')))
    print('last_nonnull', sum(1 for r in rows if r.get('lastEarningsMove') not in (None, '')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
