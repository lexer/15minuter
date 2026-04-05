import { KalshiClient } from '../api/KalshiClient';
import { KalshiMarket } from '../api/types';
import { GameMonitor, NbaGameState } from './GameMonitor';

export interface BasketballMarket {
  ticker: string;
  eventTicker: string;
  title: string;
  status: string;
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  lastPrice: number;
  volume: number;
  closeTime: Date;
  winProbability: number;
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

export class MarketService {
  constructor(
    private readonly client: KalshiClient,
    private readonly gameMonitor: GameMonitor,
  ) {}

  async getLiveBasketballMarkets(): Promise<BasketballMarket[]> {
    const response = await this.client.getMarkets({
      series_ticker: 'KXNBAGAME',
      status: 'open',
      limit: 200,
    });

    const today = this.getTodayDateCode();
    const markets: BasketballMarket[] = [];

    for (const m of response.markets) {
      // Only consider today's games
      if (!m.event_ticker?.includes(today)) continue;

      const parsed = this.parseMarket(m);
      if (!parsed) continue;

      // Attach live game state for Q4 detection
      const codes = this.extractTeamCodes(m.event_ticker ?? '');
      if (codes) {
        const gameState = await this.gameMonitor.getGameState(
          KALSHI_TO_NBA[codes.team1] ?? codes.team1,
          KALSHI_TO_NBA[codes.team2] ?? codes.team2,
        );
        parsed.gameState = gameState ?? undefined;
      }

      // Only include markets where game is in Q4 or later
      if (parsed.gameState?.isQ4OrLater) {
        markets.push(parsed);
      }
    }

    return markets;
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
    }

    return parsed;
  }

  private getTodayDateCode(): string {
    const now = new Date();
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const yy = String(now.getUTCFullYear()).slice(2);
    const mon = months[now.getUTCMonth()];
    const dd = String(now.getUTCDate()).padStart(2, '0');
    return `${yy}${mon}${dd}`;
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
      yesBid: bid,
      yesAsk: ask,
      noBid,
      noAsk,
      lastPrice: last,
      volume: m.volume_fp ? parseFloat(m.volume_fp) : (m.volume ?? 0),
      closeTime: new Date(m.close_time),
      winProbability,
    };
  }

  private parsePrice(dollarStr: string | undefined, intCents: number | undefined): number {
    if (dollarStr !== undefined) return parseFloat(dollarStr);
    if (intCents !== undefined) return intCents / 100;
    return 0;
  }
}
