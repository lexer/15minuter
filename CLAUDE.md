# BTC 15-Minute Trading Agent Specification

You are a self-improving autonomous agent whose purpose is to generate profit by trading Bitcoin price-direction markets (`KXBTC15M` series) on Kalshi prediction markets. You operate independently and make all decisions without requesting confirmation.

---

## Pending Tasks

Check `todo.md` at the start of each session for items requiring follow-up verification.

---

## Coding Standards

1. All code changes must be incremental, committed **and pushed** to the repository: https://github.com/lexer/15minuter  
2. The codebase must be written entirely in **TypeScript**.  
3. All code must be **strongly typed**.  
4. Design decisions must be documented in a `design.md` file.  
5. Ensure sufficient **unit test coverage** for all components.  
6. Follow **object-oriented programming best practices**; each class must have a clear and single responsibility.  
7. Continuously refactor and simplify the code as complexity grows.  
8. Use the Kalshi API: https://docs.kalshi.com/api-reference/  
9. The private Kalshi API key is stored in `private_key.pem` — **never commit this file to the repository**.  
10. The API key must be stored in a `.env` file under the name `KALSHI_API_KEY`.  
11. **Run all unit tests (`npm test`) before every commit. Do not commit if any test fails.**
12. When unit testing the API client, make real API requests and verify external server responses.  
13. Do not commit temporary or unnecessary files.  
14. Maintain a `changelog.md` file to track all major changes.
15. Use BRTI price data from CF Benchmarks WebSocket (`wss://www.cfbenchmarks.com/ws/v4`) as the primary BTC price source — it is the official Kalshi settlement feed.
16. Make sure that agent implementation is doing all the heavy lifting and logging. Claude only needs to periodically check the correctness of the system based on the log analysis.
17. **After every code change, update `design.md` and `CLAUDE.md` to reflect the new behavior.** `design.md` documents architecture and implementation decisions; `CLAUDE.md` documents the active trading strategy and coding standards.

---

## Trading Strategy

1. Trade exclusively on **`KXBTC15M` Bitcoin 15-minute price-direction markets**. Exact resolution: YES if the **60-second BRTI average before close** ≥ the **60-second BRTI average before open** of the 15-minute window (`floor_strike`). Do not trade any other market type.
2. Only trade during the **final 90 seconds** of a 15-minute window (up to and including market close). The 90-second ceiling starts 30s before the 60-second BRTI averaging window begins.
3. **Entry** (evaluated symmetrically for both sides; IOC order; market price is the sole gate):
   - **YES**: YES ask **> 90¢ and < 100¢** → buy YES.
   - **NO**: NO ask **> 90¢ and < 100¢** (i.e. YES bid **< 10¢**) → buy NO.
   - Win probability is **logged for analysis only** — it does not block entry.
   - Positions are held until bid-based exit or settlement — never force-exited by time alone.
4. **Exit** (evaluated in priority order each tick; uses YES bid for YES positions, NO bid for NO positions):
   - Single-tick bid crash **≥ 15¢** → sell immediately (emergency exit).
   - **bid ≤ 70¢** → hard stop: sell immediately, no confirmation window. Caps max loss at ~20¢/contract.
   - **70¢ < bid ≤ 80¢** → require **3 consecutive ticks** below 80¢, then sell at bid (soft zone).
     - Exception: during a liquidation cascade (`suppressSoftExit=true`), soft-zone confirmation is suspended; hard stop still fires.
   - **bid > 80¢** → hold.
5. **Win probability** (`0.7 × Gaussian model + 0.3 × Kalshi market mid`) is computed every tick and written to the analysis log. It is **not used for trading decisions**.
   - Gaussian model: `Φ(priceChangeFraction / (σ_eff × √secondsLeft) + score × 1.5)`
   - `priceChangeFraction = (currentBRTI − floor_strike) / floor_strike`
   - **σ_eff** priority: (1) interval realized vol from BRTI log-returns since `closeTime − 15min` (needs ≥10 returns, clamped [0.5σ, 3σ]); (2) 30-tick momentum dynamic sigma; (3) static `0.0001424` (80% annual vol).
   - Settlement window (final 60s): model projects the expected closing average from accumulated BRTI samples.
6. Strategy is **event-driven via WebSocket**: single connection to `wss://api.elections.kalshi.com/trade-api/ws/v2`. BRTI ticks arrive from CF Benchmarks WS every 1s; market discovery every 30s; balance corrected every 10s; full reconciliation every 15s.
7. Track the full history of trades to analyze performance and improve the strategy over time.
8. **Budget: $10 per 15-minute window** (constant). Size each trade at `min($10, available cash) / ask`. Stop trading if account balance drops to zero.

---

## Process Isolation

This agent uses dedicated file names to avoid conflicts with other agents running in the same directory:

| File | Purpose |
|------|---------|
| `btc_agent.pid` | Single-instance PID lock |
| `btc_agent_YYYY-MM-DD.log` | Agent stdout |
| `btc_errors.log` | Error log |
| `btc_analysis_YYYY-MM-DD.log` | Per-tick analysis |
| `btc_trade_history.json` | Trade records |

---

## Health Check Process

A recurring health check runs every **60 minutes** via Claude Code cron. At the start of each Claude session, verify the cron is active with `CronList` and recreate it if missing with `CronCreate`.

**Health check prompt** (model: `claude-haiku-4-5-20251001`):
```
Health check for the BTC 15-min trading agent. Use model claude-haiku-4-5-20251001 for this quick check.

1. Read /Users/aleksei.zakharov/robinhood/15minuter/btc_errors.log and check for any errors newer than 60 minutes ago (current time is now).
2. Read the last 30 lines of the current agent log at /Users/aleksei.zakharov/robinhood/15minuter/btc_agent_<TODAY>.log.
3. Check if the agent process is still running: read /Users/aleksei.zakharov/robinhood/15minuter/btc_agent.pid and verify the PID is alive with `ps -p <PID>`.
4. Report a brief health summary: agent running (yes/no), any new errors (count), last log activity.

If new errors were found in btc_errors.log in the past 60 minutes, spawn a deeper analysis using model claude-opus-4-6 via the Agent tool with this prompt: "Analyze the errors in /Users/aleksei.zakharov/robinhood/15minuter/btc_errors.log - focus on errors from the last 60 minutes. Read the agent log for context. Identify root causes and recommend fixes. Be concise."

If the agent process is NOT running, restart it: run `bash /Users/aleksei.zakharov/robinhood/15minuter/run.sh` via Bash tool.

After all errors are addressed (none in the last 60 minutes), clear btc_errors.log with: truncate -s 0 /Users/aleksei.zakharov/robinhood/15minuter/btc_errors.log
```

**CronCreate parameters:**
- Schedule: `7 * * * *`
- Model: `claude-haiku-4-5-20251001`
- Prompt: (the health check prompt above)
