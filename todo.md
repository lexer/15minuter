# Todo

## Pending Verification

### [2026-04-12] Verify WS watchdog behavior in prod
- Check `agent_2026-04-12.log` for any `[WS] Watchdog timeout` lines
- Confirm no false reconnects (watchdog should only fire if Kalshi's 10s heartbeat misses ~4 beats)
- Confirm no `[WS] Reconnecting` lines during normal game-night operation
- If reconnects are too frequent, consider increasing `WATCHDOG_MS` beyond 45s
- Reference: design.md §2 "WebSocket Keep-Alive (Watchdog)"
