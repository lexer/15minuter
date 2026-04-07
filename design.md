# Design Document — bballer Autonomous Trading Agent

## Overview

`bballer` is an autonomous TypeScript agent that trades professional basketball game-winner markets on Kalshi prediction markets. It runs a 1-second polling loop, identifies live NBA games in their fourth quarter, and enters/exits YES positions based on a blended win probability model.

---

## Architecture

```
src/
  api/
    KalshiClient.ts        — RSA-PSS authenticated HTTP client for Kalshi API
    types.ts               — All Kalshi API request/response types
  services/
    MarketService.ts       — Discovers and parses basketball game-winner markets; computes blended win probability
    GameMonitor.ts         — Polls NBA Live Data CDN for scores, clocks, and timeouts
    WinProbabilityModel.ts — Gaussian random-walk win probability (Clauset 2015) with timeout adjustment
    OrderService.ts        — Places and cancels limit orders
    PortfolioService.ts    — Reads balance and open positions
  strategy/
    TradingStrategy.ts     — Entry/exit signal logic with confirmation windows; Kelly position sizing
  storage/
    TradeHistory.ts        — Persists trade records to trade_history.json
    AnalysisLogger.ts      — Writes per-tick JSON-lines analysis log (PST-dated)
  agent/
    TradingAgent.ts        — Main polling loop; orchestrates all components
  index.ts                 — Entry point; wires dependencies; redirects stdout to PST-dated agent log
```

---

## Key Design Decisions

### 1. RSA-PSS Authentication
Kalshi's trade API requires RSA-PSS signatures on every authenticated request. The message is `{timestamp_ms}{METHOD}{/trade-api/v2/path}` (no query string in signed path). `KALSHI_API_KEY` holds the key UUID; the private key lives in `private_key.pem` (never committed).

### 2. Price Representation
Kalshi prices are integers 0–100 (cents). All internal prices are normalized to 0.0–1.0 floats immediately on parsing.

### 3. Win Probability — Blended Model
Win probability combines a Gaussian random-walk model with the Kalshi market mid-price:

```
winProbability = 0.7 × Gaussian(scoreDiff, secondsLeft, timeouts)
              + 0.3 × (kalshiBid + kalshiAsk) / 2
```

The Gaussian model (Clauset 2015): `Φ(scoreDiff / (0.22 × √secondsLeft))` models each possession as a random step. In the final 2 minutes, the trailing team's extra timeouts add 14s of effective game time per timeout advantage (timeout adjustment).

The 70/30 blend was calibrated via backtest on 2026-04-06 game data: it exits losing positions ~2 minutes earlier than the pure model with no false exits on winning positions.

### 4. Entry Criteria
1. Market must be `active` or `open`
2. Game state available from NBA Live Data
3. ≤ 300 seconds remaining (final 5 minutes only)
4. YES ask > 89¢ for **3 consecutive ticks** (confirmation window)
5. On the 3rd tick: ask must be **> 90¢** (entry threshold)
6. Size: `25% × (cash + open position cost basis)`, capped at available cash

### 5. Exit Criteria
1. Market inactive/closed → sell immediately at bid
2. bid ≤ 80¢ AND blended winProbability ≥ 85% → hold (probability guard blocks exit)
3. bid ≤ 80¢ AND blended winProbability < 85% → require **3 consecutive ticks**, then sell at bid
4. bid > 80¢ → hold

### 6. Position Sizing
Size is `25% × totalFunds` where `totalFunds = cashBalance + openPositionCostBasis`, capped at available cash. This accounts for deployed capital when sizing new entries, preventing over-allocation when multiple positions are open simultaneously. The Kelly fraction is computed to confirm positive edge exists before entry, but sizing uses the flat 25% fraction regardless of Kelly magnitude.

### 7. Market Discovery
Basketball game-winner markets are discovered via the `KXNBAGAME` series ticker. Each event ticker encodes date and team codes (e.g. `KXNBAGAME-26APR06HOUGSW`). Team codes are mapped from Kalshi 3-letter codes to NBA tricodes via a static lookup table.

### 8. NBA Live Data
Game state (score, clock, period, timeouts) is fetched from the NBA CDN every 5 seconds:
- Scoreboard: `https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json`
- Boxscore per game: `https://cdn.nba.com/static/json/liveData/boxscore/boxscore_{gameId}.json`

Timeout counts are used to adjust effective seconds remaining in the final 2 minutes.

### 9. Logging
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

### 10. Dependency Injection
All services accept dependencies through the constructor for unit-testable components. The live API integration test suite makes real Kalshi API requests to verify authentication and response shapes.

---

## Trade Lifecycle

```
[every 1s]
fetch NBA game states (cached 5s) + Kalshi markets
  ↓
manage open positions:
  market settled?    → record settlement at 1.0 or 0.0
  market inactive?   → await settlement
  bid ≤ 80¢ + prob < 85% for 3 ticks → sell at bid
  ↓
scan Q4 markets for entries:
  ask > 89¢ for 3 ticks, ask > 90¢, ≤ 5 min left → buy at ask
  size = 25% × (cash + deployed), capped at cash
  ↓
write analysis tick to analysis_YYYY-MM-DD.log
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
