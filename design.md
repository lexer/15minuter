# Design Document — BTC 15-Minute Trading Agent

## Overview

Autonomous TypeScript agent that trades `KXBTC15M` Bitcoin price-direction markets on Kalshi. Each market is a 15-minute binary: YES resolves to $1 if BTC closes the window above its open price, NO if below. The agent enters late in the window (final 1–5 minutes) when the outcome is highly probable but unexpired upside remains.

Process isolation: all files use the `btc_` prefix (`btc_agent.pid`, `btc_agent_YYYY-MM-DD.log`, `btc_errors.log`, `btc_trade_history.json`) so the agent can run alongside other Kalshi agents in the same directory.

---

## Architecture

```
src/
  api/
    KalshiClient.ts        — RSA-PSS authenticated HTTP client for Kalshi REST API
    KalshiWebSocket.ts     — Multiplexed WS (ticker + fill + market_positions); 45s watchdog
    types.ts               — Kalshi API types
  services/
    BtcPriceMonitor.ts     — Polls Binance for BTC/USDT 15-min candle + spot price (5s TTL)
    BtcProbabilityModel.ts — Gaussian model: P(BTC stays above window open | change%, time left)
    MarketService.ts       — Discovers KXBTC15M markets; computes blended probability; cache
    OrderService.ts        — Places limit orders (IOC)
    PortfolioService.ts    — Balance and open positions
  strategy/
    TradingStrategy.ts     — Entry/exit signals; $10/window budget sizing
  storage/
    TradeHistory.ts        — Persists trade records to btc_trade_history.json
    AnalysisLogger.ts      — Per-tick JSON-lines analysis log (btc_analysis_YYYY-MM-DD.log)
  agent/
    TradingAgent.ts        — Event-driven orchestrator: WS events + periodic loops
  index.ts                 — Entry point; PID lock (btc_agent.pid); log redirection
```

---

## Key Design Decisions

### 1. RSA-PSS Authentication
Kalshi requires RSA-PSS signatures. Message: `{timestamp_ms}{METHOD}{/trade-api/v2/path}`. `KALSHI_API_KEY` holds the key UUID; private key in `private_key.pem` (never committed). Same scheme for WebSocket upgrade headers.

### 2. WebSocket Watchdog
45-second inactivity watchdog resets on every inbound frame. If Kalshi's 10s heartbeat misses ~4 beats, the socket is terminated and reconnected with fresh auth. Avoids false positives from asymmetric network latency.

### 3. BTC Price Data — Binance
`BtcPriceMonitor` polls two public Binance endpoints every 5 seconds (no API key needed):
- `GET /api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1` → current 15-min candle open price
- `GET /api/v3/ticker/price?symbol=BTCUSDT` → latest spot price

Binance 15-min candles align with Kalshi's `KXBTC15M` windows. The candle open price is the reference: if the current price is above the open, the YES market resolves $1.

### 4. BTC Probability Model — Gaussian Random Walk
```
priceChangeFraction = (currentPrice − windowOpenPrice) / windowOpenPrice
σ(T) = SIGMA_PER_SQRT_SECOND × √T          (T = seconds remaining)
z    = priceChangeFraction / σ(T)
prob = Φ(z)                                  (standard normal CDF)
```

`SIGMA_PER_SQRT_SECOND = 0.0001424` calibrated from BTC annual volatility ≈ 80%:
`σ_per_√second = 0.80 / √(365 × 24 × 3600) ≈ 0.0001424`

Example: BTC up 0.5% with 120s left → σ(120) ≈ 0.00156 → z ≈ 3.21 → prob ≈ 99.9%.

### 5. Blended Win Probability
```
winProbability = 0.3 × marketMid + 0.7 × btcGaussianModel
```
Market mid captures order-book information (institutional participants, funding rate effects) that the pure price-change model misses.

### 6. Trading Window — Entry and Market Discovery
Only trade in the final **60–300 seconds** of each 15-minute window:
- Below 60s: too close to expiry, spread widens and liquidity dries up
- Above 300s: too much time left, uncertainty too high even at >90¢ ask

`isInTradingWindow = secondsLeft ∈ [60, 300]` is computed from `market.closeTime - Date.now()`.

### 7. Entry Criteria
1. Market must be `active` or `open`
2. `isInTradingWindow = true`
3. YES ask **> 90¢**
4. Size: `min($10 window budget, available cash) / ask` contracts

No confirmation window. IOC order semantics: a momentary ask spike with no real liquidity results in an unfilled order, not a bad fill.

### 8. Exit Criteria (evaluated in priority order each tick)
1. Single-tick bid crash ≥ 15¢ → emergency exit (overrides probability guard)
2. **bid ≤ 70¢ → hard stop: sell immediately, no guard, no confirmation**
3. 70¢ < bid ≤ 80¢ AND prob ≥ 85% → hold (probability guard)
4. 70¢ < bid ≤ 80¢ AND prob < 85% → require 3 consecutive ticks, then sell
5. bid > 80¢ → hold

Worst-case loss per contract: entry at >90¢, hard stop at 70¢ = ~20¢.

Also exits open positions that fall outside the trading window (e.g., a position entered with 90s left is still managed for exit when secondsLeft < 60 or market settles).

### 9. Position Sizing — Window Budget
Budget = **$10 per 15-minute window** (constant, not derived from account balance).
```
maxSpendCents = min(WINDOW_BUDGET_CENTS = 1000, availableBalanceCents)
contracts     = floor(maxSpendCents / askCents)
```
Top-up logic: if a partially-filled entry is below the window budget target, additional contracts are bought on subsequent ticks while still in the entry window and ask is above threshold.

### 10. Process Isolation
All runtime files use the `btc_` prefix to avoid collisions with other agents:

| File | Purpose |
|------|---------|
| `btc_agent.pid` | Single-instance lock |
| `btc_agent_YYYY-MM-DD.log` | Agent stdout (PST-dated) |
| `btc_errors.log` | Errors (transient network errors excluded) |
| `btc_analysis_YYYY-MM-DD.log` | Per-tick JSON-lines analysis log |
| `btc_trade_history.json` | All trade records |

### 11. Logging
The analysis log (`btc_analysis_YYYY-MM-DD.log`) writes one JSON-lines entry per 5s tick including:
- BTC state: `currentPrice`, `windowOpenPrice`, `priceChangePct`
- Market snapshots: `ticker`, `winProbability`, `ask`, `bid`, `secondsLeft`
- Entry/exit decisions with fill status and order ID
- Open positions with unrealized PnL
- Summary: `totalTrades`, `realizedPnl`, `unrealizedPnl`, `winRate`

---

## Trade Lifecycle

```
[on start]
  REST: getAllLiveBtcMarkets() + getBalance() in parallel
  WS:   connect to wss://api.elections.kalshi.com/trade-api/ws/v2
  WS:   subscribe fill, market_positions, all discovered tickers

[on WS ticker message]
  applyTickerUpdate() → recompute secondsLeft + blended prob
  if open position OR isInTradingWindow: handleMarket()

[every 5s — btcStateLoop]
  Binance: refreshBtcStates()
  for each trading-window market: handleMarket()
  for each open position outside window: handleMarket() (exit only)
  write btc_analysis tick

[every 30s — marketDiscoveryLoop]
  REST: discoverMarkets() → WS subscribe/unsubscribe

[every 10s — balanceRefreshLoop]
  REST: getBalance() to correct WS-optimistic drift

[every 15s — reconcileLoop]
  REST: getPortfolio() + getOpenOrders()
  adopt external positions; detect external closes

[on WS fill]     optimistically adjust cachedBalanceCents; correct fill price in TradeHistory
[on WS position] detect real-time position close; mark trade closed
```

---

## Fill Price Correction
WS fill messages arrive before or after the REST order response. The `fillAccumulator` map accumulates fills by `orderId`; `orderTradeMap` maps `orderId` to `tradeId`. Once accumulated fills match the expected contract count, the trade record is corrected from the submitted limit price to the actual weighted-average execution price.
