#!/usr/bin/env python3
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NEXT = ROOT / 'data' / 'earnings_next.json'
MOVES = ROOT / 'data' / 'earnings_moves.json'

def main():
    nextd = json.loads(NEXT.read_text())
    moves = json.loads(MOVES.read_text())
    days = nextd.get('days', {})
    updated = 0
    for day_rows in days.values():
        for row in day_rows:
            sym = (row.get('symbol') or '').upper()
            if not sym:
                continue
            if not row.get('impliedMove') and moves.get(sym) and moves[sym].get('impliedMove'):
                row['impliedMove'] = moves[sym].get('impliedMove')
                updated += 1
    NEXT.write_text(json.dumps(nextd, indent=2))
    print('updated_implied=', updated)

if __name__ == '__main__':
    main()
