import { MarketService, BtcMarket } from '../services/MarketService';
import { OrderService } from '../services/OrderService';
import { PortfolioService } from '../services/PortfolioService';
import { TradingStrategy } from '../strategy/TradingStrategy';
import { TradeHistory, TradeRecord } from '../storage/TradeHistory';
import { AnalysisLogger } from '../storage/AnalysisLogger';
import { BinanceLiquidationMonitor } from '../services/BinanceLiquidationMonitor';
import {
  KalshiWebSocket,
  WsTickerMessage,
  WsFillMessage,
  WsMarketPositionMessage,
} from '../api/KalshiWebSocket';
import * as crypto from 'crypto';

// ── Intervals ─────────────────────────────────────────────────────────────────
const BTC_STATE_INTERVAL_MS         =  5_000; // BRTI state refresh cadence
const MARKET_DISCOVERY_INTERVAL_MS  = 30_000; // REST: find new/closed markets
const BALANCE_REFRESH_INTERVAL_MS   = 10_000; // REST: correct balance drift
const RECONCILE_INTERVAL_MS         = 15_000; // REST: sanity-check positions

export class TradingAgent {
  private running                  = false;
  private readonly analysis        = new AnalysisLogger();
  private cachedBalanceCents       = 0;
  private lastLoggedBalance        = -1;
  private readonly pendingEntries  = new Set<string>();
  /** Tickers whose market closed before the sell order could execute — await settlement. */
  private readonly pendingSettlement = new Set<string>();
  private readonly intervals: ReturnType<typeof setInterval>[] = [];

  // ── Fill price tracking ──────────────────────────────────────────────────────
  private readonly fillAccumulator = new Map<string, { totalCost: number; filledContracts: number }>();
  private readonly orderTradeMap   = new Map<string, { tradeId: string; limitPrice: number; filledContracts: number }>();
  /** Prevent concurrent top-up orders for the same ticker (onTicker + btcStateLoop race). */
  private readonly pendingTopUps   = new Set<string>();
  /** Prevent concurrent exit orders for the same ticker (onTicker + btcStateLoop race). */
  private readonly pendingExits    = new Set<string>();
  /**
   * Tickers where we have already attempted an exit this session.
   * Blocks both re-entry and top-up after any exit attempt.
   * Cleared when the market is removed from discovery (expired/closed).
   */
  private readonly recentlyExited  = new Set<string>();

  constructor(
    private readonly ws:                  KalshiWebSocket,
    private readonly markets:             MarketService,
    private readonly orders:              OrderService,
    private readonly portfolio:           PortfolioService,
    private readonly strategy:            TradingStrategy,
    private readonly history:             TradeHistory,
    private readonly liquidationMonitor:  BinanceLiquidationMonitor,
  ) {}

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.running = true;
    console.log('[Agent] Starting BTC 15-min trading agent...');
    this.logSummary(this.history.getSummary(), 0);

    const [, balance] = await Promise.all([
      this.markets.getAllLiveBtcMarkets(),
      this.portfolio.getBalance(),
    ]);
    this.cachedBalanceCents = balance;
    this.logBalance();

    const allTickers = this.markets.getCachedMarkets().map((m) => m.ticker);
    this.ws.subscribeToTickers(allTickers);
    console.log(`[Agent] Pre-subscribed to ${allTickers.length} KXBTC15M market(s)`);

    this.ws.on('ticker',          (msg) => void this.onTicker(msg));
    this.ws.on('fill',            (msg) => void this.onFill(msg));
    this.ws.on('market_position', (msg) => this.onMarketPosition(msg));

    await this.ws.connect();

    this.intervals.push(
      setInterval(() => void this.btcStateLoop(),        BTC_STATE_INTERVAL_MS),
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
    if (!market) return;

    // Log one analysis entry per WS tick — gives backtest-accurate bid/ask resolution.
    // startTick/logBrtiState must precede handleMarket so logMarketEval can annotate the snapshot.
    const brtiPrice = this.markets.getLatestBrtiState()?.currentPrice;
    this.analysis.startTick(this.cachedBalanceCents);
    this.analysis.logBrtiState(brtiPrice, [market]);

    await this.handleMarket(market);

    this.analysis.logOpenPositions(
      this.history.getOpenTrades(),
      new Map([[market.ticker, market]]),
    );
    const unrealizedPnl = this.computeUnrealizedPnl(this.history.getOpenTrades());
    this.analysis.finalizeTick(this.history.getSummary(), unrealizedPnl);
  }

  private async onFill(msg: WsFillMessage): Promise<void> {
    // WS fill messages only carry yes_price_dollars.
    // For NO fills the actual NO cost is 1 − yes_price_dollars.
    const yesPrice   = parseFloat(msg.yes_price_dollars);
    const actualPrice = msg.side === 'no' ? 1 - yesPrice : yesPrice;
    const count      = parseFloat(msg.count_fp);
    const delta      = Math.round(actualPrice * count * 100);
    this.cachedBalanceCents += msg.action === 'buy' ? -delta : delta;
    console.log(
      `[Agent] FILL ${msg.market_ticker} ${msg.side} ${msg.action} ${msg.count_fp}` +
      ` @ $${actualPrice.toFixed(3)} | balance≈$${(this.cachedBalanceCents / 100).toFixed(2)}`,
    );

    if (msg.action === 'buy') {
      const acc = this.fillAccumulator.get(msg.order_id) ?? { totalCost: 0, filledContracts: 0 };
      acc.totalCost       += actualPrice * count;
      acc.filledContracts += count;
      this.fillAccumulator.set(msg.order_id, acc);
      this.applyFillPrice(msg.order_id);
    }
  }

  private onMarketPosition(msg: WsMarketPositionMessage): void {
    const contracts = parseFloat(msg.position_fp);
    console.log(
      `[Agent] POSITION ${msg.market_ticker} = ${contracts} contracts` +
      ` | cost=$${msg.position_cost_dollars} | pnl=$${msg.realized_pnl_dollars}`,
    );

    if (contracts === 0) {
      const openTrade = this.history.getOpenTrades().find((t) => t.ticker === msg.market_ticker);
      if (openTrade) {
        console.log(`[Agent] POSITION CLOSED (WS) ${msg.market_ticker} — marking trade closed`);
        this.history.updateTrade(openTrade.id, {
          exitTime:   new Date().toISOString(),
          exitReason: 'manual',
          pnl:        parseFloat(msg.realized_pnl_dollars),
        });
      }
    }
  }

  // ── Periodic background loops ────────────────────────────────────────────────

  /**
   * Refresh BRTI price + settlement samples every 5s.
   * Trade evaluation and analysis logging are driven by onTicker (WS bid/ask updates).
   * This loop only handles what WS can't: BRTI state refresh and console status.
   */
  private async btcStateLoop(): Promise<void> {
    if (!this.running) return;
    try {
      await this.markets.refreshBtcStates();

      const brtiState            = this.markets.getLatestBrtiState();
      const tradingWindowMarkets = this.markets.getCachedTradingWindowMarkets();
      const openTrades           = this.history.getOpenTrades();
      const openPositionsCost    = this.openPositionsCost(openTrades);

      const brtiSummary = brtiState
        ? `BRTI $${brtiState.currentPrice.toFixed(2)}`
        : 'BRTI N/A (waiting for feed)';
      console.log(`[Agent] ${brtiSummary} | ${tradingWindowMarkets.length} market(s) in window | deployed=$${(openPositionsCost / 100).toFixed(2)}`);

      this.logSummary(this.history.getSummary(), this.computeUnrealizedPnl(openTrades));
    } catch (err) {
      console.error('[Agent] btcStateLoop error:', err);
    }
  }

  /** Discover new/closed KXBTC15M markets and update WS subscriptions. */
  private async marketDiscoveryLoop(): Promise<void> {
    if (!this.running) return;
    try {
      const { newTickers, removedTickers } = await this.markets.discoverMarkets();
      if (newTickers.length || removedTickers.length) {
        console.log(`[Agent] Market discovery: +${newTickers.length} new, -${removedTickers.length} removed`);
        this.ws.updateTickerSubscriptions(newTickers, removedTickers);
        for (const ticker of removedTickers) this.recentlyExited.delete(ticker);
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
      await this.reconcileWithKalshi(this.markets.getCachedMarkets());
    } catch (err) {
      console.error('[Agent] reconcileLoop error:', err);
    }
  }

  // ── Core strategy evaluation ─────────────────────────────────────────────────

  private async handleMarket(market: BtcMarket): Promise<void> {
    if (!this.running) return;
    if (this.portfolio.isBudgetExhausted(this.cachedBalanceCents)) return;

    const openTrades   = this.history.getOpenTrades();
    const existingTrade = openTrades.find((t) => t.ticker === market.ticker);

    if (existingTrade) {
      await this.managePosition(market, existingTrade);
    } else if (market.isInTradingWindow) {
      await this.scanEntry(market);
    }
  }

  private async managePosition(market: BtcMarket, record: TradeRecord): Promise<void> {
    if (market.result) {
      this.pendingSettlement.delete(market.ticker);
      this.recordSettlement(record, market);
      return;
    }

    // Market closed on exchange but Kalshi WS hasn't pushed a result yet — stop retrying sells
    if (this.pendingSettlement.has(market.ticker)) {
      console.log(`[Agent] AWAITING SETTLEMENT (market closed) ${market.ticker}`);
      return;
    }

    const isTradeable = market.status === 'active' || market.status === 'open';
    if (!isTradeable) {
      console.log(`[Agent] AWAITING SETTLEMENT ${market.ticker} (status=${market.status})`);
      return;
    }

    const signal = this.strategy.evaluateExit(market, record.contracts, record.side);

    if (signal.action === 'sell') {
      if (this.pendingExits.has(market.ticker)) return;
      console.log(`[Agent] EXIT ${market.ticker}: ${signal.reason}`);
      const exitBid = record.side === 'no' ? market.noBid : market.yesBid;
      this.pendingExits.add(market.ticker);
      try {
        const fill = await this.executeExit(record, market, signal.suggestedLimitPrice ?? exitBid);
        this.analysis.logDecision({
          type: 'exit', ticker: market.ticker, reason: signal.reason,
          contracts: record.contracts, filledContracts: fill?.filledCount,
          fillStatus: fill === undefined ? 'unfilled'
            : fill.filledCount >= record.contracts ? 'filled'
            : fill.filledCount > 0 ? 'partial' : 'unfilled',
          price: signal.suggestedLimitPrice ?? market.yesBid,
          orderId: fill?.orderId,
        });
      } finally {
        this.pendingExits.delete(market.ticker);
      }
    } else {
      console.log(`[Agent] HOLD ${market.ticker} @ prob=${(market.winProbability * 100).toFixed(1)}%`);
      this.analysis.logDecision({ type: 'hold', ticker: market.ticker, reason: signal.reason });

      // Top-up if position is below window budget limit (skip if we've already exited this market)
      if (!this.pendingTopUps.has(market.ticker) && !this.recentlyExited.has(market.ticker)) {
        const topUp = this.strategy.evaluateTopUp(market, record.contracts, this.cachedBalanceCents, record.side);
        if (topUp.contracts > 0) {
          const topUpPrice = record.side === 'no' ? market.noAsk : market.yesAsk;
          console.log(`[Agent] TOP-UP ${market.ticker}: ${topUp.reason}`);
          this.pendingTopUps.add(market.ticker);
          try {
            const fill = await this.executeTopUp(record, market, topUp.contracts, topUpPrice);
            this.analysis.logDecision({
              type: 'entry', ticker: market.ticker, reason: `Top-up: ${topUp.reason}`,
              contracts: topUp.contracts, filledContracts: fill?.filledCount,
              fillStatus: fill === undefined || fill.filledCount === 0 ? 'unfilled'
                : fill.filledCount >= topUp.contracts ? 'filled' : 'partial',
              price: topUpPrice, orderId: fill?.orderId,
            });
          } finally {
            this.pendingTopUps.delete(market.ticker);
          }
        }
      }
    }
  }

  private async scanEntry(market: BtcMarket): Promise<void> {
    if (this.pendingEntries.has(market.ticker)) return;
    if (this.recentlyExited.has(market.ticker)) return;

    // Block new entries during liquidation cascades — spreads are wide and fills are poor
    if (this.liquidationMonitor.isLiquidationCascade()) {
      const liq = this.liquidationMonitor.getLiquidationState();
      console.log(
        `[Agent] CASCADE BLOCK entry ${market.ticker}` +
        ` | $${(liq.recentVolumeUsd / 1_000_000).toFixed(2)}M liquidated in 10s`,
      );
      return;
    }

    const signal = this.strategy.evaluateEntry(market, this.cachedBalanceCents);
    this.analysis.logMarketEval(market, signal);

    if (signal.action !== 'buy') {
      console.log(`[Agent] SKIP ${market.ticker} | prob=${(market.winProbability * 100).toFixed(1)}% | ${signal.reason}`);
      return;
    }

    const targetStr = market.threshold > 0 ? ` | target=$${market.threshold.toFixed(2)}` : '';
    const sideLabel = signal.side === 'no' ? 'NO' : 'YES';
    console.log(
      `[Agent] ENTRY ${sideLabel} ${market.ticker} | prob=${(market.winProbability * 100).toFixed(1)}%` +
      `${targetStr} | ${signal.suggestedContracts} contracts @ $${signal.suggestedLimitPrice?.toFixed(2)}`,
    );

    this.pendingEntries.add(market.ticker);
    try {
      const fill = await this.executeEntry(market, signal.suggestedContracts!, signal.suggestedLimitPrice!, signal.side ?? 'yes');
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
    market: BtcMarket,
    contracts: number,
    limitPrice: number,
    side: 'yes' | 'no' = 'yes',
  ): Promise<{ orderId: string; filledCount: number } | undefined> {
    try {
      const order = side === 'no'
        ? await this.orders.buyNo(market.ticker, contracts, limitPrice)
        : await this.orders.buyYes(market.ticker, contracts, limitPrice);
      if (order.filledCount === 0) {
        console.log(`[Agent] Order ${order.orderId} unfilled and cancelled`);
        return { orderId: order.orderId, filledCount: 0 };
      }
      if (order.filledCount < contracts) {
        console.log(`[Agent] Partial fill: ${order.filledCount}/${contracts} on ${market.ticker}`);
      }
      const record: TradeRecord = {
        id:                    crypto.randomUUID(),
        ticker:                market.ticker,
        marketTitle:           market.title,
        side,
        action:                'buy',
        contracts:             order.filledCount,
        pricePerContract:      limitPrice,
        totalCost:             order.filledCount * limitPrice,
        winProbabilityAtEntry: market.winProbability,
        entryTime:             new Date().toISOString(),
      };
      this.history.recordTrade(record);
      this.orderTradeMap.set(order.orderId, { tradeId: record.id, limitPrice, filledContracts: order.filledCount });
      this.applyFillPrice(order.orderId);
      console.log(`[Agent] Bought ${order.filledCount} ${side.toUpperCase()} on ${market.ticker} @ $${limitPrice.toFixed(2)} | orderId=${order.orderId}`);
      return { orderId: order.orderId, filledCount: order.filledCount };
    } catch (err) {
      console.error(`[Agent] Failed to buy ${market.ticker}:`, err);
      if (err instanceof Error && err.message.includes('insufficient_balance')) {
        this.cachedBalanceCents = 0;
      }
    }
  }

  private async executeTopUp(
    record: TradeRecord,
    market: BtcMarket,
    contracts: number,
    limitPrice: number,
  ): Promise<{ orderId: string; filledCount: number } | undefined> {
    try {
      const order = record.side === 'no'
        ? await this.orders.buyNo(market.ticker, contracts, limitPrice)
        : await this.orders.buyYes(market.ticker, contracts, limitPrice);
      if (order.filledCount === 0) {
        console.log(`[Agent] Top-up ${order.orderId} unfilled`);
        return { orderId: order.orderId, filledCount: 0 };
      }
      const addedCost    = order.filledCount * limitPrice;
      const newContracts = record.contracts + order.filledCount;
      const newAvgPrice  = (record.totalCost + addedCost) / newContracts;
      this.history.updateTrade(record.id, {
        contracts:        newContracts,
        pricePerContract: newAvgPrice,
        totalCost:        record.totalCost + addedCost,
      });
      this.orderTradeMap.set(order.orderId, { tradeId: record.id, limitPrice, filledContracts: order.filledCount });
      this.applyFillPrice(order.orderId);
      console.log(`[Agent] TOP-UP filled ${order.filledCount}/${contracts} on ${record.ticker} @ $${limitPrice.toFixed(2)} | total=${newContracts}`);
      return { orderId: order.orderId, filledCount: order.filledCount };
    } catch (err) {
      console.error(`[Agent] Failed to top-up ${record.ticker}:`, err);
      if (err instanceof Error && err.message.includes('insufficient_balance')) {
        this.cachedBalanceCents = 0;
      }
    }
  }

  private async executeExit(
    record: TradeRecord,
    market: BtcMarket,
    limitPrice: number,
  ): Promise<{ orderId: string; filledCount: number } | undefined> {
    try {
      const order = record.side === 'no'
        ? await this.orders.sellNo(record.ticker, record.contracts, limitPrice)
        : await this.orders.sellYes(record.ticker, record.contracts, limitPrice);
      if (order.filledCount === 0) {
        console.log(`[Agent] Sell ${order.orderId} unfilled — position remains`);
        return { orderId: order.orderId, filledCount: 0 };
      }
      // Mark this ticker as exited — blocks re-entry and top-up for the rest of this session
      this.recentlyExited.add(record.ticker);

      if (order.filledCount < record.contracts) {
        console.log(`[Agent] Partial sell: ${order.filledCount}/${record.contracts} on ${record.ticker}`);
        const removedCost = order.filledCount * record.pricePerContract;
        this.history.updateTrade(record.id, {
          contracts: record.contracts - order.filledCount,
          totalCost: record.totalCost - removedCost,
        });
      }
      const pnl = this.strategy.calculatePnl(record.pricePerContract, limitPrice, order.filledCount);
      if (order.filledCount === record.contracts) {
        this.history.updateTrade(record.id, {
          exitTime:             new Date().toISOString(),
          winProbabilityAtExit: market.winProbability,
          pnl,
          exitReason:           market.status !== 'open' ? 'game_over' : 'probability_drop',
        });
      }
      console.log(`[Agent] Sold ${order.filledCount} on ${record.ticker} @ $${limitPrice.toFixed(2)} | PnL: $${pnl.toFixed(2)}`);
      return { orderId: order.orderId, filledCount: order.filledCount };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('market_closed')) {
        console.log(`[Agent] Market closed before sell — awaiting settlement ${record.ticker}`);
        this.pendingSettlement.add(record.ticker);
        return undefined;
      }
      console.error(`[Agent] Failed to sell ${record.ticker}:`, err);
    }
  }

  // ── Settlement & reconciliation ──────────────────────────────────────────────

  private recordSettlement(record: TradeRecord, market: BtcMarket): void {
    const won = market.result === record.side;
    const pnl = this.strategy.calculatePnl(record.pricePerContract, won ? 1.0 : 0.0, record.contracts);
    this.history.updateTrade(record.id, {
      exitTime:             new Date().toISOString(),
      winProbabilityAtExit: won ? 1.0 : 0.0,
      pnl,
      exitReason:           'game_over',
      gameCompleted:        true,
      gameResult:           won ? 'win' : 'loss',
    });
    console.log(`[Agent] SETTLED ${record.ticker} result=${market.result} | ${won ? 'WON' : 'LOST'} | PnL: $${pnl.toFixed(2)}`);
    this.analysis.logDecision({
      type: 'exit', ticker: record.ticker,
      reason: `Market settled: result=${market.result}`,
      contracts: record.contracts,
      price: won ? 1.0 : 0.0,
    });
  }

  private async reconcileWithKalshi(allMarkets: BtcMarket[]): Promise<void> {
    try {
      const [portfolio, openOrders] = await Promise.all([
        this.portfolio.getPortfolio(),
        this.portfolio.getOpenOrders(),
      ]);
      const openTrades     = this.history.getOpenTrades();
      const trackedTickers = new Set(openTrades.map((t) => t.ticker));
      const marketMap      = new Map(allMarkets.map((m) => [m.ticker, m]));

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
          const market = marketMap.get(trade.ticker)!;
          if (market.result) {
            // Market settled — compute proper PnL via recordSettlement
            console.log(`[Agent] SETTLEMENT detected via reconcile: ${trade.ticker} result=${market.result}`);
            this.recordSettlement(trade, market);
          } else {
            console.log(`[Agent] EXTERNAL CLOSE detected: ${trade.ticker} — marking closed`);
            this.history.updateTrade(trade.id, { exitTime: new Date().toISOString(), exitReason: 'manual', pnl: 0 });
          }
        }
      }

      for (const order of openOrders) {
        if (marketMap.has(order.ticker)) {
          console.log(`[Agent] RESTING ORDER: ${order.ticker} | ${order.action} ${order.side} x${order.remaining_count_fp} @ $${order.yes_price_dollars}`);
        }
      }
    } catch (err) {
      console.error('[Agent] Reconciliation error:', err);
    }
  }

  // ── Fill price reconciliation ────────────────────────────────────────────────

  private applyFillPrice(orderId: string): void {
    const pending = this.orderTradeMap.get(orderId);
    const acc     = this.fillAccumulator.get(orderId);
    if (!pending || !acc) return;
    if (acc.filledContracts < pending.filledContracts - 0.001) return;

    const trade = this.history.getAllTrades().find((t) => t.id === pending.tradeId);
    if (!trade) return;

    const correctedTotal = trade.totalCost - (pending.limitPrice * pending.filledContracts) + acc.totalCost;
    const correctedAvg   = correctedTotal / trade.contracts;

    if (Math.abs(correctedTotal - trade.totalCost) > 0.0001) {
      this.history.updateTrade(pending.tradeId, {
        pricePerContract: correctedAvg,
        totalCost:        correctedTotal,
      });
      const actualAvg = acc.totalCost / acc.filledContracts;
      console.log(`[Agent] FILL PRICE corrected ${trade.ticker}: limit=$${pending.limitPrice.toFixed(4)} actual=$${actualAvg.toFixed(4)}`);
    }

    this.fillAccumulator.delete(orderId);
    this.orderTradeMap.delete(orderId);
  }

  // ── Utilities ────────────────────────────────────────────────────────────────

  private openPositionsCost(trades: TradeRecord[]): number {
    return Math.round(trades.reduce((sum, t) => sum + (isFinite(t.totalCost) ? t.totalCost : 0), 0) * 100);
  }

  private computeUnrealizedPnl(openTrades: TradeRecord[]): number {
    const marketMap = new Map(this.markets.getCachedMarkets().map((m) => [m.ticker, m]));
    return openTrades.reduce((sum, trade) => {
      const market = marketMap.get(trade.ticker);
      if (!market) return sum;
      const currentBid = trade.side === 'no' ? market.noBid : market.yesBid;
      return sum + (currentBid - trade.pricePerContract) * trade.contracts;
    }, 0);
  }

  private logBalance(): void {
    if (this.cachedBalanceCents !== this.lastLoggedBalance) {
      console.log(`[Agent] ${new Date().toISOString()} | Balance: $${(this.cachedBalanceCents / 100).toFixed(2)}`);
      this.lastLoggedBalance = this.cachedBalanceCents;
    }
  }

  private logSummary(s: { totalTrades: number; realizedPnl: number; winRate: number }, unrealizedPnl: number): void {
    const totalPnl = s.realizedPnl + unrealizedPnl;
    console.log(
      `[Agent] History: ${s.totalTrades} trades | ` +
      `Realized=$${s.realizedPnl.toFixed(2)} Unrealized=$${unrealizedPnl.toFixed(2)} Total=$${totalPnl.toFixed(2)} | ` +
      `WinRate=${(s.winRate * 100).toFixed(1)}%`,
    );
  }
}
