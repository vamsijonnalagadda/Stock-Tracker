#!/usr/bin/env python3
"""Lightweight yfinance HTTP microservice used by the Node.js stock-tracker server.

Runs on port 4001. Node calls: GET http://localhost:4001/quote/<TICKER>
Returns JSON with price, forwardPE, and other fundamentals.
"""

import json
import sys
import warnings
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import unquote

warnings.filterwarnings("ignore")

try:
    import yfinance as yf
except ImportError:
    print("ERROR: yfinance not installed. Run: pip3 install yfinance", file=sys.stderr)
    sys.exit(1)


def _safe_number(value):
    try:
        if value is None:
            return None
        num = float(value)
        return None if num != num else num  # NaN check
    except Exception:
        return None


def _first_series_value(series):
    """Return first non-null numeric value from a pandas Series-like object."""
    try:
        values = series.tolist() if hasattr(series, "tolist") else list(series)
        for v in values:
            n = _safe_number(v)
            if n is not None:
                return n
    except Exception:
        return None
    return None


def _extract_from_statement(statement, labels):
    """Extract first available metric from a DataFrame-like statement by row labels."""
    if statement is None:
        return None
    try:
        if getattr(statement, "empty", False):
            return None
        index = getattr(statement, "index", [])
        index_map = {str(k).lower(): k for k in index}
        for label in labels:
            key = index_map.get(label.lower())
            if key is None:
                continue
            row = statement.loc[key]
            value = _first_series_value(row)
            if value is not None:
                return value
    except Exception:
        return None
    return None


def _fill_missing_from_statements(ticker_obj, result):
    """Fill missing FCF/OCF/EBITDA/Revenue using yfinance statement tables."""
    table_names = [
        "cashflow",
        "quarterly_cashflow",
        "financials",
        "quarterly_financials",
        "income_stmt",
        "quarterly_income_stmt",
    ]

    statements = {}
    for name in table_names:
        try:
            statements[name] = getattr(ticker_obj, name)
        except Exception:
            statements[name] = None

    if result.get("operatingCashflow") is None:
        result["operatingCashflow"] = (
            _extract_from_statement(statements.get("cashflow"), ["Operating Cash Flow", "Total Cash From Operating Activities"])
            or _extract_from_statement(statements.get("quarterly_cashflow"), ["Operating Cash Flow", "Total Cash From Operating Activities"])
        )

    if result.get("freeCashflow") is None:
        result["freeCashflow"] = (
            _extract_from_statement(statements.get("cashflow"), ["Free Cash Flow"])
            or _extract_from_statement(statements.get("quarterly_cashflow"), ["Free Cash Flow"])
        )

    if result.get("ebitda") is None:
        result["ebitda"] = (
            _extract_from_statement(statements.get("financials"), ["EBITDA"])
            or _extract_from_statement(statements.get("quarterly_financials"), ["EBITDA"])
        )

    if result.get("totalRevenue") is None:
        result["totalRevenue"] = (
            _extract_from_statement(statements.get("income_stmt"), ["Total Revenue", "TotalRevenue"])
            or _extract_from_statement(statements.get("quarterly_income_stmt"), ["Total Revenue", "TotalRevenue"])
            or _extract_from_statement(statements.get("financials"), ["Total Revenue", "TotalRevenue"])
            or _extract_from_statement(statements.get("quarterly_financials"), ["Total Revenue", "TotalRevenue"])
        )


class QuoteHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress default request logging
        pass

    def _send_json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Expect path: /quote/<TICKER>
        parts = self.path.strip("/").split("/")
        if len(parts) != 2 or parts[0] != "quote":
            self._send_json(404, {"error": "Use /quote/<TICKER>"})
            return

        ticker = unquote(parts[1]).upper()
        try:
            ticker_obj = yf.Ticker(ticker)
            info = ticker_obj.info

            # currentPrice is intraday; regularMarketPrice is last close during off-hours
            price = info.get("currentPrice") or info.get("regularMarketPrice")

            result = {
                "symbol": ticker,
                "shortName": info.get("shortName") or info.get("longName") or ticker,
                "currency": info.get("currency", "USD"),
                "regularMarketPrice": price,
                "regularMarketPreviousClose": info.get("regularMarketPreviousClose") or info.get("previousClose"),
                "forwardPE": info.get("forwardPE"),
                "pegRatio": info.get("pegRatio"),
                "marketCap": info.get("marketCap"),
                "enterpriseValue": info.get("enterpriseValue"),
                "ebitda": info.get("ebitda"),
                "totalRevenue": info.get("totalRevenue"),
                "targetMeanPrice": info.get("targetMeanPrice"),
                "freeCashflow": info.get("freeCashflow"),
                "operatingCashflow": info.get("operatingCashflow"),
                "debtToEquity": info.get("debtToEquity"),
                "quoteSource": "yfinance (Yahoo Finance)"
            }

            # yfinance info is often sparse for some symbols; backfill from statement tables.
            _fill_missing_from_statements(ticker_obj, result)

            if price is None and result["forwardPE"] is None:
                self._send_json(404, {"error": f"No data returned for {ticker}"})
                return

            self._send_json(200, result)
        except Exception as e:
            self._send_json(500, {"error": str(e)})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4001
    server = HTTPServer(("127.0.0.1", port), QuoteHandler)
    print(f"yfinance service running on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
