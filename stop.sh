#!/bin/bash
# Stop MNR API server + tunnel
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ -f server.pid ]; then
  kill $(cat server.pid) 2>/dev/null && echo "Server stopped" || echo "Server already stopped"
  rm server.pid
fi

if [ -f tunnel.pid ]; then
  kill $(cat tunnel.pid) 2>/dev/null && echo "Tunnel stopped" || echo "Tunnel already stopped"
  rm tunnel.pid
fi
