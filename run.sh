#!/usr/bin/env bash
# Run the BTC 15-minute trading agent.
# Uses btc_agent.pid and btc_agent_YYYY-MM-DD.log to avoid conflicts with other agents.
set -euo pipefail

cd "$(dirname "$0")"

LOG="btc_agent_$(date -u +%Y-%m-%d).log"

echo "[run.sh] Starting BTC agent at $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"
node dist/index.js >> "$LOG" 2>&1 &
echo $! > btc_agent.pid
echo "[run.sh] BTC Agent PID $(cat btc_agent.pid) — tail -f $LOG to monitor"
