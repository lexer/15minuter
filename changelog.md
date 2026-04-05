# Changelog

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
