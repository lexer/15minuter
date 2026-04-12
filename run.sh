#!/usr/bin/env bash
# Run the BTC 15-minute trading agent.
# Kills any previously running instance before starting a fresh one.
set -euo pipefail

cd "$(dirname "$0")"

# ── Stop old instance ─────────────────────────────────────────────────────────
if [ -f btc_agent.pid ]; then
  OLD_PID=$(cat btc_agent.pid)
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[run.sh] Stopping old agent (PID $OLD_PID)..."
    kill "$OLD_PID"
    # Wait up to 5s for clean shutdown
    for i in $(seq 1 10); do
      kill -0 "$OLD_PID" 2>/dev/null || break
      sleep 0.5
    done
    # Force kill if still alive
    kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f btc_agent.pid
fi

# ── Start new instance ────────────────────────────────────────────────────────
LOG="btc_agent_$(date -u +%Y-%m-%d).log"

echo "[run.sh] Starting BTC agent at $(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "$LOG"
node dist/index.js >> "$LOG" 2>&1 &
echo $! > btc_agent.pid
echo "[run.sh] BTC Agent PID $(cat btc_agent.pid) — tail -f $LOG to monitor"
