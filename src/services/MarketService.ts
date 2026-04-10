import { KalshiClient } from '../api/KalshiClient';
import { KalshiMarket } from '../api/types';
import { WsTickerMessage } from '../api/KalshiWebSocket';
import { GameMonitor, NbaGameState } from './GameMonitor';
import { WinProbabilityModel } from './WinProbabilityModel';

export interface BasketballMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  status: string;
  result?: string; // set by Kalshi when market settles, e.g. 'yes' or 'no'
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  lastPrice: number;
  volume: number;
  closeTime: Date;
  winProbability: number;
  isQ4: boolean;
  gameState?: NbaGameState;
}

// Map Kalshi 3-letter team codes (from event ticker) to NBA tricodes
const KALSHI_TO_NBA: Record<string, string> = {
  ATL: 'ATL', BKN: 'BKN', BOS: 'BOS', CHA: 'CHA', CHI: 'CHI',
  CLE: 'CLE', DAL: 'DAL', DEN: 'DEN', DET: 'DET', GSW: 'GSW',
  HOU: 'HOU', IND: 'IND', LAC: 'LAC', LAL: 'LAL', MEM: 'MEM',
  MIA: 'MIA', MIL: 'MIL', MIN: 'MIN', NOP: 'NOP', NYK: 'NYK',
  OKC: 'OKC', ORL: 'ORL', PHI: 'PHI', PHX: 'PHX', POR: 'POR',
  SAC: 'SAC', SAS: 'SAS', TOR: 'TOR', UTA: 'UTA', WAS: 'WAS',
};

// 30% market mid, 70% Gaussian model — calibrated on 2026-04-06 game data
const BLEND_MARKET_WEIGHT = 0.3;

export class MarketService {
  private readonly winModel  = new WinProbabilityModel();
  private readonly cache     = new Map<string, BasketballMarket>();

  constructor(
    private readonly client:      KalshiClient,
    private readonly gameMonitor: GameMonitor,
  ) {}

  /** Returns all live KXNBAGAME markets regardless of quarter, with isQ4 flag set. */
  async getAllLiveBasketballMarkets(): Promise<BasketballMarket[]> {
    const rawMarkets = await this.fetchAllMarkets();

    const results = await Promise.all(
      rawMarkets.map(async (m) => {
        const parsed = this.parseMarket(m);
        if (!parsed) return null;

        const codes = this.extractTeamCodes(m.event_ticker ?? '');
        if (codes) {
          const gameState = await this.gameMonitor.getGameState(
            KALSHI_TO_NBA[codes.team1] ?? codes.team1,
            KALSHI_TO_NBA[codes.team2] ?? codes.team2,
          );
          parsed.gameState = gameState ?? undefined;
          if (gameState) {
            const teamCode = this.extractMarketTeamCode(m.ticker);
            parsed.winProbability = this.modelWinProbability(gameState, codes, teamCode, parsed.yesBid, parsed.yesAsk) ?? parsed.winProbability;
            parsed.isQ4 = gameState.isQ4OrLater;
          }
        }

        return parsed;
      }),
    );

    const markets = results.filter((m): m is BasketballMarket => m !== null);
    // Keep cache in sync so WS-based paths have a starting state
    for (const m of markets) this.cache.set(m.ticker, m);
    return markets;
  }

  /** Fetches all pages of open KXNBAGAME markets. */
  private async fetchAllMarkets(): Promise<import('../api/types').KalshiMarket[]> {
    const all: import('../api/types').KalshiMarket[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.client.getMarkets({
        series_ticker: 'KXNBAGAME',
        status: 'open',
        limit: 200,
        cursor,
      });
      all.push(...response.markets);
      cursor = response.cursor || undefined;
    } while (cursor);
    return all;
  }

  /** Returns only markets where the game is in Q4 or later. */
  async getLiveBasketballMarkets(): Promise<BasketballMarket[]> {
    return (await this.getAllLiveBasketballMarkets()).filter((m) => m.isQ4);
  }

  // ── Cache-based API (used by event-driven agent) ──────────────────────────

  /** All currently cached markets. */
  getCachedMarkets(): BasketballMarket[] {
    return [...this.cache.values()];
  }

  /** Cached markets where the game is in Q4 or later. */
  getCachedQ4Markets(): BasketballMarket[] {
    return [...this.cache.values()].filter((m) => m.isQ4);
  }

  /**
   * Apply a real-time WS ticker update to the cache.
   * Updates bid/ask and recomputes blended win probability.
   * Returns the updated market, or null if the ticker is not in cache.
   */
  applyTickerUpdate(msg: WsTickerMessage): BasketballMarket | null {
    const market = this.cache.get(msg.market_ticker);
    if (!market) return null;

    const yesBid    = msg.yes_bid_dollars ?? market.yesBid;
    const yesAsk    = msg.yes_ask_dollars ?? market.yesAsk;
    const lastPrice = msg.price_dollars   ?? market.lastPrice;

    let winProbability = market.winProbability;
    if (market.gameState) {
      const codes    = this.extractTeamCodes(market.eventTicker);
      const teamCode = this.extractMarketTeamCode(market.ticker);
      if (codes) {
        winProbability = this.modelWinProbability(
          market.gameState, codes, teamCode, yesBid, yesAsk,
        ) ?? winProbability;
      }
    }

    const updated: BasketballMarket = { ...market, yesBid, yesAsk, lastPrice, winProbability };
    this.cache.set(msg.market_ticker, updated);
    return updated;
  }

  /**
   * Re-fetch NBA game states and update every cached market's game state +
   * win probability. Call periodically (every 5 s).
   */
  async refreshGameStates(): Promise<void> {
    await Promise.all([...this.cache.values()].map(async (market) => {
      const codes = this.extractTeamCodes(market.eventTicker);
      if (!codes) return;

      const gameState = await this.gameMonitor.getGameState(
        KALSHI_TO_NBA[codes.team1] ?? codes.team1,
        KALSHI_TO_NBA[codes.team2] ?? codes.team2,
      );

      const teamCode         = this.extractMarketTeamCode(market.ticker);
      let winProbability     = market.winProbability;
      let isQ4               = market.isQ4;

      if (gameState) {
        winProbability = this.modelWinProbability(
          gameState, codes, teamCode, market.yesBid, market.yesAsk,
        ) ?? winProbability;
        isQ4 = gameState.isQ4OrLater;
      }

      this.cache.set(market.ticker, {
        ...market,
        gameState: gameState ?? undefined,
        winProbability,
        isQ4,
      });
    }));
  }

  /**
   * REST-based market discovery. Fetches all open KXNBAGAME markets, updates
   * the cache, and returns which tickers are new vs removed.
   */
  async discoverMarkets(): Promise<{ newTickers: string[]; removedTickers: string[] }> {
    const rawMarkets  = await this.fetchAllMarkets();
    const freshSet    = new Set<string>();
    const newTickers: string[] = [];

    await Promise.all(rawMarkets.map(async (m) => {
      freshSet.add(m.ticker);
      const parsed = this.parseMarket(m);
      if (!parsed) return;

      const codes = this.extractTeamCodes(m.event_ticker ?? '');
      if (codes) {
        const gameState = await this.gameMonitor.getGameState(
          KALSHI_TO_NBA[codes.team1] ?? codes.team1,
          KALSHI_TO_NBA[codes.team2] ?? codes.team2,
        );
        parsed.gameState = gameState ?? undefined;
        if (gameState) {
          const teamCode     = this.extractMarketTeamCode(m.ticker);
          parsed.winProbability = this.modelWinProbability(
            gameState, codes, teamCode, parsed.yesBid, parsed.yesAsk,
          ) ?? parsed.winProbability;
          parsed.isQ4 = gameState.isQ4OrLater;
        }
      }

      if (!this.cache.has(m.ticker)) newTickers.push(m.ticker);
      // Preserve live bid/ask from WS if already cached; REST snapshot may be stale
      const existing = this.cache.get(m.ticker);
      this.cache.set(m.ticker, existing
        ? { ...parsed, yesBid: existing.yesBid, yesAsk: existing.yesAsk }
        : parsed,
      );
    }));

    const removedTickers: string[] = [];
    for (const ticker of this.cache.keys()) {
      if (!freshSet.has(ticker)) {
        this.cache.delete(ticker);
        removedTickers.push(ticker);
      }
    }

    return { newTickers, removedTickers };
  }

  async getMarket(ticker: string): Promise<BasketballMarket> {
    const resp = await this.client.getMarket(ticker);
    const parsed = this.parseMarket(resp.market);
    if (!parsed) throw new Error(`Could not parse market ${ticker}`);

    const codes = this.extractTeamCodes(resp.market.event_ticker ?? '');
    if (codes) {
      const gameState = await this.gameMonitor.getGameState(
        KALSHI_TO_NBA[codes.team1] ?? codes.team1,
        KALSHI_TO_NBA[codes.team2] ?? codes.team2,
      );
      parsed.gameState = gameState ?? undefined;
      if (gameState) {
        const teamCode = this.extractMarketTeamCode(resp.market.ticker);
        parsed.winProbability = this.modelWinProbability(gameState, codes, teamCode, parsed.yesBid, parsed.yesAsk) ?? parsed.winProbability;
      }
    }

    return parsed;
  }

  // Extract two 3-letter team codes from event ticker e.g. "KXNBAGAME-26APR05HOUGSW" → {team1:"HOU", team2:"GSW"}
  private extractTeamCodes(
    eventTicker: string,
  ): { team1: string; team2: string } | null {
    // Match: 2-digit year + 3-letter month + 2-digit day + 3-letter team + 3-letter team
    const match = eventTicker.match(/\d{2}[A-Z]{3}\d{2}([A-Z]{3})([A-Z]{3})$/);
    if (!match) return null;
    return { team1: match[1], team2: match[2] };
  }

  /** Extract team code from market ticker, e.g. "KXNBAGAME-26APR05TORBOS-BOS" → "BOS" */
  private extractMarketTeamCode(ticker: string): string | null {
    const m = ticker.match(/-([A-Z]{3})$/);
    return m ? m[1] : null;
  }

  /**
   * Compute win probability for the market team using the score/time model.
   * Returns null if insufficient data.
   */
  private modelWinProbability(
    gameState: NbaGameState,
    codes: { team1: string; team2: string },
    marketTeamCode: string | null,
    bid: number,
    ask: number,
  ): number | null {
    if (!marketTeamCode || !gameState.gameClock) return null;

    const nbaTeam1 = KALSHI_TO_NBA[codes.team1] ?? codes.team1;
    const nbaTeam2 = KALSHI_TO_NBA[codes.team2] ?? codes.team2;

    // Determine score differential from this team's perspective
    let scoreDiff: number;
    if (gameState.homeTeamTricode === nbaTeam1 && marketTeamCode === codes.team1) {
      scoreDiff = gameState.homeScore - gameState.awayScore;
    } else if (gameState.awayTeamTricode === nbaTeam1 && marketTeamCode === codes.team1) {
      scoreDiff = gameState.awayScore - gameState.homeScore;
    } else if (gameState.homeTeamTricode === nbaTeam2 && marketTeamCode === codes.team2) {
      scoreDiff = gameState.homeScore - gameState.awayScore;
    } else if (gameState.awayTeamTricode === nbaTeam2 && marketTeamCode === codes.team2) {
      scoreDiff = gameState.awayScore - gameState.homeScore;
    } else {
      return null;
    }

    const secondsLeft = WinProbabilityModel.secondsRemaining(gameState.period, gameState.gameClock);

    // Determine which team is the market team to pass the right timeout counts
    const marketTeamIsHome =
      (gameState.homeTeamTricode === nbaTeam1 && marketTeamCode === codes.team1) ||
      (gameState.homeTeamTricode === nbaTeam2 && marketTeamCode === codes.team2);
    const marketTeamTimeouts = marketTeamIsHome
      ? gameState.homeTimeoutsRemaining
      : gameState.awayTimeoutsRemaining;
    const opposingTimeouts = marketTeamIsHome
      ? gameState.awayTimeoutsRemaining
      : gameState.homeTimeoutsRemaining;

    const modelProb = this.winModel.calculate(scoreDiff, secondsLeft, marketTeamTimeouts, opposingTimeouts);

    // Blend model probability with market mid-price to capture information the
    // Gaussian model misses (momentum, coaching, foul trouble, rotations).
    // Weight calibrated via backtest on 2026-04-06 games: w=0.3 exits losing
    // positions ~2 min earlier with no false exits on winning positions.
    const marketMid = (bid + ask) / 2;
    return BLEND_MARKET_WEIGHT * marketMid + (1 - BLEND_MARKET_WEIGHT) * modelProb;
  }

  private parseMarket(m: KalshiMarket): BasketballMarket | null {
    // Parse prices — prefer dollar string fields over integer fields
    const yesBid = this.parsePrice(m.yes_bid_dollars, m.yes_bid);
    const yesAsk = this.parsePrice(m.yes_ask_dollars, m.yes_ask);
    const noBid = this.parsePrice(m.no_bid_dollars, m.no_bid);
    const noAsk = this.parsePrice(m.no_ask_dollars, m.no_ask);
    const lastPrice = this.parsePrice(m.last_price_dollars, m.last_price);

    if (yesBid === null && yesAsk === null && lastPrice === null) return null;

    const bid = yesBid ?? 0;
    const ask = yesAsk ?? 0;
    const last = lastPrice ?? 0;

    // Win probability: mid of bid/ask, fall back to last price
    const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
    const winProbability = mid > 0 ? mid : last;

    return {
      ticker: m.ticker,
      eventTicker: m.event_ticker ?? '',
      title: m.title,
      status: m.status,
      result: m.result,
      yesBid: bid,
      yesAsk: ask,
      noBid,
      noAsk,
      lastPrice: last,
      volume: m.volume_fp ? parseFloat(m.volume_fp) : 0,
      closeTime: new Date(m.close_time),
      winProbability,
      isQ4: false, // set later once game state is attached
    };
  }

  private parsePrice(dollarStr: string | undefined, intCents: number | undefined): number {
    if (dollarStr !== undefined) return parseFloat(dollarStr);
    if (intCents !== undefined) return intCents / 100;
    return 0;
  }
}
