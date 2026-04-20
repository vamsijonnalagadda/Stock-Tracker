#!/usr/bin/env python3
import json
import time
from pathlib import Path

import yfinance as yf

ROOT = Path(__file__).resolve().parents[1]
NEXT_PATH = ROOT / 'data' / 'earnings_next.json'

def safe_float(v):
    try:
        return float(v)
    except Exception:
        return None

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
        pre_close = safe_float(hist['Close'].iloc[pre_idx])
        post_close = safe_float(hist['Close'].iloc[post_idx])
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

def main():
    nxt = json.loads(NEXT_PATH.read_text())
    rows = [r for day in nxt.get('days', {}).values() for r in day]
    symbols = []
    for r in rows:
        sym = str(r.get('symbol') or '').upper()
        if not sym:
            continue
        if r.get('avgLast4EarningsMove') in (None, '') or r.get('lastEarningsMove') in (None, ''):
            symbols.append(sym)

    symbols = list(dict.fromkeys(symbols))
    print(f"Need backfill for {len(symbols)} symbols")

    updated = 0
    for i, sym in enumerate(symbols, 1):
        print(f"[{i}/{len(symbols)}] {sym}", flush=True)
        res = compute_moves_for_symbol(sym)
        if res:
            for day_rows in nxt.get('days', {}).values():
                for row in day_rows:
                    if str(row.get('symbol') or '').upper() == sym:
                        if row.get('avgLast4EarningsMove') in (None, '') and res.get('avg4Move') is not None:
                            row['avgLast4EarningsMove'] = res['avg4Move']
                            updated += 1
                        if row.get('lastEarningsMove') in (None, '') and res.get('lastMove') is not None:
                            row['lastEarningsMove'] = res['lastMove']
                            updated += 1
        time.sleep(0.6)

    if updated > 0:
        NEXT_PATH.write_text(json.dumps(nxt, indent=2))

    print(f"done updated_fields={updated}")

if __name__ == '__main__':
    main()
