# Design Document — bballer Autonomous Trading Agent

## Overview

`bballer` is an autonomous TypeScript agent that trades professional basketball game-winner markets on Kalshi prediction markets. It runs a 1-second polling loop, identifies live NBA games in their fourth quarter, and enters/exits YES positions based on a blended win probability model.

---

## Architecture

```
src/
  api/
    KalshiClient.ts        — RSA-PSS authenticated HTTP client for Kalshi REST API
    KalshiWebSocket.ts     — Single multiplexed WS connection (ticker + fill + market_positions)
    types.ts               — All Kalshi API request/response types
  services/
    MarketService.ts       — Discovers and parses basketball game-winner markets; computes blended win probability; maintains in-memory market cache updated by WS
    GameMonitor.ts         — Polls NBA Live Data CDN for scores, clocks, and timeouts
    WinProbabilityModel.ts — Gaussian random-walk win probability (Clauset 2015) with timeout adjustment
    OrderService.ts        — Places limit orders (IOC)
    PortfolioService.ts    — Reads balance and open positions
  strategy/
    TradingStrategy.ts     — Entry/exit signal logic; Kelly position sizing
  storage/
    TradeHistory.ts        — Persists trade records to trade_history.json
    AnalysisLogger.ts      — Writes per-tick JSON-lines analysis log (PST-dated)
  agent/
    TradingAgent.ts        — Event-driven agent; orchestrates all components via WS events + setInterval loops
  index.ts                 — Entry point; wires dependencies; redirects stdout to PST-dated agent log
```

---

## Key Design Decisions

### 1. RSA-PSS Authentication
Kalshi's trade API requires RSA-PSS signatures on every authenticated request. The message is `{timestamp_ms}{METHOD}{/trade-api/v2/path}` (no query string in signed path). `KALSHI_API_KEY` holds the key UUID; the private key lives in `private_key.pem` (never committed).

The same RSA-PSS scheme applies to WebSocket connections: sign `{timestamp_ms}GET/trade-api/ws/v2` and pass the three headers (`KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-SIGNATURE`, `KALSHI-ACCESS-TIMESTAMP`) in the WebSocket upgrade request.

### 2. WebSocket Keep-Alive (Watchdog)
Kalshi sends a WebSocket `ping` frame with body `"heartbeat"` every 10 seconds. The `ws` library automatically responds with a `pong` frame (RFC 6455). We do not send our own outgoing pings.

Instead, a 45-second inactivity watchdog is reset on every inbound frame (both `message` and `ping` events). If nothing arrives for 45 seconds — meaning Kalshi's heartbeat missed ~4 consecutive beats — the socket is terminated and reconnected with fresh auth headers. This avoids false-positive reconnects from asymmetric network conditions that plagued the earlier outgoing-ping approach.

### 3. Price Representation
Kalshi prices are integers 0–100 (cents). All internal prices are normalized to 0.0–1.0 floats immediately on parsing.

### 4. Win Probability — Blended Model
Win probability combines a Gaussian random-walk model with the Kalshi market mid-price:

```
winProbability = 0.7 × Gaussian(scoreDiff, secondsLeft, timeouts)
              + 0.3 × (kalshiBid + kalshiAsk) / 2
```

The Gaussian model (Clauset 2015): `Φ(scoreDiff / (0.22 × √secondsLeft))` models each possession as a random step. In the final 2 minutes, the trailing team's extra timeouts add 14s of effective game time per timeout advantage (timeout adjustment).

The 70/30 blend was calibrated via backtest on 2026-04-06 game data: it exits losing positions ~2 minutes earlier than the pure model with no false exits on winning positions.

### 5. Entry Criteria
1. Market must be `active` or `open`
2. Game state available from NBA Live Data
3. ≤ 600 seconds remaining (final 10 minutes only)
4. YES ask **> 90¢** — buy immediately on the first qualifying tick
5. Size: `25% × startingDailyBudget`, capped at available cash

No confirmation window: IOC order semantics make it redundant — a momentary ask spike with no real liquidity simply results in an unfilled order, not a bad fill. Removing the window eliminates 2s of latency and the need for a price-drift guard.

### 6. Exit Criteria

Checks are evaluated in priority order on every tick:

1. Market inactive/closed → sell immediately at bid
2. Single-tick bid crash ≥ 15¢ → sell immediately (emergency exit, overrides probability guard)
3. **bid ≤ 70¢ → hard stop: sell immediately, no probability guard, no confirmation window**
4. 70¢ < bid ≤ 80¢ AND blended winProbability ≥ 85% → hold (probability guard blocks soft exit)
5. 70¢ < bid ≤ 80¢ AND blended winProbability < 85% → require **3 consecutive ticks**, then sell at bid
6. bid > 80¢ → hold

The hard stop caps the worst-case loss on a single trade at ~20¢/contract (entry >90¢, hard stop at 70¢). The probability guard only applies in the 70–80¢ soft zone, preventing premature exits while the model still shows high confidence.

### 7. Position Sizing
Size is `min(25% × startingDailyBudget, availableCash)`. The budget is fixed at the cash balance recorded at agent startup each day and does not change as positions are opened or settled. This prevents the compounding over-leverage that occurred on 2026-04-10 when using `cash + open positions` as the base, which allowed 6 concurrent positions to push total exposure to 3.4× the starting balance.

The Kelly fraction is computed to confirm positive edge exists before entry, but sizing uses the flat 25% fraction regardless of Kelly magnitude.

If a buy order is rejected with `insufficient_balance`, `cachedBalanceCents` is immediately zeroed so subsequent ticks skip entry rather than retrying every second.

### 8. Market Discovery
Basketball game-winner markets are discovered via the `KXNBAGAME` series ticker. Each event ticker encodes date and team codes (e.g. `KXNBAGAME-26APR06HOUGSW`). Team codes are mapped from Kalshi 3-letter codes to NBA tricodes via a static lookup table.

### 9. NBA Live Data
Game state (score, clock, period, timeouts) is fetched from the NBA CDN every 5 seconds:
- Scoreboard: `https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json`
- Boxscore per game: `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_{gameId}.json`

Timeout counts are used to adjust effective seconds remaining in the final 2 minutes.

### 10. Logging
Two PST-dated log files are written per game day:

| File | Format | Content |
|------|--------|---------|
| `agent_YYYY-MM-DD.log` | Plain text | All console output; PST date captured at process startup |
| `analysis_YYYY-MM-DD.log` | JSON-lines | Per-tick structured data: games, markets, signals, decisions, open positions, summary |

Both use **PST (America/Los_Angeles)** timezone for date grouping — one file per NBA game day. The analysis log rolls over at PST midnight each tick; the agent log uses the PST date at startup.

Analysis log compaction rules:
- Only games with `gameStatus === 2` (live) are included
- `decisions` array omitted when empty; hold-type decisions never logged (redundant with `signal` in market snapshots)
- `openPositions` array omitted when empty
- Signal/reason fields skipped on blowout markets (ask ≤ 10¢ or ≥ 99¢)
- Win probability rounded to 4 decimal places; PnL to 2dp

### PnL Tracking
`TradeHistory` tracks `realizedPnl` (closed trades only). Each game-state tick also computes `unrealizedPnl` for open positions using the current `yesBid` price as the liquidation value: `Σ (yesBid − entryPrice) × contracts`. Both values are logged to the agent console and included in the analysis log tick summary as `realizedPnl`, `unrealizedPnl`, and `totalPnl`.

### 11. Dependency Injection
All services accept dependencies through the constructor for unit-testable components. The live API integration test suite makes real Kalshi API requests to verify authentication and response shapes.

---

## Trade Lifecycle

```
[on start]
REST: getAllLiveBasketballMarkets() + getBalance() in parallel
WS: connect to wss://api.elections.kalshi.com/trade-api/ws/v2
WS: subscribe to fill, market_positions, and all discovered tickers

[on WS ticker message]  ← real-time bid/ask, no polling latency
  applyTickerUpdate() → recompute blended win prob
  if Q4 market: handleMarket()
    open position? → managePosition() (exit check + top-up)
    no position?   → scanEntry()

[every 5s — gameStateLoop]
  REST: refreshGameStates() (NBA CDN)
  for each Q4 market: handleMarket()
  write analysis tick to analysis_YYYY-MM-DD.log

[every 30s — marketDiscoveryLoop]
  REST: discoverMarkets() → WS subscribe/unsubscribe new/removed tickers

[every 10s — balanceRefreshLoop]
  REST: getBalance() to correct WS-optimistic drift

[every 15s — reconcileLoop]
  REST: getPortfolio() + getOpenOrders()
  adopt external positions; detect external closes

[on WS fill message]
  optimistically adjust cachedBalanceCents

[on WS market_position message]
  log position update
```

---

## Persistence

| File | Purpose |
|------|---------|
| `trade_history.json` | All trade records with entry/exit prices, PnL, timestamps |
| `analysis_YYYY-MM-DD.log` | Per-tick market snapshots for post-game analysis |
| `agent_YYYY-MM-DD.log` | Full agent console output |

`trade_history.json` and `*.log` files are excluded from git.

## Tools

`scripts/backtest_blend.py` — Simulates exit logic against a saved analysis log for a set of known trades, sweeping blend weights. Used to calibrate the 70/30 model/market blend. Edit `TRADES` and `LOG_FILE` constants to run against new game data.
