import { KalshiClient } from '../api/KalshiClient';
import { KalshiMarket } from '../api/types';
import { WsTickerMessage } from '../api/KalshiWebSocket';
import { BtcPriceMonitor, BrtiState } from './BtcPriceMonitor';
import { BtcProbabilityModel } from './BtcProbabilityModel';

// Enter only in the final 60 seconds of the 15-min window (the settlement window).
// Entering at the start of BRTI averaging gives the most information about the outcome.
// A 5-second floor ensures there is time for an IOC order to execute.
export const TRADING_WINDOW_MIN_SECONDS = 5;
export const TRADING_WINDOW_MAX_SECONDS = 60;

// 30% market mid, 70% BTC Gaussian model — market mid captures flow from larger participants
const BLEND_MARKET_WEIGHT = 0.3;

// Settlement window is the final 60 seconds of each 15-min window.
// KXBTC15M resolves YES if the 60-second BRTI average > threshold.
const SETTLEMENT_WINDOW_SECONDS = 60;

export interface BtcMarket {
  ticker:            string;
  eventTicker:       string;
  title:             string;
  status:            string;
  result?:           string;
  yesBid:            number;
  yesAsk:            number;
  noBid:             number;
  noAsk:             number;
  lastPrice:         number;
  volume:            number;
  closeTime:         Date;
  winProbability:    number;
  isInTradingWindow: boolean;
  secondsLeft:       number;
  /** Threshold price from floor_strike field (e.g. 71544.59). Used for settlement. */
  threshold:         number;
  /** BRTI samples collected during the final 60-second settlement window. */
  settlementSamples: number[];
  brtiState?:        BrtiState;
}

export class MarketService {
  private readonly probModel = new BtcProbabilityModel();
  private readonly cache     = new Map<string, BtcMarket>();

  constructor(
    private readonly client:     KalshiClient,
    private readonly btcMonitor: BtcPriceMonitor,
  ) {}

  /** Fetch all open KXBTC15M markets and populate the cache. */
  async getAllLiveBtcMarkets(): Promise<BtcMarket[]> {
    const rawMarkets = await this.fetchAllMarkets();
    const brtiState  = await this.btcMonitor.getBtcState();

    const markets = rawMarkets
      .map((m) => this.parseMarket(m, brtiState))
      .filter((m): m is BtcMarket => m !== null);

    for (const m of markets) this.cache.set(m.ticker, m);
    return markets;
  }

  /** Returns only markets currently inside the 60–300s trading window. */
  async getLiveTradingWindowMarkets(): Promise<BtcMarket[]> {
    return (await this.getAllLiveBtcMarkets()).filter((m) => m.isInTradingWindow);
  }

  // ── Cache-based API (used by event-driven agent) ─────────────────────────────

  getCachedMarkets(): BtcMarket[] {
    return [...this.cache.values()];
  }

  getCachedTradingWindowMarkets(): BtcMarket[] {
    return [...this.cache.values()].filter((m) => m.isInTradingWindow);
  }

  /** Returns the most recent BRTI state attached to any cached market. */
  getLatestBrtiState(): BrtiState | undefined {
    for (const m of this.cache.values()) {
      if (m.brtiState) return m.brtiState;
    }
    return undefined;
  }

  /**
   * Apply a real-time WS ticker update to the cache.
   * Updates bid/ask, recomputes secondsLeft and window membership, blends probability.
   * Returns the updated market, or null if the ticker is not in cache.
   */
  applyTickerUpdate(msg: WsTickerMessage): BtcMarket | null {
    const market = this.cache.get(msg.market_ticker);
    if (!market) return null;

    const yesBid    = msg.yes_bid_dollars !== undefined ? parseFloat(String(msg.yes_bid_dollars)) : market.yesBid;
    const yesAsk    = msg.yes_ask_dollars !== undefined ? parseFloat(String(msg.yes_ask_dollars)) : market.yesAsk;
    const lastPrice = msg.price_dollars   !== undefined ? parseFloat(String(msg.price_dollars))   : market.lastPrice;

    const secondsLeft       = this.computeSecondsLeft(market.closeTime);
    const isInTradingWindow = this.inWindow(secondsLeft);
    const winProbability    = market.brtiState
      ? this.blendedProbability(market.brtiState, market.threshold, market.settlementSamples, secondsLeft, yesBid, yesAsk, market.closeTime)
      : market.winProbability;

    const updated: BtcMarket = {
      ...market,
      yesBid,
      yesAsk,
      lastPrice,
      winProbability,
      secondsLeft,
      isInTradingWindow,
    };
    this.cache.set(msg.market_ticker, updated);
    return updated;
  }

  /**
   * Re-fetch BRTI price and update every cached market's secondsLeft, window
   * membership, blended win probability, and settlement sample accumulator.
   * Call every 5 seconds from the agent's periodic loop.
   */
  async refreshBtcStates(): Promise<void> {
    const brtiState = await this.btcMonitor.getBtcState();
    for (const market of this.cache.values()) {
      const secondsLeft       = this.computeSecondsLeft(market.closeTime);
      const isInTradingWindow = this.inWindow(secondsLeft);

      // Settlement sample accumulator: collect BRTI values during the final 60s.
      let settlementSamples = market.settlementSamples;
      if (brtiState) {
        if (secondsLeft <= SETTLEMENT_WINDOW_SECONDS && secondsLeft > 0) {
          settlementSamples = [...settlementSamples, brtiState.currentPrice];
        } else if (secondsLeft > SETTLEMENT_WINDOW_SECONDS) {
          settlementSamples = []; // reset before settlement window begins
        }
      }

      const winProbability = brtiState
        ? this.blendedProbability(brtiState, market.threshold, settlementSamples, secondsLeft, market.yesBid, market.yesAsk, market.closeTime)
        : market.winProbability;

      this.cache.set(market.ticker, {
        ...market,
        brtiState:         brtiState ?? undefined,
        winProbability,
        secondsLeft,
        isInTradingWindow,
        settlementSamples,
      });
    }
  }

  /**
   * REST-based market discovery. Fetches all open KXBTC15M markets, updates
   * the cache, and returns which tickers are new vs removed.
   */
  async discoverMarkets(): Promise<{ newTickers: string[]; removedTickers: string[] }> {
    const rawMarkets = await this.fetchAllMarkets();
    const brtiState  = await this.btcMonitor.getBtcState();
    const freshSet   = new Set<string>();
    const newTickers: string[] = [];

    for (const m of rawMarkets) {
      freshSet.add(m.ticker);
      const parsed = this.parseMarket(m, brtiState);
      if (!parsed) continue;

      if (!this.cache.has(m.ticker)) newTickers.push(m.ticker);
      // Preserve live bid/ask and settlement samples from WS if already cached
      const existing = this.cache.get(m.ticker);
      this.cache.set(
        m.ticker,
        existing
          ? { ...parsed, yesBid: existing.yesBid, yesAsk: existing.yesAsk, settlementSamples: existing.settlementSamples }
          : parsed,
      );
    }

    const removedTickers: string[] = [];
    for (const ticker of this.cache.keys()) {
      if (!freshSet.has(ticker)) {
        this.cache.delete(ticker);
        removedTickers.push(ticker);
      }
    }

    return { newTickers, removedTickers };
  }

  private async fetchAllMarkets(): Promise<KalshiMarket[]> {
    const all: KalshiMarket[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.client.getMarkets({
        series_ticker: 'KXBTC15M',
        status: 'open',
        limit: 200,
        cursor,
      });
      all.push(...response.markets);
      cursor = response.cursor || undefined;
    } while (cursor);
    return all;
  }

  private parseMarket(m: KalshiMarket, brtiState: BrtiState | null): BtcMarket | null {
    const yesBid    = this.parsePrice(m.yes_bid_dollars, m.yes_bid);
    const yesAsk    = this.parsePrice(m.yes_ask_dollars, m.yes_ask);
    const noBid     = this.parsePrice(m.no_bid_dollars, m.no_bid);
    const noAsk     = this.parsePrice(m.no_ask_dollars, m.no_ask);
    const lastPrice = this.parsePrice(m.last_price_dollars, m.last_price);

    if (yesBid === 0 && yesAsk === 0 && lastPrice === 0) return null;

    const threshold         = m.floor_strike ?? 0;
    const closeTime         = new Date(m.close_time);
    const secondsLeft       = this.computeSecondsLeft(closeTime);
    const isInTradingWindow = this.inWindow(secondsLeft);
    const mid = yesBid > 0 && yesAsk > 0 ? (yesBid + yesAsk) / 2 : lastPrice;
    const winProbability = brtiState && threshold > 0
      ? this.blendedProbability(brtiState, threshold, [], secondsLeft, yesBid, yesAsk, closeTime)
      : mid;

    return {
      ticker:            m.ticker,
      eventTicker:       m.event_ticker ?? '',
      title:             m.title,
      status:            m.status,
      result:            m.result,
      yesBid,
      yesAsk,
      noBid,
      noAsk,
      lastPrice,
      volume:            m.volume_fp ? parseFloat(m.volume_fp) : 0,
      closeTime,
      winProbability,
      isInTradingWindow,
      secondsLeft,
      threshold,
      settlementSamples: [],
      brtiState:         brtiState ?? undefined,
    };
  }

  private blendedProbability(
    brtiState:         BrtiState,
    threshold:         number,
    settlementSamples: number[],
    secondsLeft:       number,
    bid:               number,
    ask:               number,
    closeTime:         Date,
  ): number {
    // Collect BRTI prices recorded since the start of this 15-minute interval.
    // Used to estimate realized per-second volatility specific to this window.
    const intervalStartMs = closeTime.getTime() - 15 * 60 * 1_000;
    const intervalPrices  = this.btcMonitor.getIntervalPrices(intervalStartMs);

    let modelProb: number;

    if (secondsLeft <= SETTLEMENT_WINDOW_SECONDS && secondsLeft > 0 && threshold > 0) {
      // Final 60s: model the expected 60-second closing average vs the 60-second opening
      // average (floor_strike). As BRTI samples accumulate the estimate sharpens.
      const accumulatedSeconds = Math.max(0, SETTLEMENT_WINDOW_SECONDS - secondsLeft);
      modelProb = this.probModel.calculateSettlement(
        brtiState.currentPrice,
        threshold,
        settlementSamples,
        accumulatedSeconds,
        secondsLeft,
        intervalPrices,
      );
    } else {
      const priceChangeFraction = threshold > 0
        ? (brtiState.currentPrice - threshold) / threshold
        : 0;
      modelProb = this.probModel.calculate(
        priceChangeFraction,
        secondsLeft,
        intervalPrices,
        brtiState.momentum,
      );
    }

    const marketMid = bid > 0 && ask > 0 ? (bid + ask) / 2 : modelProb;
    return BLEND_MARKET_WEIGHT * marketMid + (1 - BLEND_MARKET_WEIGHT) * modelProb;
  }

  private inWindow(secondsLeft: number): boolean {
    return secondsLeft >= TRADING_WINDOW_MIN_SECONDS && secondsLeft <= TRADING_WINDOW_MAX_SECONDS;
  }

  private computeSecondsLeft(closeTime: Date): number {
    return Math.max(0, (closeTime.getTime() - Date.now()) / 1000);
  }

  private parsePrice(dollarStr: string | undefined, intCents: number | undefined): number {
    if (dollarStr !== undefined) return parseFloat(dollarStr);
    if (intCents  !== undefined) return intCents / 100;
    return 0;
  }
}
