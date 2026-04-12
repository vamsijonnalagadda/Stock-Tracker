#!/usr/bin/env bash
set -e

# Start yfinance microservice in the background
python3 /app/yfinance_service.py 4001 &

# Wait until the Python service is accepting connections
for i in $(seq 1 20); do
  if curl -sf http://127.0.0.1:4001/quote/AAPL > /dev/null 2>&1; then
    echo "yfinance service ready"
    break
  fi
  echo "Waiting for yfinance service... ($i)"
  sleep 1
done

# Start Node.js API server (foreground — keeps container alive)
exec node server.js
