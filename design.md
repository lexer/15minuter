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
    BtcPriceMonitor.ts     — CF Benchmarks BRTI WebSocket (1s ticks); rolling 20-min price history
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

### 3. BTC Price Data — CF Benchmarks BRTI
`BtcPriceMonitor` connects to the CF Benchmarks BRTI WebSocket (`wss://www.cfbenchmarks.com/ws/v4`).
- BRTI (Bitcoin Real-Time Index) ticks every **1 second**, sourced from Coinbase, Bitstamp, Kraken, etc.
- KXBTC15M markets resolve on the **60-second simple average** of BRTI immediately before close vs the **60-second simple average** of BRTI immediately before the window opened (`floor_strike`).
- The monitor maintains a **rolling 20-minute price history** (cleared on disconnect) used by the probability model to compute realized interval volatility.
- Credentials (WS key ID + password) are scraped from the CF Benchmarks BRTI page and refreshed every 15 minutes.

### 4. BTC Probability Model — Gaussian Random Walk with Interval Realized Vol
```
Resolution: P(60s-avg-at-close ≥ floor_strike)   where floor_strike = 60s-avg-at-open
priceChangeFraction = (currentBRTI − floor_strike) / floor_strike
σ_eff = resolveSigma(intervalPrices, momentum)
z     = priceChangeFraction / (σ_eff × √secondsLeft) + score × 1.5
prob  = Φ(z)
```

**Sigma priority (per √second):**
1. **Interval realized vol** — std of log-returns from BRTI prices since `closeTime − 15min`. Requires ≥10 returns. Clamped to [0.5σ, 3σ] of static. Captures the volatility regime of the *specific current window*.
2. **Momentum dynamic sigma** — last-30-tick realized vol from `BtcMomentumIndicators`.
3. **Static sigma** — `0.0001424` from 80% annual BTC vol.

Example: BTC up 0.5% vs floor_strike, 60s left, low-vol interval (σ = 0.5×static) → z ≈ 9.0 → prob ≈ 100%.

**Settlement model** (final 60 seconds):
In the final 60s, BRTI samples are accumulated. The expected closing 60-second average is projected:
```
expectedAvg = (partialSum + secondsLeft × currentBRTI) / 60
σ_avg = σ_eff × secondsLeft × √(secondsLeft/3) / 60
z = (expectedAvg − floor_strike) / (floor_strike × σ_avg)
```
Confidence sharpens as more samples accumulate.

### 5. Blended Win Probability (analysis only)
```
winProbability = 0.3 × marketMid + 0.7 × btcGaussianModel
```
Computed every tick and written to the analysis log. **Not used for trading decisions** — entry and exit are gated solely on market ask/bid price levels. The model was removed from the decision path because momentum and market-mid blending produced inflated estimates (e.g. 91.9% from a +0.016% price lead), causing premature entries and blocking valid exits.

### 6. Trading Window — Entry and Market Discovery
Only trade in the final **5–90 seconds** of each 15-minute window:
- The 90-second ceiling starts 30 seconds before the 60-second BRTI averaging window begins, capturing early directional price information.
- The 5-second floor ensures an IOC order has time to execute before market close.

`isInTradingWindow = secondsLeft ∈ [5, 90]` is computed from `market.closeTime - Date.now()`.

### 7. Entry Criteria
Entry is evaluated symmetrically for YES and NO sides. Market ask price is the **sole gate** — model probability is logged but does not influence entry.

**YES entry** (bullish):
1. Market must be `active` or `open`; `isInTradingWindow = true`
2. YES ask **> 90¢ and < 100¢** (market-implied probability ≥ 90%)
3. Size: `min($10 window budget, available cash) / yesAsk` contracts

**NO entry** (bearish):
1. Market must be `active` or `open`; `isInTradingWindow = true`
2. NO ask **> 90¢ and < 100¢** (i.e. YES bid **< 10¢**; market prices NO at ≥ 90%)
3. Size: `min($10 window budget, available cash) / noAsk` contracts

No confirmation window. IOC order semantics: a momentary ask spike with no real liquidity results in an unfilled order, not a bad fill.

**NO bid/ask derivation**: WS ticker messages only carry YES prices. NO prices are derived on every tick:
```
noAsk = 1 − yesBid   (price to buy NO; counterparty sells NO = buys YES at yesBid)
noBid = 1 − yesAsk   (price to sell NO; counterparty buys NO = sells YES at yesAsk)
```
This ensures NO entry IOC orders use the current market price, not a stale REST-fetched value.

### 8. Exit Criteria (evaluated in priority order each tick)
Bid price is the sole gate — model probability is logged in reason strings but does not influence exit decisions.

1. Single-tick bid crash **≥ 15¢** → emergency exit (immediate sell)
2. **bid ≤ 70¢** → hard stop: sell immediately, no confirmation
3. **70¢ < bid ≤ 80¢** → soft zone: require **3 consecutive ticks**, then sell at bid
   - Exception: `suppressSoftExit=true` (liquidation cascade active) suspends soft-zone confirmation; hard stop still fires
4. **bid > 80¢** → hold

Worst-case loss per contract: entry at >90¢, hard stop at 70¢ = ~20¢.

Also exits open positions that fall outside the trading window (e.g., a position is still managed for exit after `secondsLeft < 5` or when the market settles).

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
- BTC state: `currentPrice`, market snapshots for all tracked markets
- Market snapshots: `ticker`, `targetPrice` (`floor_strike`), `sixtySecondsAvg`, `priceChangePct`, `winProbability`, `ask`, `bid`, `secondsLeft`, optional `signal`/`signalReason`
- `sixtySecondsAvg` is **always present** (not gated on settlement window):
  - Pre-settlement: `currentBRTI` (flat projection — outcome if BRTI stays constant)
  - Settlement window (final 60s): `(mean(samples) × elapsed + currentBRTI × secondsLeft) / 60`
- `priceChangePct` is always `(sixtySecondsAvg − targetPrice) / targetPrice × 100`
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
  BRTI: refreshBtcStates()
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
