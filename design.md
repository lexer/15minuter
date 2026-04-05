# Design Document — bballer Autonomous Trading Agent

## Overview

`bballer` is an autonomous TypeScript agent that trades professional basketball game-winner markets on Kalshi prediction markets. It runs a 30-second polling loop, identifies high-confidence live games in their fourth quarter, and enters/exits YES positions based on win probability thresholds.

---

## Architecture

```
src/
  api/
    KalshiClient.ts     — RSA-PSS authenticated HTTP client for Kalshi API
    types.ts            — All Kalshi API request/response types
  services/
    MarketService.ts    — Discovers and parses basketball game-winner markets
    OrderService.ts     — Places and cancels limit orders
    PortfolioService.ts — Reads balance and open positions
  strategy/
    TradingStrategy.ts  — Entry/exit signal logic; PnL calculation
  storage/
    TradeHistory.ts     — Persists trade records to trade_history.json
  agent/
    TradingAgent.ts     — Main polling loop; orchestrates all components
  index.ts              — Entry point; wires up dependencies
```

---

## Key Design Decisions

### 1. RSA-PSS Authentication
Kalshi's trade API requires RSA-PSS signatures on every authenticated request. The message is `{timestamp_ms}{METHOD}{/trade-api/v2/path}` (no query string in signed path). The `KALSHI_API_KEY` environment variable holds the key UUID; the RSA private key lives in `private_key.pem` (never committed).

### 2. Price Representation
Kalshi prices are integers in the range 0-100 (cents). All internal price values are normalized to 0.0-1.0 floats immediately upon parsing to keep business logic clean.

### 3. Win Probability Estimation
Win probability is estimated as the mid-price of the YES side bid/ask spread: `(yes_bid + yes_ask) / 2`. This is the market's consensus probability and directionally accurate for the strategy thresholds (90% entry, 80% exit). More sophisticated estimation can incorporate order book depth or recent trade momentum.

### 4. Market Discovery
Basketball game-winner markets are discovered by:
1. Iterating known series tickers (`KXNBA`, `NBA`)
2. Scanning open events for basketball keywords in title/series

Filtering logic rejects prop markets (points, rebounds, quarter results, etc.) and accepts only markets with "win"/"winner" in title/ticker/rules.

### 5. Trading Strategy
- **Entry**: Only when `winProbability > 90%` and market is open
- **Exit**: When `winProbability ≤ 80%` or market closes
- **Position sizing**: Min of `MAX_CONTRACTS_PER_TRADE` (10) and what the balance can cover up to `MAX_COST_PER_TRADE` ($50)
- **Budget guard**: Agent halts entirely if balance reaches zero

### 6. Persistence
Trades are persisted to `trade_history.json` (excluded from git). On restart the agent reloads history for PnL tracking and analysis.

### 7. Dependency Injection
All services accept their dependencies through the constructor. This enables unit testing with mock clients without network calls, while the real API test suite uses the live Kalshi API to verify authentication and response shapes.

---

## Trade Lifecycle

```
scan markets → evaluate entry signal
  ↓ (prob > 90%)
place limit buy (YES) at ask price
  ↓
store TradeRecord (open)
  ↓
every 30s: re-fetch market
  ↓ (prob ≤ 80% OR closed)
place limit sell (YES) at bid price
  ↓
update TradeRecord with exit + PnL
```

---

## Future Improvements

- Incorporate Kalshi Live Data API (WebSocket) for intra-second price updates
- Implement quarter detection (currently relies on market status; could parse event title)
- Add confidence scoring based on order book depth
- Adaptive position sizing based on probability strength
- Strategy backtesting against completed game history
