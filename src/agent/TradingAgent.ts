import { MarketService, BasketballMarket } from '../services/MarketService';
import { OrderService } from '../services/OrderService';
import { PortfolioService } from '../services/PortfolioService';
import { TradingStrategy } from '../strategy/TradingStrategy';
import { TradeHistory, TradeRecord } from '../storage/TradeHistory';
import * as crypto from 'crypto';

const POLL_INTERVAL_MS = 30_000;

export class TradingAgent {
  private running = false;

  constructor(
    private readonly markets: MarketService,
    private readonly orders: OrderService,
    private readonly portfolio: PortfolioService,
    private readonly strategy: TradingStrategy,
    private readonly history: TradeHistory,
  ) {}

  /** Run a single strategy tick and return. Used by cron/scripts. */
  async tick(): Promise<void> {
    const balanceCents = await this.portfolio.getBalance();
    console.log(`[Agent] ${new Date().toISOString()} | Balance: $${(balanceCents / 100).toFixed(2)}`);

    if (this.portfolio.isBudgetExhausted(balanceCents)) {
      console.log('[Agent] Budget exhausted — halting.');
      return;
    }

    await this.manageOpenPositions();
    await this.scanForEntries(balanceCents);
    this.logSummary();
  }

  /** Run continuously in a loop, polling every 30 seconds. */
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

  private async manageOpenPositions(): Promise<void> {
    // Load open positions from persistent history — survives across cron invocations
    const openTrades = this.history.getOpenTrades();
    if (openTrades.length === 0) return;

    console.log(`[Agent] Managing ${openTrades.length} open position(s)...`);

    for (const record of openTrades) {
      try {
        const market = await this.markets.getMarket(record.ticker);
        const signal = this.strategy.evaluateExit(market, record.contracts);

        if (signal.action === 'sell') {
          console.log(`[Agent] EXIT ${record.ticker}: ${signal.reason}`);
          await this.executeExit(record, market, signal.suggestedLimitPrice ?? market.yesBid);
        } else {
          console.log(`[Agent] HOLD ${record.ticker} @ prob=${(market.winProbability * 100).toFixed(1)}%`);
        }
      } catch (err) {
        console.error(`[Agent] Error managing position ${record.ticker}:`, err);
      }
    }
  }

  private async scanForEntries(balanceCents: number): Promise<void> {
    const liveMarkets = await this.markets.getLiveBasketballMarkets();
    const openTickers = new Set(this.history.getOpenTrades().map((t) => t.ticker));

    console.log(`[Agent] ${liveMarkets.length} Q4 market(s) found`);

    for (const market of liveMarkets) {
      if (openTickers.has(market.ticker)) continue;

      const signal = this.strategy.evaluateEntry(market, balanceCents);

      if (signal.action === 'buy') {
        console.log(
          `[Agent] ENTRY ${market.ticker} | prob=${(market.winProbability * 100).toFixed(1)}% | ${signal.suggestedContracts} contracts @ $${signal.suggestedLimitPrice?.toFixed(2)}`,
        );
        await this.executeEntry(market, signal.suggestedContracts!, signal.suggestedLimitPrice!);
      } else {
        console.log(`[Agent] SKIP ${market.ticker} | prob=${(market.winProbability * 100).toFixed(1)}% | ${signal.reason}`);
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
      console.log(
        `[Agent] Bought ${contracts} YES contracts on ${market.ticker} @ $${limitPrice.toFixed(2)} | orderId=${order.orderId}`,
      );
    } catch (err) {
      console.error(`[Agent] Failed to buy ${market.ticker}:`, err);
    }
  }

  private async executeExit(
    record: TradeRecord,
    market: BasketballMarket,
    limitPrice: number,
  ): Promise<void> {
    try {
      const order = await this.orders.sellYes(record.ticker, record.contracts, limitPrice);
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
      console.log(
        `[Agent] Sold ${record.contracts} contracts on ${record.ticker} @ $${limitPrice.toFixed(2)} | PnL: $${pnl.toFixed(2)} | orderId=${order.orderId}`,
      );
    } catch (err) {
      console.error(`[Agent] Failed to sell ${record.ticker}:`, err);
    }
  }

  private logSummary(): void {
    const s = this.history.getSummary();
    console.log(
      `[Agent] History: ${s.totalTrades} trades | PnL=$${s.totalPnl.toFixed(2)} | WinRate=${(s.winRate * 100).toFixed(1)}%`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
