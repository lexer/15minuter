# Changelog

## [1.25.0] — 2026-04-10

### Changed
- **WebSocket integration**: replaced 1-second REST polling loop with event-driven architecture
  - `KalshiWebSocket` (new): single multiplexed connection to `wss://api.elections.kalshi.com/trade-api/ws/v2`; subscribes to `ticker`, `fill`, and `market_positions` channels. RSA-PSS auth headers on WS handshake (signs `{ts}GET/trade-api/ws/v2`). Exponential backoff reconnection (1s → 30s); resubscribes all tracked tickers on reconnect.
  - `MarketService`: added in-memory market cache; `applyTickerUpdate()` applies real-time WS bid/ask and recomputes blended win probability without a REST call; `refreshGameStates()` updates all cached markets' game states from NBA CDN (called every 5s); `discoverMarkets()` handles REST-based market discovery.
  - `TradingAgent`: rewritten as event-driven. `onTicker()` triggers strategy evaluation on every bid/ask update; `onFill()` optimistically adjusts cached balance; `onMarketPosition()` logs live position changes. Periodic setInterval loops: game state refresh (5s), market discovery (30s), balance correction (10s), reconciliation (15s).
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
- `MarketService.getAllLiveBasketballMarkets()`: replaced sequential `for...of` game-state fetches with `Promise.all()` — all per-market `getGameState()` calls now fire concurrently
- `TradingAgent.tick()`: balance refresh, `getLiveGames()`, and `getAllLiveBasketballMarkets()` now run in a single `Promise.all()` instead of three sequential awaits, minimising latency before entry/exit evaluation

## [1.22.0] — 2026-04-10

### Fixed
- `TradingStrategy.evaluateEntry()`: added `ENTRY_PRICE_DRIFT_TOLERANCE = 0.02` (2¢) — if the ask rises more than 2¢ from its tick-1 snapshot during the 3-tick confirmation window, the counter resets. Prevents entering at a price that moved against us while confirming.
- `TradingAgent.manageOpenPositions()`: now receives the tick's `allMarkets` map and reuses already-fetched market data for open positions instead of issuing a redundant `getMarket()` API call per position each tick. Falls back to a fresh fetch only for markets not present in the map (e.g. settling/inactive).

## [1.21.0] — 2026-04-06

### Changed
- Budget increased from $500 → $1,000 (additional deposit). `CLAUDE.md` rule 7 updated to reflect current budget.

## [1.20.0] — 2026-04-06

### Fixed
- `TradingStrategy.evaluateEntry`: `MAX_CONTRACTS_PER_TRADE=50` was the binding constraint, capping all trades at ~$45-48 (~10% of balance) instead of the intended 25%. Removed per-contract cap from entry sizing — balance fraction (25%) now governs exclusively.
- `CLAUDE.md`: updated Trading Strategy rules 3, 4, 7 to match actual implementation (ask/bid price signals, 25% sizing).

## [1.19.0] — 2026-04-06

### Fixed
- `TradingStrategy.evaluateEntry`: reject ask ≥ $1.00 — buying at $1.00 pays face value with zero upside. OKC market hit $1.00 (blowout vs UTA) and agent attempted entry.

## [1.18.0] — 2026-04-06

### Changed
- `TradingStrategy`: trade size raised from 10% → 25% of balance per entry

## [1.17.0] — 2026-04-06

### Fixed
- `MarketService`: removed UTC date filter that silently dropped overnight games. A game starting April 5th has ticker `26APR05...` but after midnight UTC the filter expected `26APR06...`, causing IND@CLE Q4 markets to be missed entirely. Filter removed — `isQ4OrLater` game state check is the correct gate.

## [1.16.0] — 2026-04-05

### Changed
- `TradingStrategy`: fully market-price-based signals — no model dependency
  - **Entry**: buy when `yesAsk > 90¢`, size at flat 10% of balance (removed Kelly)
  - **Exit**: sell when `yesBid ≤ 80¢` (was: model win probability ≤ 80%)
  - Simpler and more reactive: market price already reflects score, time, fouls, rotations

## [1.15.0] — 2026-04-05

### Changed
- `TradingStrategy.evaluateEntry`: entry trigger changed from model win probability to Kalshi ask price crossing 90¢. Model is retained for Kelly edge validation (`model_prob > ask`). This requires market confirmation before entering — avoids trades where the model fires but the market disagrees (e.g. market has info the score model doesn't).
- Updated tests: replaced "probability below threshold" tests with ask-crossing semantics

## [1.14.0] — 2026-04-05

### Added
- `src/scripts/backtest.ts` — calibration backtest using NBA Stats API (`playbyplayv3`). Pulls Q4 play-by-play for historical games, samples score at 12 time points per Q4, computes model win probability vs actual outcome, outputs calibration table + Brier score. Usage: `npm run backtest [-- --season 2024-25 --games 150]`
- `backtest` npm script

### Results (30-game pilot, 648 samples)
- Brier score: 0.028 (random=0.250, perfect=0.000)
- Model underconfident 60–95%: actual win rates 5–15% higher than predicted
- Model well-calibrated at 99–100% (blowouts)
- Implication: σ=0.307 should be **reduced** to make model more confident; recalibration pending full 150-game run

## [1.13.0] — 2026-04-05

### Added
- `WinProbabilityModel` — Gaussian random walk model (Clauset et al. 2015) for NBA win probability from score differential + time remaining. σ calibrated so +10 pts with 5 min left ≈ 97%. This gives an **independent** probability estimate that can have positive edge against the market ask price, unlike using market mid price which can never beat the ask.
- `MarketService.modelWinProbability()` overrides `winProbability` with the model when game state is available; extracts market team code from ticker suffix (e.g. `KXNBAGAME-...-BOS` → `BOS`)
- 15 new unit tests for `WinProbabilityModel`

### Changed
- `TradingAgent` poll interval: 5s → 1s (Kalshi bid/ask cadence). Balance cached 5s to avoid redundant API calls.
- `AnalysisLogger` writes to daily `analysis_YYYY-MM-DD.log` instead of one file; `run.sh` writes to `agent_YYYY-MM-DD.log`
- `.gitignore` updated for `agent_*.log` and `analysis_*.log` patterns
- `CLAUDE.md` strategy rule 5 updated to reflect 1s polling

## [1.12.0] — 2026-04-05

### Fixed
- Agent no longer tries to place sell orders into settled/inactive markets (was getting 409 `MARKET_NOT_ACTIVE` on every tick after game end)
- `manageOpenPositions` now has three distinct paths:
  1. `market.result` set → `recordSettlement()` directly (no order)
  2. Market inactive, no result yet → `AWAITING SETTLEMENT` (wait for Kalshi async resolution)
  3. Market active, prob below threshold → normal sell order
- Added `result?: string` field to `BasketballMarket` interface, populated from Kalshi API response

## [1.11.0] — 2026-04-05

### Changed
- `MAX_CONTRACTS_PER_TRADE` raised 10 → 50. At $500 balance the old cap limited every trade to ~$9.40 (1.9% of balance) regardless of Kelly. Now the 10%-of-balance cap governs sizing — ~$49/trade at $500, scaling proportionally as balance grows or shrinks.

## [1.10.0] — 2026-04-05

### Changed
- `TradingAgent` poll interval reduced from 30s → 5s to match NBA CDN update cadence (~5s per `Last-Modified` headers). The `GameMonitor` cache TTL was already 5s; now the agent reacts to each new scoreboard snapshot instead of waiting 30s.
- Updated `CLAUDE.md` strategy rule 5 to reflect 5-second loop.

## [1.9.0] — 2026-04-05

### Fixed
- `TradeHistory` now accepts an injectable `filePath` constructor argument — tests use isolated `/tmp` files and no longer delete `trade_history.json` in `process.cwd()`, which was silently wiping the production trade record every test run
- Restored BOS trade record (10 YES contracts @ $0.98, entered 2026-04-05T21:31:51Z)

### Changed
- `TradingStrategy`: replaced flat $50 per-trade cap with fractional Kelly criterion. Edge = `(prob - ask) / (1 - ask)`, size = `min(quarterKelly, 10%) × balance`. Only trades when `ask < prob` (positive EV); skips with "No edge" otherwise.
- `KalshiPosition` types updated to actual API response shape: `position_fp` (decimal string), `market_exposure_dollars`, `realized_pnl_dollars` etc. Legacy integer fields marked optional.
- `PortfolioService` updated to parse `position_fp` and `_dollars` string fields accordingly.
- `isTradeable()` now accepts both `'open'` and `'active'` status — KXNBAGAME markets use `'active'`.

## [1.8.0] — 2026-04-05

### Fixed
- Critical: `TradingStrategy` blocked all trades on KXNBAGAME markets because it checked `status === 'open'` but these markets use `status === 'active'`. Added `isTradeable()` helper accepting both. First real trade placed immediately after fix: 10 YES contracts on BOS @ $0.98.

## [1.7.0] — 2026-04-05

### Added
- `AnalysisLogger` — writes one JSON line per tick to `analysis.log` containing: all game states, Q4 market evaluations with signals, entry/exit/hold decisions with order IDs, open position unrealized PnL, and portfolio summary
- `TradingAgent` now accepts `GameMonitor` directly so it can log all game states (not just Q4) for analysis
- `analysis.log` added to `.gitignore`

## [1.6.0] — 2026-04-05

### Fixed
- Reduced `GameMonitor` cache TTL from 20s → 5s to match the actual NBA CDN update cadence (~5-10s per `Last-Modified` headers). Previously could act on game state up to 20s stale during critical Q4 moments.

## [1.5.0] — 2026-04-05

### Changed
- Replaced Claude cron orchestration with a self-contained background process — agent now runs its own 30-second loop via `TradingAgent.start()`, eliminating full conversation context loading on every tick
- Added `run.sh` to start the agent as a background process with PID tracking and file logging
- Added `npm run agent` script for direct invocation of compiled agent
- Added `agent.log` and `agent.pid` to `.gitignore`

## [1.4.0] — 2026-04-05

### Fixed
- Game clock display was broken for non-zero seconds (e.g. `PT00M27.30S` showed `00m27.30S` instead of `00:27`)
- Moved clock formatting to `GameMonitor.formatClock()` static utility with proper ISO 8601 duration parsing

## [1.3.0] — 2026-04-05

### Added
- `tick.ts` now logs all live game scores and periods before running the agent tick — no separate command needed to monitor game state
- Q4 games are marked with `*** Q4` in the log output

### Changed
- CLAUDE.md updated: all commits must also be **pushed** to remote

## [1.2.0] — 2026-04-05

### Fixed
- `TradingAgent` open positions were stored in-memory, resetting to empty on every cron invocation — now loads open trades from persistent `TradeHistory` on each tick
- Removed `openPositions` in-memory map; `getOpenTrades()` is the single source of truth

### Added
- `src/scripts/tick.ts` — single-shot tick script; cron now runs `npm run tick` against compiled code instead of inline bash
- `tick` npm script in `package.json`
- `TradingAgent.tick()` is now public for direct invocation by scripts

## [1.1.0] — 2026-04-05

### Changed
- Fixed market discovery to use `KXNBAGAME` series (individual game winner markets, not NBA Finals futures)
- Fixed price parsing: Kalshi returns `yes_bid_dollars`/`yes_ask_dollars` as dollar strings, not integer cents
- Updated `KalshiMarket` types to reflect actual API response shape
- Added `GameMonitor` service — polls NBA live scoreboard API to detect live games and current period
- `MarketService` now filters to only markets where the game is in Q4 or later (`period >= 4`, `gameStatus == 2`)
- Added team tricode mapping from Kalshi event ticker codes to NBA API tricodes
- Wired `GameMonitor` into agent entry point
- 34 tests passing (8 new tests for `GameMonitor` and updated `MarketService` tests)

## [1.0.0] — 2026-04-05

### Added
- Initial autonomous trading agent implementation
- `KalshiClient` — RSA-PSS authenticated HTTP client for all Kalshi trade API v2 endpoints (balance, markets, events, orders, positions)
- `MarketService` — discovers and parses live basketball game-winner markets across NBA series
- `OrderService` — places and cancels limit orders for YES/NO sides
- `PortfolioService` — reads account balance and open positions
- `TradingStrategy` — entry signal (>90% win probability), exit signal (≤80%), contract sizing, PnL calculation
- `TradeHistory` — persists full trade records to `trade_history.json`
- `TradingAgent` — 30-second polling loop orchestrating market scan → entry → exit lifecycle
- 26 unit/integration tests (22 unit, 4 live API)
- `design.md` architecture and decision documentation
- TypeScript strict-mode throughout; fully typed Kalshi API response interfaces
