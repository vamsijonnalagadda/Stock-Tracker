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
        raw_path = self.path
        parts = raw_path.strip("/").split("/")
        if len(parts) < 2:
            self._send_json(404, {"error": "Use /quote/<TICKER> or /trailing/<TICKER>"})
            return

        route = parts[0]
        ticker = unquote(parts[1]).upper()

        # trailing endpoint: /trailing/<TICKER>?years=N
        if route == 'trailing':
            years = 5
            if '?' in raw_path:
                try:
                    qs = raw_path.split('?',1)[1]
                    for kv in qs.split('&'):
                        if '=' in kv:
                            k,v = kv.split('=',1)
                            if k == 'years': years = int(v)
                except Exception:
                    pass
            result_tr = self.do_GET_trailing(ticker, years=years)
            if result_tr is None or result_tr.get('error'):
                self._send_json(404, {"error": f"No trailing data for {ticker}", "details": result_tr})
                return
            self._send_json(200, result_tr)
            return

        if route != 'quote':
            self._send_json(404, {"error": "Use /quote/<TICKER> or /trailing/<TICKER>"})
            return

        try:
            ticker_obj = yf.Ticker(ticker)
            info = ticker_obj.info

            # currentPrice is intraday; regularMarketPrice is last close during off-hours
            price = info.get("currentPrice") or info.get("regularMarketPrice")

            # Try to extract PEG Ratio from multiple possible locations in info dict
            peg = None
            for key in ["pegRatio", "peg", "trailingPEG", "forwardPEG", "pegRatio2", "pegRatio3"]:
                if key in info:
                    peg = info.get(key)
                    if peg is not None:
                        break
            
            # If still not found, check if we can compute from P/E and earnings growth
            # (This is a rough estimate and may not match Yahoo's exact PEG)
            if peg is None:
                forward_pe = info.get("forwardPE")
                trailing_pe = info.get("trailingPE")
                if forward_pe and trailing_pe and forward_pe > 0 and trailing_pe > 0:
                    # Rough estimate: if trailing P/E > forward P/E, estimate growth
                    growth_estimate = ((trailing_pe - forward_pe) / forward_pe) * 100
                    if growth_estimate > 0:
                        peg = forward_pe / growth_estimate

            
            result = {
                "symbol": ticker,
                "shortName": info.get("shortName") or info.get("longName") or ticker,
                "currency": info.get("currency", "USD"),
                "quoteType": info.get("quoteType"),
                "marketState": info.get("marketState"),
                "regularMarketPrice": price,
                "regularMarketPreviousClose": info.get("regularMarketPreviousClose") or info.get("previousClose"),
                "postMarketPrice": info.get("postMarketPrice"),
                "postMarketChangePercent": info.get("postMarketChangePercent"),
                "preMarketPrice": info.get("preMarketPrice"),
                "preMarketChangePercent": info.get("preMarketChangePercent"),
                "forwardPE": info.get("forwardPE"),
                "pegRatio": peg,
                "dividendYield": info.get("dividendYield"),
                "trailingAnnualDividendYield": info.get("trailingAnnualDividendYield"),
                "forwardAnnualDividendYield": info.get("forwardAnnualDividendYield"),
                "marketCap": info.get("marketCap"),
                "enterpriseValue": info.get("enterpriseValue"),
                "ebitda": info.get("ebitda"),
                "totalRevenue": info.get("totalRevenue"),
                "targetMeanPrice": info.get("targetMeanPrice"),
                "freeCashflow": info.get("freeCashflow"),
                "operatingCashflow": info.get("operatingCashflow"),
                "debtToEquity": info.get("debtToEquity"),
                "fiftyTwoWeekHigh": info.get("fiftyTwoWeekHigh"),
                "fiftyTwoWeekLow": info.get("fiftyTwoWeekLow"),
                "earningsDate": info.get("earningsTimestamp"),
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

    def do_GET_trailing(self, ticker, years=5):
        try:
            ticker_obj = yf.Ticker(ticker)
            # historical prices (10y to be safe)
            hist = ticker_obj.history(period=f"{max(5, years+2)}y", interval='1d')
            if hist is None or hist.empty:
                return None
            # year-end close prices
            try:
                hist.index = hist.index.tz_localize(None)
            except Exception:
                pass
            year_ends = hist['Close'].resample('Y').last()

            # financial statements
            financials = None
            cashflow = None
            try:
                financials = ticker_obj.financials
            except Exception:
                financials = None
            try:
                cashflow = ticker_obj.cashflow
            except Exception:
                cashflow = None

            # helper to extract a metric value for a given column (year)
            def extract_from_df(df, labels, col):
                if df is None or col not in df.columns:
                    return None
                for label in labels:
                    if label in df.index:
                        v = df.at[label, col]
                        n = _safe_number(v)
                        if n is not None:
                            return n
                return None

            # build lists of per-year metrics
            years_list = list(year_ends.index.strftime('%Y'))
            pe_list = []
            fcf_margin_list = []
            ev_ebitda_list = []
            eps_labels = ['Basic EPS', 'Diluted EPS', 'EPS', 'Earnings Per Share', 'EPS (Basic)']
            fcf_labels = ['Free Cash Flow', 'FreeCashFlow', 'Free Cashflow']
            revenue_labels = ['Total Revenue', 'Revenue', 'Operating Revenue']
            ebitda_labels = ['EBITDA']

            # attempt to get marketCap from info
            info = ticker_obj.info if hasattr(ticker_obj, 'info') else {}
            marketCap_now = _safe_number(info.get('marketCap'))
            enterpriseValue_now = _safe_number(info.get('enterpriseValue'))

            for col in financials.columns if financials is not None else []:
                year = str(col)[:4]
                if year not in years_list:
                    continue
                # price for that year
                try:
                    price = float(year_ends[year_ends.index.strftime('%Y') == year].iloc[0])
                except Exception:
                    price = None
                eps = extract_from_df(financials, eps_labels, col)
                if eps is not None and price is not None and eps != 0:
                    pe_list.append(price / eps)
                # free cash flow margin (FCF / Revenue)
                fcf = extract_from_df(cashflow, fcf_labels, col)
                revenue = extract_from_df(financials, revenue_labels, col)
                if fcf is not None and revenue not in (None, 0):
                    fcf_margin_list.append(fcf / revenue)
                # ebitda
                ebitda = extract_from_df(financials, ebitda_labels, col)
                if ebitda is not None and enterpriseValue_now:
                    ev_ebitda_list.append(enterpriseValue_now / ebitda)

            def avg(a):
                return sum(a)/len(a) if a else None

            # most recent entries first
            pe_list_sorted = pe_list
            avg3_pe = avg(pe_list_sorted[:3])
            avg5_pe = avg(pe_list_sorted[:5])
            avg3_fcf_margin = avg(fcf_margin_list[:3])
            avg5_fcf_margin = avg(fcf_margin_list[:5])
            avg3_ev = avg(ev_ebitda_list[:3])
            avg5_ev = avg(ev_ebitda_list[:5])

            return {
                'avg3_pe': avg3_pe,
                'avg5_pe': avg5_pe,
                'avg3_fcfMargin': avg3_fcf_margin,
                'avg5_fcfMargin': avg5_fcf_margin,
                'avg3_evEbitda': avg3_ev,
                'avg5_evEbitda': avg5_ev
            }
        except Exception as e:
            return {'error': str(e)}

        


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4001
    server = HTTPServer(("127.0.0.1", port), QuoteHandler)
    print(f"yfinance service running on http://127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
