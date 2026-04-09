import { MarketService, BasketballMarket } from '../services/MarketService';
import { OrderService } from '../services/OrderService';
import { PortfolioService } from '../services/PortfolioService';
import { GameMonitor } from '../services/GameMonitor';
import { TradingStrategy } from '../strategy/TradingStrategy';
import { TradeHistory, TradeRecord } from '../storage/TradeHistory';
import { AnalysisLogger } from '../storage/AnalysisLogger';
import * as crypto from 'crypto';

const POLL_INTERVAL_MS = 1_000;   // Kalshi bid/ask update cadence
const BALANCE_REFRESH_MS = 5_000; // balance only refreshed every 5s

export class TradingAgent {
  private running = false;
  private readonly analysis = new AnalysisLogger();
  private cachedBalanceCents = 0;
  private lastBalanceFetch = 0;
  private lastLoggedBalanceCents = -1;
  private readonly entryCooldowns = new Map<string, number>(); // ticker -> cooldown expiry ms
  private tickCount = 0;

  private static readonly ENTRY_COOLDOWN_MS = 10_000;  // 10s cooldown after failed buy
  private static readonly RECONCILE_INTERVAL = 15;     // reconcile every N ticks

  constructor(
    private readonly markets: MarketService,
    private readonly orders: OrderService,
    private readonly portfolio: PortfolioService,
    private readonly strategy: TradingStrategy,
    private readonly history: TradeHistory,
    private readonly gameMonitor: GameMonitor,
  ) {}

  async tick(): Promise<void> {
    const now = Date.now();
    if (now - this.lastBalanceFetch >= BALANCE_REFRESH_MS) {
      this.cachedBalanceCents = await this.portfolio.getBalance();
      this.lastBalanceFetch = now;
    }
    const balanceCents = this.cachedBalanceCents;
    this.analysis.startTick(balanceCents);

    if (balanceCents !== this.lastLoggedBalanceCents) {
      console.log(`[Agent] ${new Date().toISOString()} | Balance: $${(balanceCents / 100).toFixed(2)}`);
      this.lastLoggedBalanceCents = balanceCents;
    }

    if (this.portfolio.isBudgetExhausted(balanceCents)) {
      console.log('[Agent] Budget exhausted — halting.');
      return;
    }

    // Fetch games and markets together — logged as unified entries
    const allGames = await this.gameMonitor.getLiveGames();
    const allMarkets = await this.markets.getAllLiveBasketballMarkets();
    this.analysis.logGames(allGames, allMarkets);

    this.tickCount++;
    if (this.tickCount % TradingAgent.RECONCILE_INTERVAL === 0) {
      await this.reconcileWithKalshi(allMarkets);
    }
    const openTrades = this.history.getOpenTrades();
    await this.manageOpenPositions();
    await this.scanForEntries(balanceCents, allMarkets.filter((m) => m.isQ4));

    const summary = this.history.getSummary();
    this.logSummary(summary);

    // Only finalize (write) the tick if there is something worth logging
    const hasLiveGames = allGames.length > 0;
    const hasOpenPositions = openTrades.length > 0;
    if (hasLiveGames || hasOpenPositions) {
      this.analysis.finalizeTick(summary);
    }
  }

  async start(): Promise<void> {
    this.running = true;
    console.log('[Agent] Starting autonomous trading agent...');
    this.logSummary(this.history.getSummary());

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

  /**
   * Reconcile local TradeHistory against Kalshi's actual positions and resting orders.
   * - External positions (on Kalshi but not in history) are adopted so the agent can manage them.
   * - Externally closed positions (in history but gone from Kalshi) are marked closed.
   * - Resting orders not placed by this agent are logged as warnings.
   */
  private async reconcileWithKalshi(allMarkets: BasketballMarket[]): Promise<void> {
    try {
      const [portfolio, openOrders] = await Promise.all([
        this.portfolio.getPortfolio(),
        this.portfolio.getOpenOrders(),
      ]);

      const openTrades = this.history.getOpenTrades();
      const trackedTickers = new Set(openTrades.map((t) => t.ticker));
      const marketMap = new Map(allMarkets.map((m) => [m.ticker, m]));

      // ── Adopt external positions ────────────────────────────────────────────
      for (const pos of portfolio.positions) {
        if (pos.contracts <= 0) continue;
        if (trackedTickers.has(pos.ticker)) continue;

        // Only adopt basketball markets we're watching
        const market = marketMap.get(pos.ticker);
        if (!market) continue;

        console.log(`[Agent] EXTERNAL POSITION detected: ${pos.ticker} x${pos.contracts} — adopting into history`);
        const record: TradeRecord = {
          id: crypto.randomUUID(),
          ticker: pos.ticker,
          marketTitle: market.title,
          side: 'yes',
          action: 'buy',
          contracts: pos.contracts,
          pricePerContract: market.yesAsk, // best estimate — actual entry price unknown
          totalCost: pos.contracts * market.yesAsk,
          winProbabilityAtEntry: market.winProbability,
          entryTime: new Date().toISOString(),
        };
        this.history.recordTrade(record);
        this.analysis.logDecision({
          type: 'entry',
          ticker: pos.ticker,
          reason: 'External position adopted into tracking',
          contracts: pos.contracts,
          filledContracts: pos.contracts,
          fillStatus: 'filled',
          price: market.yesAsk,
        });
      }

      // ── Detect externally closed positions ─────────────────────────────────
      const kalshiTickers = new Set(portfolio.positions.filter((p) => p.contracts > 0).map((p) => p.ticker));
      for (const trade of openTrades) {
        if (!kalshiTickers.has(trade.ticker)) {
          // Only flag if this is a market we'd expect to still be active
          if (marketMap.has(trade.ticker)) {
            console.log(`[Agent] EXTERNAL CLOSE detected: ${trade.ticker} no longer in Kalshi positions — marking closed`);
            this.history.updateTrade(trade.id, {
              exitTime: new Date().toISOString(),
              exitReason: 'manual',
              pnl: 0, // unknown — externally closed
            });
            this.analysis.logDecision({
              type: 'exit',
              ticker: trade.ticker,
              reason: 'Externally closed — position no longer present on Kalshi',
              contracts: trade.contracts,
              fillStatus: 'filled',
            });
          }
        }
      }

      // ── Log resting orders not placed by this agent ────────────────────────
      const agentOrderIds = new Set<string>(); // agent-placed orders aren't tracked beyond fill
      for (const order of openOrders) {
        if (agentOrderIds.has(order.order_id)) continue;
        if (!marketMap.has(order.ticker)) continue;
        console.log(
          `[Agent] EXTERNAL RESTING ORDER: ${order.ticker} | ${order.action} ${order.side} x${order.remaining_count_fp} @ $${order.yes_price_dollars} | orderId=${order.order_id}`,
        );
      }
    } catch (err) {
      console.error('[Agent] Reconciliation error:', err);
    }
  }

  private async manageOpenPositions(): Promise<void> {
    const openTrades = this.history.getOpenTrades();

    // Track current market state for analysis logging
    const openMarkets = new Map<string, BasketballMarket>();

    if (openTrades.length > 0) {
      console.log(`[Agent] Managing ${openTrades.length} open position(s)...`);
    }

    for (const record of openTrades) {
      try {
        const market = await this.markets.getMarket(record.ticker);
        openMarkets.set(record.ticker, market);

        // Market settled — record outcome directly, no sell order needed
        if (market.result) {
          this.strategy.clearExitConfirmation(record.ticker);
          this.recordSettlement(record, market);
          continue;
        }

        const isTradeable = market.status === 'active' || market.status === 'open';

        // Market closed but not yet settled — Kalshi resolves asynchronously, wait
        if (!isTradeable) {
          console.log(`[Agent] AWAITING SETTLEMENT ${record.ticker} (status=${market.status})`);
          this.analysis.logDecision({ type: 'hold', ticker: record.ticker, reason: `Awaiting settlement (status=${market.status})` });
          continue;
        }

        const signal = this.strategy.evaluateExit(market, record.contracts);

        if (signal.action === 'sell') {
          console.log(`[Agent] EXIT ${record.ticker}: ${signal.reason}`);
          this.strategy.clearExitConfirmation(record.ticker);
          const fill = await this.executeExit(record, market, signal.suggestedLimitPrice ?? market.yesBid);
          this.analysis.logDecision({
            type: 'exit',
            ticker: record.ticker,
            reason: signal.reason,
            contracts: record.contracts,
            filledContracts: fill?.filledCount,
            fillStatus: fill === undefined ? 'unfilled' : fill.filledCount >= record.contracts ? 'filled' : fill.filledCount > 0 ? 'partial' : 'unfilled',
            price: signal.suggestedLimitPrice ?? market.yesBid,
            orderId: fill?.orderId,
          });
        } else {
          console.log(`[Agent] HOLD ${record.ticker} @ prob=${(market.winProbability * 100).toFixed(1)}%`);
          this.analysis.logDecision({ type: 'hold', ticker: record.ticker, reason: signal.reason });
        }
      } catch (err) {
        console.error(`[Agent] Error managing position ${record.ticker}:`, err);
      }
    }

    this.analysis.logOpenPositions(openTrades, openMarkets);
  }

  private async scanForEntries(balanceCents: number, liveMarkets: BasketballMarket[]): Promise<void> {
    const openTrades = this.history.getOpenTrades();
    const openTickers = new Set(openTrades.map((t) => t.ticker));
    const openPositionsCostCents = Math.round(
      openTrades.reduce((sum, t) => sum + (isFinite(t.totalCost) ? t.totalCost : 0), 0) * 100,
    );

    console.log(`[Agent] ${liveMarkets.length} Q4 market(s) found | deployed=$${(openPositionsCostCents / 100).toFixed(2)}`);

    const now = Date.now();
    for (const market of liveMarkets) {
      if (openTickers.has(market.ticker)) continue;

      // Skip tickers in cooldown after a failed buy
      const cooldownUntil = this.entryCooldowns.get(market.ticker);
      if (cooldownUntil !== undefined && now < cooldownUntil) {
        const secsLeft = Math.ceil((cooldownUntil - now) / 1000);
        console.log(`[Agent] SKIP ${market.ticker} | prob=${(market.winProbability * 100).toFixed(1)}% | cooldown after failed buy (${secsLeft}s remaining)`);
        continue;
      }

      const signal = this.strategy.evaluateEntry(market, balanceCents, openPositionsCostCents);
      this.analysis.logMarketEval(market, signal);

      if (signal.action === 'buy') {
        console.log(
          `[Agent] ENTRY ${market.ticker} | prob=${(market.winProbability * 100).toFixed(1)}% | ${signal.suggestedContracts} contracts @ $${signal.suggestedLimitPrice?.toFixed(2)}`,
        );
        this.strategy.clearEntryConfirmation(market.ticker);
        const fill = await this.executeEntry(market, signal.suggestedContracts!, signal.suggestedLimitPrice!);
        if (fill === undefined || fill.filledCount === 0) {
          // Buy failed/unfilled — apply cooldown so confirmation doesn't immediately re-trigger
          this.entryCooldowns.set(market.ticker, Date.now() + TradingAgent.ENTRY_COOLDOWN_MS);
          this.strategy.clearEntryConfirmation(market.ticker);
        } else {
          this.entryCooldowns.delete(market.ticker);
        }
        this.analysis.logDecision({
          type: 'entry',
          ticker: market.ticker,
          reason: signal.reason,
          contracts: signal.suggestedContracts,
          filledContracts: fill?.filledCount,
          fillStatus: fill === undefined || fill.filledCount === 0 ? 'unfilled' : fill.filledCount >= signal.suggestedContracts! ? 'filled' : 'partial',
          price: signal.suggestedLimitPrice,
          orderId: fill?.orderId,
        });
      } else {
        console.log(`[Agent] SKIP ${market.ticker} | prob=${(market.winProbability * 100).toFixed(1)}% | ${signal.reason}`);
      }
    }
  }

  private recordSettlement(record: TradeRecord, market: BasketballMarket): void {
    const won = market.result === record.side; // 'yes' side wins if result === 'yes'
    const settlementPrice = won ? 1.0 : 0.0;
    const pnl = this.strategy.calculatePnl(record.pricePerContract, settlementPrice, record.contracts);
    this.history.updateTrade(record.id, {
      exitTime: new Date().toISOString(),
      winProbabilityAtExit: won ? 1.0 : 0.0,
      pnl,
      exitReason: 'game_over',
      gameCompleted: true,
      gameResult: won ? 'win' : 'loss',
    });
    console.log(
      `[Agent] SETTLED ${record.ticker} result=${market.result} | ${won ? 'WON' : 'LOST'} | PnL: $${pnl.toFixed(2)}`,
    );
    this.analysis.logDecision({
      type: 'exit',
      ticker: record.ticker,
      reason: `Market settled: result=${market.result}`,
      contracts: record.contracts,
      price: settlementPrice,
    });
  }

  private async executeEntry(
    market: BasketballMarket,
    contracts: number,
    limitPrice: number,
  ): Promise<{ orderId: string; filledCount: number } | undefined> {
    try {
      const order = await this.orders.buyYes(market.ticker, contracts, limitPrice);

      if (order.filledCount === 0) {
        console.log(`[Agent] Order ${order.orderId} unfilled and cancelled — no position recorded`);
        return { orderId: order.orderId, filledCount: 0 };
      }

      if (order.filledCount < contracts) {
        console.log(`[Agent] Partial fill: ${order.filledCount}/${contracts} contracts on ${market.ticker}`);
      }

      const record: TradeRecord = {
        id: crypto.randomUUID(),
        ticker: market.ticker,
        marketTitle: market.title,
        side: 'yes',
        action: 'buy',
        contracts: order.filledCount,
        pricePerContract: limitPrice,
        totalCost: order.filledCount * limitPrice,
        winProbabilityAtEntry: market.winProbability,
        entryTime: new Date().toISOString(),
      };
      this.history.recordTrade(record);
      console.log(
        `[Agent] Bought ${order.filledCount} YES contracts on ${market.ticker} @ $${limitPrice.toFixed(2)} | orderId=${order.orderId}`,
      );
      return { orderId: order.orderId, filledCount: order.filledCount };
    } catch (err) {
      console.error(`[Agent] Failed to buy ${market.ticker}:`, err);
    }
  }

  private async executeExit(
    record: TradeRecord,
    market: BasketballMarket,
    limitPrice: number,
  ): Promise<{ orderId: string; filledCount: number } | undefined> {
    try {
      const order = await this.orders.sellYes(record.ticker, record.contracts, limitPrice);

      const soldContracts = order.filledCount;
      if (soldContracts === 0) {
        console.log(`[Agent] Sell order ${order.orderId} unfilled — position remains open`);
        return { orderId: order.orderId, filledCount: 0 };
      }

      if (soldContracts < record.contracts) {
        console.log(`[Agent] Partial sell: ${soldContracts}/${record.contracts} contracts on ${record.ticker}`);
        // Update position to reflect remaining contracts still held
        this.history.updateTrade(record.id, { contracts: record.contracts - soldContracts });
      }

      const pnl = this.strategy.calculatePnl(record.pricePerContract, limitPrice, soldContracts);
      if (soldContracts === record.contracts) {
        this.history.updateTrade(record.id, {
          exitTime: new Date().toISOString(),
          winProbabilityAtExit: market.winProbability,
          pnl,
          exitReason: market.status !== 'open' ? 'game_over' : 'probability_drop',
        });
      }
      console.log(
        `[Agent] Sold ${soldContracts} contracts on ${record.ticker} @ $${limitPrice.toFixed(2)} | PnL: $${pnl.toFixed(2)} | orderId=${order.orderId}`,
      );
      return { orderId: order.orderId, filledCount: soldContracts };
    } catch (err) {
      console.error(`[Agent] Failed to sell ${record.ticker}:`, err);
    }
  }

  private logSummary(s: { totalTrades: number; totalPnl: number; winRate: number }): void {
    console.log(
      `[Agent] History: ${s.totalTrades} trades | PnL=$${s.totalPnl.toFixed(2)} | WinRate=${(s.winRate * 100).toFixed(1)}%`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
