import { KalshiClient } from '../api/KalshiClient';
import { KalshiMarket } from '../api/types';
import { WsTickerMessage } from '../api/KalshiWebSocket';
import { BtcPriceMonitor, BtcMarketState } from './BtcPriceMonitor';
import { BtcProbabilityModel } from './BtcProbabilityModel';

// Enter in the final 60–300 seconds of the 15-min window.
// Below 60s: too close to expiry, low liquidity. Above 300s: outcome too uncertain.
export const TRADING_WINDOW_MIN_SECONDS = 60;
export const TRADING_WINDOW_MAX_SECONDS = 300;

// 30% market mid, 70% BTC Gaussian model — market mid captures flow from larger participants
const BLEND_MARKET_WEIGHT = 0.3;

export interface BtcMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  status: string;
  result?: string;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  lastPrice: number;
  volume: number;
  closeTime: Date;
  winProbability: number;
  isInTradingWindow: boolean;
  secondsLeft: number;
  btcState?: BtcMarketState;
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
    const btcState   = await this.btcMonitor.getBtcState();

    const markets = rawMarkets
      .map((m) => this.parseMarket(m, btcState))
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

  /** Returns the most recent BTC state attached to any cached market. */
  getLatestBtcState(): BtcMarketState | undefined {
    for (const m of this.cache.values()) {
      if (m.btcState) return m.btcState;
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

    const secondsLeft        = this.computeSecondsLeft(market.closeTime);
    const isInTradingWindow  = this.inWindow(secondsLeft);
    const winProbability     = market.btcState
      ? this.blendedProbability(market.btcState, secondsLeft, yesBid, yesAsk)
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
   * Re-fetch BTC price from Binance and update every cached market's
   * secondsLeft, window membership, and blended win probability.
   * Call every 5 seconds from the agent's periodic loop.
   */
  async refreshBtcStates(): Promise<void> {
    const btcState = await this.btcMonitor.getBtcState();
    for (const market of this.cache.values()) {
      const secondsLeft       = this.computeSecondsLeft(market.closeTime);
      const isInTradingWindow = this.inWindow(secondsLeft);
      const winProbability    = btcState
        ? this.blendedProbability(btcState, secondsLeft, market.yesBid, market.yesAsk)
        : market.winProbability;
      this.cache.set(market.ticker, {
        ...market,
        btcState:          btcState ?? undefined,
        winProbability,
        secondsLeft,
        isInTradingWindow,
      });
    }
  }

  /**
   * REST-based market discovery. Fetches all open KXBTC15M markets, updates
   * the cache, and returns which tickers are new vs removed.
   */
  async discoverMarkets(): Promise<{ newTickers: string[]; removedTickers: string[] }> {
    const rawMarkets = await this.fetchAllMarkets();
    const btcState   = await this.btcMonitor.getBtcState();
    const freshSet   = new Set<string>();
    const newTickers: string[] = [];

    for (const m of rawMarkets) {
      freshSet.add(m.ticker);
      const parsed = this.parseMarket(m, btcState);
      if (!parsed) continue;

      if (!this.cache.has(m.ticker)) newTickers.push(m.ticker);
      // Preserve live bid/ask from WS if already cached; REST snapshot may be stale
      const existing = this.cache.get(m.ticker);
      this.cache.set(
        m.ticker,
        existing ? { ...parsed, yesBid: existing.yesBid, yesAsk: existing.yesAsk } : parsed,
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

  private parseMarket(m: KalshiMarket, btcState: BtcMarketState | null): BtcMarket | null {
    const yesBid    = this.parsePrice(m.yes_bid_dollars, m.yes_bid);
    const yesAsk    = this.parsePrice(m.yes_ask_dollars, m.yes_ask);
    const noBid     = this.parsePrice(m.no_bid_dollars, m.no_bid);
    const noAsk     = this.parsePrice(m.no_ask_dollars, m.no_ask);
    const lastPrice = this.parsePrice(m.last_price_dollars, m.last_price);

    if (yesBid === 0 && yesAsk === 0 && lastPrice === 0) return null;

    const closeTime         = new Date(m.close_time);
    const secondsLeft       = this.computeSecondsLeft(closeTime);
    const isInTradingWindow = this.inWindow(secondsLeft);
    const mid = yesBid > 0 && yesAsk > 0 ? (yesBid + yesAsk) / 2 : lastPrice;
    const winProbability = btcState
      ? this.blendedProbability(btcState, secondsLeft, yesBid, yesAsk)
      : mid;

    return {
      ticker:           m.ticker,
      eventTicker:      m.event_ticker ?? '',
      title:            m.title,
      status:           m.status,
      result:           m.result,
      yesBid,
      yesAsk,
      noBid,
      noAsk,
      lastPrice,
      volume:           m.volume_fp ? parseFloat(m.volume_fp) : 0,
      closeTime,
      winProbability,
      isInTradingWindow,
      secondsLeft,
      btcState:         btcState ?? undefined,
    };
  }

  private blendedProbability(
    btcState: BtcMarketState,
    secondsLeft: number,
    bid: number,
    ask: number,
  ): number {
    const modelProb  = this.probModel.calculate(btcState.priceChangeFraction, secondsLeft);
    const marketMid  = bid > 0 && ask > 0 ? (bid + ask) / 2 : modelProb;
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
