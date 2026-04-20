#!/usr/bin/env python3
"""More-aggressive backfill for S&P500: wider history, more events, tolerant date matching.

Non-destructive: only fills `avgLast4EarningsMove` and `lastEarningsMove` when missing.
Runs inside container where `yfinance` is available.
"""
import json
import time
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


def nearest_trade_indices(date_list, ev_date):
    # return indices (pre_idx, post_idx) around ev_date tolerating ±2 days
    from bisect import bisect_left
    i = bisect_left(date_list, ev_date)
    # consider window
    candidates = []
    for di in range(max(0, i-3), min(len(date_list), i+4)):
        candidates.append(di)
    # find nearest index <= ev_date for pre, and >= ev_date for post
    pre = None
    post = None
    for di in reversed(candidates):
        if date_list[di] <= ev_date:
            pre = di
            break
    for di in candidates:
        if date_list[di] >= ev_date:
            post = di
            break
    return pre, post


def compute_moves_for_symbol(sym, max_events=10):
    t = yf.Ticker(sym)
    try:
        edf = t.get_earnings_dates(max_events)
    except Exception:
        return None
    if edf is None or len(edf) == 0:
        return None

    hist = t.history(period='10y', interval='1d')
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

        pre_idx, post_idx = nearest_trade_indices(date_list, ev_date)
        if pre_idx is None or post_idx is None:
            continue
        # adjust pre/post according to bmo/amc assumptions
        if hour_code == 'bmo':
            # event before market: post should be same day or next trading day
            pre = pre_idx - 1 if pre_idx - 1 >= 0 else pre_idx
            post = pre_idx
        else:
            pre = pre_idx
            post = post_idx if post_idx < len(date_list) else pre_idx

        if pre < 0 or post >= len(date_list) or pre == post:
            continue

        try:
            pre_close = float(hist['Close'].iloc[pre])
            post_close = float(hist['Close'].iloc[post])
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
        need_avg = r.get('avgLast4EarningsMove') in (None, '')
        need_last = r.get('lastEarningsMove') in (None, '')
        if need_avg or need_last:
            targets.append(sym)

    targets = list(dict.fromkeys(targets))
    print(f"Aggressive S&P backfill targets: {len(targets)}")

    updated = 0
    for i, sym in enumerate(targets, 1):
        print(f"[{i}/{len(targets)}] {sym}", flush=True)
        res = compute_moves_for_symbol(sym, max_events=10)
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
            time.sleep(1.5)
        else:
            time.sleep(0.8)

    if updated > 0:
        out = {
            'updatedAt': int(time.time() * 1000),
            'weekStart': nxt.get('weekStart'),
            'days': days
        }
        NEXT_PATH.write_text(json.dumps(out, indent=2))
        print('wrote', NEXT_PATH)


if __name__ == '__main__':
    main()
