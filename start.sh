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
NODE_VER=$(node -v 2>/dev/null || true)
if [ -z "$NODE_VER" ]; then
  echo "ERROR: node not found in PATH. Require Node 22+ to run server."
  exit 1
fi
MAJOR=$(echo "$NODE_VER" | sed 's/^v//' | awk -F. '{print $1}')
if [ "$MAJOR" -lt 22 ]; then
  echo "ERROR: Node version $NODE_VER detected. Server requires Node 22 or higher."
  exit 1
fi
exec node server.js
