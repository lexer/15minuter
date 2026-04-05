# Changelog

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
