#!/bin/bash
# Start MNR API server + Cloudflare tunnel
# Usage: ./start.sh [ANTHROPIC_API_KEY]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Load .env if it exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Override from argument if provided
if [ -n "$1" ]; then
  export ANTHROPIC_API_KEY="$1"
fi

if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "ERROR: ANTHROPIC_API_KEY is not set"
  exit 1
fi

echo "Starting MNR API server..."
PORT=3001 nohup node server.js >> server.log 2>&1 &
echo $! > server.pid
echo "Server PID: $(cat server.pid)"

sleep 2

echo "Starting Cloudflare tunnel..."
nohup /data/bin/cloudflared tunnel --url http://localhost:3001 --no-autoupdate >> tunnel.log 2>&1 &
echo $! > tunnel.pid
echo "Tunnel PID: $(cat tunnel.pid)"

sleep 5

# Extract the tunnel URL from logs
TUNNEL_URL=$(grep -oP 'https://[a-z0-9\-]+\.trycloudflare\.com' tunnel.log | head -1)
echo ""
echo "======================================"
echo "MNR API is live at: $TUNNEL_URL"
echo "Health check: $TUNNEL_URL/health"
echo "OCR endpoint: $TUNNEL_URL/ocr-process"
echo "======================================"
echo ""
echo "Update VITE_OCR_API_URL in Lovable to: $TUNNEL_URL"
