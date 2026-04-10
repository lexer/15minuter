import { MarketService, BasketballMarket } from '../services/MarketService';
import { OrderService } from '../services/OrderService';
import { PortfolioService } from '../services/PortfolioService';
import { GameMonitor } from '../services/GameMonitor';
import { TradingStrategy } from '../strategy/TradingStrategy';
import { TradeHistory, TradeRecord } from '../storage/TradeHistory';
import { AnalysisLogger } from '../storage/AnalysisLogger';
import { KalshiWebSocket, WsTickerMessage, WsFillMessage, WsMarketPositionMessage } from '../api/KalshiWebSocket';
import * as crypto from 'crypto';

// ── Intervals ─────────────────────────────────────────────────────────────────
const GAME_STATE_INTERVAL_MS     = 5_000;   // NBA CDN update cadence
const MARKET_DISCOVERY_INTERVAL_MS = 30_000; // REST: find new/closed markets
const BALANCE_REFRESH_INTERVAL_MS  = 10_000; // REST: correct balance drift
const RECONCILE_INTERVAL_MS        = 15_000; // REST: sanity-check positions

export class TradingAgent {
  private running              = false;
  private readonly analysis    = new AnalysisLogger();
  private cachedBalanceCents   = 0;
  private lastLoggedBalance    = -1;
  private readonly entryCooldowns  = new Map<string, number>(); // ticker → expiry ms
  private readonly pendingEntries  = new Set<string>();         // prevent concurrent orders
  private readonly intervals: ReturnType<typeof setInterval>[] = [];

  constructor(
    private readonly ws:        KalshiWebSocket,
    private readonly markets:   MarketService,
    private readonly orders:    OrderService,
    private readonly portfolio: PortfolioService,
    private readonly strategy:  TradingStrategy,
    private readonly history:   TradeHistory,
    private readonly gameMonitor: GameMonitor,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;
    console.log('[Agent] Starting autonomous trading agent...');
    this.logSummary(this.history.getSummary());

    // Initial data fetch: market discovery + balance in parallel
    const [, balance] = await Promise.all([
      this.markets.getAllLiveBasketballMarkets(),
      this.portfolio.getBalance(),
    ]);
    this.cachedBalanceCents = balance;
    this.logBalance();

    // Subscribe to all discovered tickers before connecting
    const allTickers = this.markets.getCachedMarkets().map((m) => m.ticker);
    this.ws.subscribeToTickers(allTickers);
    console.log(`[Agent] Pre-subscribed to ${allTickers.length} market ticker(s)`);

    // Wire WS event handlers
    this.ws.on('ticker',          (msg) => void this.onTicker(msg));
    this.ws.on('fill',            (msg) => void this.onFill(msg));
    this.ws.on('market_position', (msg) => this.onMarketPosition(msg));

    // Open WebSocket connections
    await this.ws.connect();

    // Periodic background tasks
    this.intervals.push(
      setInterval(() => void this.gameStateLoop(),      GAME_STATE_INTERVAL_MS),
      setInterval(() => void this.marketDiscoveryLoop(), MARKET_DISCOVERY_INTERVAL_MS),
      setInterval(() => void this.balanceRefreshLoop(),  BALANCE_REFRESH_INTERVAL_MS),
      setInterval(() => void this.reconcileLoop(),       RECONCILE_INTERVAL_MS),
    );
  }

  stop(): void {
    this.running = false;
    for (const id of this.intervals) clearInterval(id);
    this.intervals.length = 0;
    this.ws.stop();
    console.log('[Agent] Stopped.');
  }

  // ── WebSocket event handlers ─────────────────────────────────────────────────

  private async onTicker(msg: WsTickerMessage): Promise<void> {
    const market = this.markets.applyTickerUpdate(msg);
    if (!market || !market.isQ4) return;
    await this.handleMarket(market);
  }

  private async onFill(msg: WsFillMessage): Promise<void> {
    const price = parseFloat(msg.yes_price_dollars);
    const count = parseFloat(msg.count_fp);
    const delta = Math.round(price * count * 100);
    // Optimistically adjust cached balance: buys cost cash, sells return it
    this.cachedBalanceCents += msg.action === 'buy' ? -delta : delta;
    console.log(
      `[Agent] FILL ${msg.market_ticker} ${msg.action} ${msg.count_fp} @ $${msg.yes_price_dollars}` +
      ` | balance≈$${(this.cachedBalanceCents / 100).toFixed(2)}`,
    );
  }

  private onMarketPosition(msg: WsMarketPositionMessage): void {
    const contracts = parseFloat(msg.position_fp);
    console.log(
      `[Agent] POSITION ${msg.market_ticker} = ${contracts} contracts` +
      ` | cost=$${msg.position_cost_dollars} | pnl=$${msg.realized_pnl_dollars}`,
    );
  }

  // ── Periodic background loops ────────────────────────────────────────────────

  /** Re-fetch NBA game states → update win probabilities → re-evaluate Q4 markets. */
  private async gameStateLoop(): Promise<void> {
    if (!this.running) return;
    try {
      const allGames = await this.gameMonitor.getLiveGames();
      await this.markets.refreshGameStates();

      const q4Markets = this.markets.getCachedQ4Markets();
      const openTrades = this.history.getOpenTrades();
      const openPositionsCostCents = this.openPositionsCost(openTrades);

      console.log(`[Agent] ${q4Markets.length} Q4 market(s) | deployed=$${(openPositionsCostCents / 100).toFixed(2)}`);

      // Populate analysis tick before evaluating markets (so logMarketEval can attach signals)
      this.analysis.startTick(this.cachedBalanceCents);
      this.analysis.logGames(allGames, this.markets.getCachedMarkets());
      const marketMap = new Map(this.markets.getCachedMarkets().map((m) => [m.ticker, m]));
      this.analysis.logOpenPositions(openTrades, marketMap);

      for (const market of q4Markets) {
        await this.handleMarket(market);
      }

      this.logSummary(this.history.getSummary());
      const hasLive = allGames.length > 0;
      const hasOpen = openTrades.length > 0;
      if (hasLive || hasOpen) {
        this.analysis.finalizeTick(this.history.getSummary());
      }
    } catch (err) {
      console.error('[Agent] gameStateLoop error:', err);
    }
  }

  /** Discover new/closed KXNBAGAME markets and update WS subscriptions. */
  private async marketDiscoveryLoop(): Promise<void> {
    if (!this.running) return;
    try {
      const { newTickers, removedTickers } = await this.markets.discoverMarkets();
      if (newTickers.length || removedTickers.length) {
        console.log(`[Agent] Market discovery: +${newTickers.length} new, -${removedTickers.length} removed`);
        this.ws.updateTickerSubscriptions(newTickers, removedTickers);
      }
    } catch (err) {
      console.error('[Agent] marketDiscoveryLoop error:', err);
    }
  }

  /** Correct cached balance via REST in case WS fill adjustments drifted. */
  private async balanceRefreshLoop(): Promise<void> {
    if (!this.running) return;
    try {
      this.cachedBalanceCents = await this.portfolio.getBalance();
      this.logBalance();
    } catch (err) {
      console.error('[Agent] balanceRefreshLoop error:', err);
    }
  }

  /** Reconcile local TradeHistory against Kalshi's actual positions. */
  private async reconcileLoop(): Promise<void> {
    if (!this.running) return;
    try {
      const allMarkets = this.markets.getCachedMarkets();
      await this.reconcileWithKalshi(allMarkets);
    } catch (err) {
      console.error('[Agent] reconcileLoop error:', err);
    }
  }

  // ── Core strategy evaluation ─────────────────────────────────────────────────

  /**
   * Evaluate a single Q4 market: manage exit for open positions,
   * or scan for a new entry. Called on every ticker update and every
   * game-state refresh.
   */
  private async handleMarket(market: BasketballMarket): Promise<void> {
    if (!this.running) return;
    if (this.portfolio.isBudgetExhausted(this.cachedBalanceCents)) return;

    const openTrades         = this.history.getOpenTrades();
    const openPositionsCost  = this.openPositionsCost(openTrades);
    const existingTrade      = openTrades.find((t) => t.ticker === market.ticker);

    if (existingTrade) {
      await this.managePosition(market, existingTrade);
    } else {
      await this.scanEntry(market, openPositionsCost);
    }
  }

  private async managePosition(
    market: BasketballMarket,
    record: TradeRecord,
  ): Promise<void> {
    // Market settled — record outcome directly
    if (market.result) {
      this.strategy.clearExitConfirmation(market.ticker);
      this.recordSettlement(record, market);
      return;
    }

    const isTradeable = market.status === 'active' || market.status === 'open';

    if (!isTradeable) {
      console.log(`[Agent] AWAITING SETTLEMENT ${market.ticker} (status=${market.status})`);
      return;
    }

    const signal = this.strategy.evaluateExit(market, record.contracts);

    if (signal.action === 'sell') {
      console.log(`[Agent] EXIT ${market.ticker}: ${signal.reason}`);
      this.strategy.clearExitConfirmation(market.ticker);
      const fill = await this.executeExit(record, market, signal.suggestedLimitPrice ?? market.yesBid);
      this.analysis.logDecision({
        type: 'exit', ticker: market.ticker, reason: signal.reason,
        contracts: record.contracts, filledContracts: fill?.filledCount,
        fillStatus: fill === undefined ? 'unfilled'
          : fill.filledCount >= record.contracts ? 'filled'
          : fill.filledCount > 0 ? 'partial' : 'unfilled',
        price: signal.suggestedLimitPrice ?? market.yesBid,
        orderId: fill?.orderId,
      });
    } else {
      console.log(`[Agent] HOLD ${market.ticker} @ prob=${(market.winProbability * 100).toFixed(1)}%`);
      this.analysis.logDecision({ type: 'hold', ticker: market.ticker, reason: signal.reason });

      // Top-up if position is below target
      const topUp = this.strategy.evaluateTopUp(
        market, record.contracts, this.cachedBalanceCents, this.openPositionsCost(this.history.getOpenTrades()),
      );
      if (topUp.contracts > 0) {
        console.log(`[Agent] TOP-UP ${market.ticker}: ${topUp.reason}`);
        const topUpMid = Math.floor((market.yesBid + market.yesAsk) / 2 * 100) / 100;
        const fill = await this.executeTopUp(record, market, topUp.contracts, topUpMid);
        this.analysis.logDecision({
          type: 'entry', ticker: market.ticker, reason: `Top-up: ${topUp.reason}`,
          contracts: topUp.contracts, filledContracts: fill?.filledCount,
          fillStatus: fill === undefined || fill.filledCount === 0 ? 'unfilled'
            : fill.filledCount >= topUp.contracts ? 'filled' : 'partial',
          price: topUpMid, orderId: fill?.orderId,
        });
      }
    }
  }

  private async scanEntry(market: BasketballMarket, openPositionsCostCents: number): Promise<void> {
    // Skip if a concurrent order is already in flight for this ticker
    if (this.pendingEntries.has(market.ticker)) return;

    // Skip if in cooldown after a failed fill
    const cooldown = this.entryCooldowns.get(market.ticker);
    if (cooldown !== undefined && Date.now() < cooldown) return;

    const signal = this.strategy.evaluateEntry(market, this.cachedBalanceCents, openPositionsCostCents);
    this.analysis.logMarketEval(market, signal);

    if (signal.action !== 'buy') {
      console.log(`[Agent] SKIP ${market.ticker} | prob=${(market.winProbability * 100).toFixed(1)}% | ${signal.reason}`);
      return;
    }

    console.log(
      `[Agent] ENTRY ${market.ticker} | prob=${(market.winProbability * 100).toFixed(1)}%` +
      ` | ${signal.suggestedContracts} contracts @ $${signal.suggestedLimitPrice?.toFixed(2)}`,
    );

    this.pendingEntries.add(market.ticker);
    try {
      const fill = await this.executeEntry(market, signal.suggestedContracts!, signal.suggestedLimitPrice!);
      if (!fill || fill.filledCount === 0) {
        this.entryCooldowns.set(market.ticker, Date.now() + 10_000);
      } else {
        this.entryCooldowns.delete(market.ticker);
      }
      this.analysis.logDecision({
        type: 'entry', ticker: market.ticker, reason: signal.reason,
        contracts: signal.suggestedContracts, filledContracts: fill?.filledCount,
        fillStatus: !fill || fill.filledCount === 0 ? 'unfilled'
          : fill.filledCount >= signal.suggestedContracts! ? 'filled' : 'partial',
        price: signal.suggestedLimitPrice, orderId: fill?.orderId,
      });
    } finally {
      this.pendingEntries.delete(market.ticker);
    }
  }

  // ── Order execution ──────────────────────────────────────────────────────────

  private async executeEntry(
    market: BasketballMarket,
    contracts: number,
    limitPrice: number,
  ): Promise<{ orderId: string; filledCount: number } | undefined> {
    try {
      const order = await this.orders.buyYes(market.ticker, contracts, limitPrice);
      if (order.filledCount === 0) {
        console.log(`[Agent] Order ${order.orderId} unfilled and cancelled`);
        return { orderId: order.orderId, filledCount: 0 };
      }
      if (order.filledCount < contracts) {
        console.log(`[Agent] Partial fill: ${order.filledCount}/${contracts} on ${market.ticker}`);
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
      console.log(`[Agent] Bought ${order.filledCount} YES on ${market.ticker} @ $${limitPrice.toFixed(2)} | orderId=${order.orderId}`);
      return { orderId: order.orderId, filledCount: order.filledCount };
    } catch (err) {
      console.error(`[Agent] Failed to buy ${market.ticker}:`, err);
    }
  }

  private async executeTopUp(
    record: TradeRecord,
    market: BasketballMarket,
    contracts: number,
    limitPrice: number,
  ): Promise<{ orderId: string; filledCount: number } | undefined> {
    try {
      const order = await this.orders.buyYes(market.ticker, contracts, limitPrice);
      if (order.filledCount === 0) {
        console.log(`[Agent] Top-up ${order.orderId} unfilled`);
        return { orderId: order.orderId, filledCount: 0 };
      }
      const addedCost   = order.filledCount * limitPrice;
      const newContracts = record.contracts + order.filledCount;
      const newAvgPrice  = (record.totalCost + addedCost) / newContracts;
      this.history.updateTrade(record.id, {
        contracts: newContracts,
        pricePerContract: newAvgPrice,
        totalCost: record.totalCost + addedCost,
      });
      console.log(`[Agent] TOP-UP filled ${order.filledCount}/${contracts} on ${record.ticker} @ $${limitPrice.toFixed(2)} | total=${newContracts} avg=$${newAvgPrice.toFixed(2)} | orderId=${order.orderId}`);
      return { orderId: order.orderId, filledCount: order.filledCount };
    } catch (err) {
      console.error(`[Agent] Failed to top-up ${record.ticker}:`, err);
    }
  }

  private async executeExit(
    record: TradeRecord,
    market: BasketballMarket,
    limitPrice: number,
  ): Promise<{ orderId: string; filledCount: number } | undefined> {
    try {
      const order = await this.orders.sellYes(record.ticker, record.contracts, limitPrice);
      if (order.filledCount === 0) {
        console.log(`[Agent] Sell ${order.orderId} unfilled — position remains`);
        return { orderId: order.orderId, filledCount: 0 };
      }
      if (order.filledCount < record.contracts) {
        console.log(`[Agent] Partial sell: ${order.filledCount}/${record.contracts} on ${record.ticker}`);
        this.history.updateTrade(record.id, { contracts: record.contracts - order.filledCount });
      }
      const pnl = this.strategy.calculatePnl(record.pricePerContract, limitPrice, order.filledCount);
      if (order.filledCount === record.contracts) {
        this.history.updateTrade(record.id, {
          exitTime: new Date().toISOString(),
          winProbabilityAtExit: market.winProbability,
          pnl,
          exitReason: market.status !== 'open' ? 'game_over' : 'probability_drop',
        });
      }
      console.log(`[Agent] Sold ${order.filledCount} on ${record.ticker} @ $${limitPrice.toFixed(2)} | PnL: $${pnl.toFixed(2)} | orderId=${order.orderId}`);
      return { orderId: order.orderId, filledCount: order.filledCount };
    } catch (err) {
      console.error(`[Agent] Failed to sell ${record.ticker}:`, err);
    }
  }

  // ── Settlement & reconciliation ──────────────────────────────────────────────

  private recordSettlement(record: TradeRecord, market: BasketballMarket): void {
    const won  = market.result === record.side;
    const pnl  = this.strategy.calculatePnl(record.pricePerContract, won ? 1.0 : 0.0, record.contracts);
    this.history.updateTrade(record.id, {
      exitTime: new Date().toISOString(),
      winProbabilityAtExit: won ? 1.0 : 0.0,
      pnl,
      exitReason: 'game_over',
      gameCompleted: true,
      gameResult: won ? 'win' : 'loss',
    });
    console.log(`[Agent] SETTLED ${record.ticker} result=${market.result} | ${won ? 'WON' : 'LOST'} | PnL: $${pnl.toFixed(2)}`);
    this.analysis.logDecision({ type: 'exit', ticker: record.ticker,
      reason: `Market settled: result=${market.result}`, contracts: record.contracts, price: won ? 1.0 : 0.0 });
  }

  private async reconcileWithKalshi(allMarkets: BasketballMarket[]): Promise<void> {
    try {
      const [portfolio, openOrders] = await Promise.all([
        this.portfolio.getPortfolio(),
        this.portfolio.getOpenOrders(),
      ]);
      const openTrades    = this.history.getOpenTrades();
      const trackedTickers = new Set(openTrades.map((t) => t.ticker));
      const marketMap     = new Map(allMarkets.map((m) => [m.ticker, m]));

      // Adopt external positions
      for (const pos of portfolio.positions) {
        if (pos.contracts <= 0 || trackedTickers.has(pos.ticker)) continue;
        const market = marketMap.get(pos.ticker);
        if (!market) continue;
        console.log(`[Agent] EXTERNAL POSITION detected: ${pos.ticker} x${pos.contracts} — adopting`);
        const record: TradeRecord = {
          id: crypto.randomUUID(), ticker: pos.ticker, marketTitle: market.title,
          side: 'yes', action: 'buy', contracts: pos.contracts,
          pricePerContract: market.yesAsk, totalCost: pos.contracts * market.yesAsk,
          winProbabilityAtEntry: market.winProbability, entryTime: new Date().toISOString(),
        };
        this.history.recordTrade(record);
      }

      // Detect externally closed positions
      const kalshiTickers = new Set(portfolio.positions.filter((p) => p.contracts > 0).map((p) => p.ticker));
      for (const trade of openTrades) {
        if (!kalshiTickers.has(trade.ticker) && marketMap.has(trade.ticker)) {
          console.log(`[Agent] EXTERNAL CLOSE detected: ${trade.ticker} — marking closed`);
          this.history.updateTrade(trade.id, { exitTime: new Date().toISOString(), exitReason: 'manual', pnl: 0 });
        }
      }

      // Log unexpected resting orders
      for (const order of openOrders) {
        if (marketMap.has(order.ticker)) {
          console.log(`[Agent] EXTERNAL RESTING ORDER: ${order.ticker} | ${order.action} ${order.side} x${order.remaining_count_fp} @ $${order.yes_price_dollars}`);
        }
      }
    } catch (err) {
      console.error('[Agent] Reconciliation error:', err);
    }
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  private openPositionsCost(trades: TradeRecord[]): number {
    return Math.round(trades.reduce((sum, t) => sum + (isFinite(t.totalCost) ? t.totalCost : 0), 0) * 100);
  }

  private logBalance(): void {
    if (this.cachedBalanceCents !== this.lastLoggedBalance) {
      console.log(`[Agent] ${new Date().toISOString()} | Balance: $${(this.cachedBalanceCents / 100).toFixed(2)}`);
      this.lastLoggedBalance = this.cachedBalanceCents;
    }
  }

  private logSummary(s: { totalTrades: number; totalPnl: number; winRate: number }): void {
    console.log(`[Agent] History: ${s.totalTrades} trades | PnL=$${s.totalPnl.toFixed(2)} | WinRate=${(s.winRate * 100).toFixed(1)}%`);
  }
}
