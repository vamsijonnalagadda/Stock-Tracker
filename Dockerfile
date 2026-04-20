# Single container: Node.js (API + static frontend) + Python (yfinance microservice)
FROM node:22-bullseye-slim

# Install Python, pip, and curl for the startup readiness check
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv curl \
    chromium fonts-liberation \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install Node dependencies
COPY package.json ./
RUN npm install --omit=dev

# Install Python dependencies
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy source
COPY . .

COPY start.sh ./
RUN chmod +x start.sh

EXPOSE 4000

CMD ["./start.sh"]
