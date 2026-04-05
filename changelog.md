# Changelog

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
