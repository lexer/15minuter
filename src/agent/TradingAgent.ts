import { MarketService, BasketballMarket } from '../services/MarketService';
import { OrderService } from '../services/OrderService';
import { PortfolioService } from '../services/PortfolioService';
import { TradingStrategy } from '../strategy/TradingStrategy';
import { TradeHistory, TradeRecord } from '../storage/TradeHistory';
import * as crypto from 'crypto';

const POLL_INTERVAL_MS = 30_000;

export class TradingAgent {
  private running = false;
  private openPositions = new Map<string, TradeRecord>();

  constructor(
    private readonly markets: MarketService,
    private readonly orders: OrderService,
    private readonly portfolio: PortfolioService,
    private readonly strategy: TradingStrategy,
    private readonly history: TradeHistory,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    console.log('[Agent] Starting autonomous trading agent...');
    this.logSummary();

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        console.error('[Agent] Error during tick:', err);
      }
      if (this.running) {
        await this.sleep(POLL_INTERVAL_MS);
      }
    }
  }

  stop(): void {
    this.running = false;
    console.log('[Agent] Stopping...');
  }

  private async tick(): Promise<void> {
    const balanceCents = await this.portfolio.getBalance();
    console.log(`[Agent] Balance: $${(balanceCents / 100).toFixed(2)}`);

    if (this.portfolio.isBudgetExhausted(balanceCents)) {
      console.log('[Agent] Budget exhausted — stopping trading.');
      this.stop();
      return;
    }

    // 1. Check open positions for exit signals
    await this.manageOpenPositions(balanceCents);

    // 2. Scan for new entry opportunities
    await this.scanForEntries(balanceCents);
  }

  private async manageOpenPositions(balanceCents: number): Promise<void> {
    for (const [ticker, record] of this.openPositions.entries()) {
      try {
        const market = await this.markets.getMarket(ticker);
        const signal = this.strategy.evaluateExit(market, record.contracts);

        if (signal.action === 'sell') {
          console.log(
            `[Agent] EXIT signal for ${ticker}: ${signal.reason}`,
          );
          await this.executeExit(record, market, signal.suggestedLimitPrice ?? market.yesBid);
        } else {
          console.log(
            `[Agent] HOLD ${ticker} @ prob=${(market.winProbability * 100).toFixed(1)}%`,
          );
        }
      } catch (err) {
        console.error(`[Agent] Error managing position ${ticker}:`, err);
      }
    }
  }

  private async scanForEntries(balanceCents: number): Promise<void> {
    const liveMarkets = await this.markets.getLiveBasketballMarkets();
    console.log(`[Agent] Found ${liveMarkets.length} live basketball winner markets`);

    for (const market of liveMarkets) {
      if (this.openPositions.has(market.ticker)) continue;

      const signal = this.strategy.evaluateEntry(market, balanceCents);

      if (signal.action === 'buy') {
        console.log(
          `[Agent] ENTRY signal for ${market.ticker}: ${signal.reason} (${signal.suggestedContracts} contracts @ $${signal.suggestedLimitPrice?.toFixed(2)})`,
        );
        await this.executeEntry(market, signal.suggestedContracts!, signal.suggestedLimitPrice!);
      } else {
        console.log(`[Agent] SKIP ${market.ticker}: ${signal.reason}`);
      }
    }
  }

  private async executeEntry(
    market: BasketballMarket,
    contracts: number,
    limitPrice: number,
  ): Promise<void> {
    try {
      const order = await this.orders.buyYes(market.ticker, contracts, limitPrice);
      const record: TradeRecord = {
        id: crypto.randomUUID(),
        ticker: market.ticker,
        marketTitle: market.title,
        side: 'yes',
        action: 'buy',
        contracts,
        pricePerContract: limitPrice,
        totalCost: contracts * limitPrice,
        winProbabilityAtEntry: market.winProbability,
        entryTime: new Date().toISOString(),
      };
      this.history.recordTrade(record);
      this.openPositions.set(market.ticker, record);
      console.log(
        `[Agent] Bought ${contracts} YES contracts on ${market.ticker} @ $${limitPrice.toFixed(2)} (orderId=${order.orderId})`,
      );
    } catch (err) {
      console.error(`[Agent] Failed to place buy order for ${market.ticker}:`, err);
    }
  }

  private async executeExit(
    record: TradeRecord,
    market: BasketballMarket,
    limitPrice: number,
  ): Promise<void> {
    try {
      const order = await this.orders.sellYes(
        record.ticker,
        record.contracts,
        limitPrice,
      );
      const pnl = this.strategy.calculatePnl(
        record.pricePerContract,
        limitPrice,
        record.contracts,
      );
      this.history.updateTrade(record.id, {
        exitTime: new Date().toISOString(),
        winProbabilityAtExit: market.winProbability,
        pnl,
        exitReason: market.status !== 'open' ? 'game_over' : 'probability_drop',
      });
      this.openPositions.delete(record.ticker);
      console.log(
        `[Agent] Sold ${record.contracts} YES contracts on ${record.ticker} @ $${limitPrice.toFixed(2)} | PnL: $${pnl.toFixed(2)} (orderId=${order.orderId})`,
      );
    } catch (err) {
      console.error(`[Agent] Failed to place sell order for ${record.ticker}:`, err);
    }
  }

  private logSummary(): void {
    const summary = this.history.getSummary();
    console.log(
      `[Agent] Trade history: ${summary.totalTrades} trades, PnL=$${summary.totalPnl.toFixed(2)}, winRate=${(summary.winRate * 100).toFixed(1)}%`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
