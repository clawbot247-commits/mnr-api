#!/bin/bash
pkill -f "mnr-api/server.js" 2>/dev/null
sleep 1
cd /data/.openclaw/workspace/mnr-api
API_KEY=$(grep ANTHROPIC_API_KEY .env | cut -d= -f2-)
ANTHROPIC_API_KEY="$API_KEY" PORT=3001 nohup node server.js >> server.log 2>&1 &
echo $! > server.pid
echo "Started MNR API, PID=$(cat server.pid)"
sleep 2
curl -s http://localhost:3001/health
