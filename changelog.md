# Changelog

## [1.25.0] — 2026-04-10

### Changed
- **WebSocket integration**: replaced 1-second REST polling loop with event-driven architecture
  - `KalshiWebSocket` (new): single multiplexed connection to `wss://api.elections.kalshi.com/trade-api/ws/v2`; subscribes to `ticker`, `fill`, and `market_positions` channels. RSA-PSS auth headers on WS handshake (signs `{ts}GET/trade-api/ws/v2`). Exponential backoff reconnection (1s → 30s); resubscribes all tracked tickers on reconnect.
  - `MarketService`: added in-memory market cache; `applyTickerUpdate()` applies real-time WS bid/ask and recomputes blended win probability without a REST call; BTC price polled every 5s; `discoverMarkets()` handles REST-based market discovery.
  - `TradingAgent`: rewritten as event-driven. `onTicker()` triggers strategy evaluation on every bid/ask update; `onFill()` optimistically adjusts cached balance; `onMarketPosition()` logs live position changes. Periodic setInterval loops: BTC price refresh (5s), market discovery (30s), balance correction (10s), reconciliation (15s).
  - Removed `src/scripts/tick.ts` — obsolete single-shot script from old cron-based architecture.
  - Removed `tick` npm script from `package.json`.

## [1.24.0] — 2026-04-10

### Changed
- `TradingStrategy.evaluateEntry()`: removed 3-consecutive-tick confirmation window — agent now buys immediately on the first tick where ask > 90¢. IOC order semantics make the window redundant (a momentary spike with no liquidity just results in an unfilled order). Eliminates 2s of pre-entry latency.
- Removed `ENTRY_CONFIRMATION_TICKS`, `ENTRY_PRICE_DRIFT_TOLERANCE`, `highAskCounts`, `entryAskSnapshots`, and `clearEntryConfirmation()` — all dead code after this change.
- `TradingAgent`: removed `clearEntryConfirmation()` calls; cooldown after failed fill still applies.
- Tests: rewrote entry tests for single-tick semantics (76 passing, down from 80 — 4 confirmation-window tests removed).

## [1.23.0] — 2026-04-10

### Changed
- `MarketService.getAllLiveMarkets()`: replaced sequential `for...of` fetches with `Promise.all()` — all per-market calls now fire concurrently
- `TradingAgent.tick()`: balance refresh, market discovery, and live market fetches now run in a single `Promise.all()` instead of three sequential awaits, minimising latency before entry/exit evaluation

## [1.22.0] — 2026-04-10

### Fixed
- `TradingStrategy.evaluateEntry()`: added `ENTRY_PRICE_DRIFT_TOLERANCE = 0.02` (2¢) — if the ask rises more than 2¢ from its tick-1 snapshot during the 3-tick confirmation window, the counter resets. Prevents entering at a price that moved against us while confirming.
- `TradingAgent.manageOpenPositions()`: now receives the tick's `allMarkets` map and reuses already-fetched market data for open positions instead of issuing a redundant `getMarket()` API call per position each tick. Falls back to a fresh fetch only for markets not present in the map.

## [1.21.0] — 2026-04-06

### Changed
- Budget increased from $500 → $1,000 (additional deposit).

## [1.20.0] — 2026-04-06

### Fixed
- `TradingStrategy.evaluateEntry`: `MAX_CONTRACTS_PER_TRADE=50` was the binding constraint, capping all trades at ~$45-48 (~10% of balance) instead of the intended 25%. Removed per-contract cap from entry sizing — balance fraction (25%) now governs exclusively.

## [1.19.0] — 2026-04-06

### Fixed
- `TradingStrategy.evaluateEntry`: reject ask ≥ $1.00 — buying at $1.00 pays face value with zero upside.

## [1.18.0] — 2026-04-06

### Changed
- `TradingStrategy`: trade size raised from 10% → 25% of balance per entry

## [1.17.0] — 2026-04-06

### Fixed
- `MarketService`: removed UTC date filter that silently dropped markets spanning midnight UTC. Filter removed — time-window check (`isWithinEntryWindow`) is the correct gate.

## [1.16.0] — 2026-04-05

### Changed
- `TradingStrategy`: fully market-price-based signals — no model dependency
  - **Entry**: buy when `yesAsk > 90¢`, size at flat 10% of balance (removed Kelly)
  - **Exit**: sell when `yesBid ≤ 80¢`

## [1.15.0] — 2026-04-05

### Changed
- `TradingStrategy.evaluateEntry`: entry trigger changed to Kalshi ask price crossing 90¢. Model retained for Kelly edge validation (`model_prob > ask`). Avoids trades where the model fires but the market disagrees.
- Updated tests: replaced probability-threshold tests with ask-crossing semantics

## [1.14.0] — 2026-04-05

### Added
- `BtcProbabilityModel` — Gaussian random walk model for BTC win probability from price change fraction and time remaining. Calibrated from 80% annual BTC volatility: `Φ(priceChangeFraction / (0.0001424 × √secondsRemaining))`.
- 15 new unit tests for `BtcProbabilityModel`

### Changed
- `TradingAgent` poll interval: 5s → 1s. Balance cached 5s to avoid redundant API calls.
- `AnalysisLogger` writes to daily `btc_analysis_YYYY-MM-DD.log`; `run.sh` writes to `btc_agent_YYYY-MM-DD.log`

## [1.13.0] — 2026-04-05

### Changed
- `TradingStrategy`: blended win probability = `0.7 × BTC Gaussian model + 0.3 × Kalshi market mid`. Market mid captures institutional flow not reflected in raw BTC price change.

## [1.12.0] — 2026-04-05

### Fixed
- Agent no longer tries to place sell orders into settled/inactive markets (was getting 409 `MARKET_NOT_ACTIVE` on every tick after market expiry)
- `manageOpenPositions` now has three distinct paths:
  1. `market.result` set → `recordSettlement()` directly (no order)
  2. Market inactive, no result yet → `AWAITING SETTLEMENT`
  3. Market active, exit signal → normal sell order

## [1.11.0] — 2026-04-05

### Changed
- `MAX_CONTRACTS_PER_TRADE` raised 10 → 50. At $500 balance the old cap limited every trade to ~$9.40 (1.9% of balance) regardless of sizing. Now the 10%-of-balance cap governs.

## [1.10.0] — 2026-04-05

### Changed
- `TradingAgent` poll interval reduced from 30s → 5s to match BTC price update cadence.

## [1.9.0] — 2026-04-05

### Fixed
- `TradeHistory` now accepts an injectable `filePath` constructor argument — tests use isolated `/tmp` files and no longer wipe the production trade record on every test run

### Changed
- `TradingStrategy`: replaced flat $50 per-trade cap with fractional Kelly criterion.

## [1.8.0] — 2026-04-05

### Fixed
- `TradingStrategy`: fixed `isTradeable()` to accept both `'open'` and `'active'` market statuses.

## [1.7.0] — 2026-04-05

### Added
- `AnalysisLogger` — writes one JSON line per tick to analysis log containing: all market evaluations with signals, entry/exit/hold decisions with order IDs, open position unrealized PnL, and portfolio summary

## [1.6.0] — 2026-04-05

### Fixed
- Reduced market cache TTL from 20s → 5s to match actual price update cadence.

## [1.5.0] — 2026-04-05

### Changed
- Replaced Claude cron orchestration with a self-contained background process — agent now runs its own loop via `TradingAgent.start()`, eliminating full conversation context loading on every tick
- Added `run.sh` to start the agent as a background process with PID tracking and file logging

## [1.4.0] — 2026-04-05

### Fixed
- Market clock display parsing fixed for sub-minute windows

## [1.3.0] — 2026-04-05

### Added
- Agent now logs all live market data before running tick evaluation

## [1.2.0] — 2026-04-05

### Fixed
- `TradingAgent` open positions were stored in-memory, resetting to empty on every cron invocation — now loads open trades from persistent `TradeHistory` on each tick

## [1.1.0] — 2026-04-05

### Changed
- Fixed market discovery to use `KXBTC15M` series
- Fixed price parsing: Kalshi returns `yes_bid_dollars`/`yes_ask_dollars` as dollar strings
- Updated `KalshiMarket` types to reflect actual API response shape
- Added `BtcPriceMonitor` service — polls Binance public API for live BTC price
- `MarketService` filters to only markets within the 60–300s entry window

## [1.0.0] — 2026-04-05

### Added
- Initial autonomous BTC 15-minute trading agent implementation
- `KalshiClient` — RSA-PSS authenticated HTTP client for all Kalshi trade API v2 endpoints
- `MarketService` — discovers and parses live `KXBTC15M` markets
- `OrderService` — places and cancels limit orders for YES/NO sides
- `PortfolioService` — reads account balance and open positions
- `TradingStrategy` — entry signal (ask > 90¢), exit signal (bid ≤ 70¢ hard stop, bid ≤ 80¢ with probability guard), contract sizing, PnL calculation
- `TradeHistory` — persists full trade records to `btc_trade_history.json`
- `TradingAgent` — event-driven agent orchestrating market scan → entry → exit lifecycle
- `design.md` architecture and decision documentation
- TypeScript strict-mode throughout; fully typed Kalshi API response interfaces
