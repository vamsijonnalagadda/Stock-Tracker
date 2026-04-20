#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EM_PATH = ROOT / 'data' / 'earnings_moves.json'
EW_PATH = ROOT / 'data' / 'earnings_week.json'

def load_json(p):
    try:
        return json.loads(p.read_text())
    except Exception as e:
        print(f"Failed reading {p}: {e}")
        raise

def main():
    em = load_json(EM_PATH)
    ew = load_json(EW_PATH)

    moves_map = {k.upper(): v for k, v in (em.items() if isinstance(em, dict) else [])}

    rows_total = 0
    updated_avg = 0
    updated_last = 0

    days = ew.get('days', {})
    for date_iso, rows in days.items():
        if not isinstance(rows, list):
            continue
        for row in rows:
            rows_total += 1
            sym = str(row.get('symbol') or '').upper()
            if not sym:
                continue
            mv = moves_map.get(sym)
            if not mv:
                continue
            # avg4Move -> avgLast4EarningsMove
            if (row.get('avgLast4EarningsMove') in (None, '') and mv.get('avg4Move') is not None):
                try:
                    row['avgLast4EarningsMove'] = float(mv.get('avg4Move'))
                    updated_avg += 1
                except Exception:
                    pass
            # lastMove -> lastEarningsMove
            if (row.get('lastEarningsMove') in (None, '') and mv.get('lastMove') is not None):
                try:
                    row['lastEarningsMove'] = float(mv.get('lastMove'))
                    updated_last += 1
                except Exception:
                    pass

    if updated_avg + updated_last > 0:
        EW_PATH.write_text(json.dumps(ew, indent=2))

    print(f"rows_total={rows_total} updated_avg={updated_avg} updated_last={updated_last}")

if __name__ == '__main__':
    main()
