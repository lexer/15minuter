#!/usr/bin/env bash
# Run the autonomous trading agent with its built-in 30-second loop.
# Logs to agent.log and runs in the background.
set -euo pipefail

cd "$(dirname "$0")"

LOG=agent.log

echo "[run.sh] Starting agent at $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"
node dist/index.js >> "$LOG" 2>&1 &
echo $! > agent.pid
echo "[run.sh] Agent PID $(cat agent.pid) — tail -f $LOG to monitor"
