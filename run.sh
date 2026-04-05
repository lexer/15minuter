#!/usr/bin/env bash
# Run the autonomous trading agent with its built-in polling loop.
# Logs to a daily agent_YYYY-MM-DD.log and runs in the background.
set -euo pipefail

cd "$(dirname "$0")"

LOG="agent_$(date -u +%Y-%m-%d).log"

echo "[run.sh] Starting agent at $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"
node dist/index.js >> "$LOG" 2>&1 &
echo $! > agent.pid
echo "[run.sh] Agent PID $(cat agent.pid) — tail -f $LOG to monitor"
