import { KalshiClient } from '../api/KalshiClient';
import { KalshiMarket } from '../api/types';

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
}

const BASKETBALL_SERIES = ['KXNBA', 'NBA'];

export class MarketService {
  constructor(private readonly client: KalshiClient) {}

  async getLiveBasketballMarkets(): Promise<BasketballMarket[]> {
    const markets: BasketballMarket[] = [];

    for (const series of BASKETBALL_SERIES) {
      try {
        const response = await this.client.getMarkets({
          series_ticker: series,
          status: 'open',
          limit: 100,
        });
        const parsed = response.markets
          .filter((m) => this.isGameWinnerMarket(m))
          .map((m) => this.parseMarket(m));
        for (const p of parsed) {
          if (!markets.find((x) => x.ticker === p.ticker)) {
            markets.push(p);
          }
        }
      } catch {
        // Series may not exist; continue
      }
    }

    // Also search events by category
    try {
      const eventsResp = await this.client.getEvents({
        status: 'open',
        limit: 100,
        with_nested_markets: true,
      });
      for (const event of eventsResp.events) {
        if (this.isBasketballEvent(event.title, event.series_ticker)) {
          for (const m of event.markets ?? []) {
            if (this.isGameWinnerMarket(m)) {
              const parsed = this.parseMarket(m);
              if (!markets.find((x) => x.ticker === parsed.ticker)) {
                markets.push(parsed);
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }

    return markets;
  }

  async getMarket(ticker: string): Promise<BasketballMarket> {
    const resp = await this.client.getMarket(ticker);
    return this.parseMarket(resp.market);
  }

  private isBasketballEvent(title: string, seriesTicker: string): boolean {
    const t = title.toLowerCase();
    const s = seriesTicker.toLowerCase();
    return (
      t.includes('nba') ||
      t.includes('basketball') ||
      s.includes('nba') ||
      s.includes('kxnba')
    );
  }

  private isGameWinnerMarket(m: KalshiMarket): boolean {
    const title = m.title.toLowerCase();
    const ticker = m.ticker.toLowerCase();
    const rules = (m.rules_primary ?? '').toLowerCase();

    // Must be a game winner / will win market, not points/spread/other props
    const isWinner =
      title.includes('win') ||
      title.includes('winner') ||
      ticker.includes('winner') ||
      rules.includes('win the game');

    const isNotProp =
      !title.includes('points') &&
      !title.includes('score') &&
      !title.includes('spread') &&
      !title.includes('total') &&
      !title.includes('rebounds') &&
      !title.includes('assists') &&
      !title.includes('quarter') &&
      !title.includes('half');

    return isWinner && isNotProp;
  }

  private parseMarket(m: KalshiMarket): BasketballMarket {
    const yesBid = m.yes_bid / 100;
    const yesAsk = m.yes_ask / 100;
    const lastPrice = m.last_price / 100;

    // Win probability estimated from mid-price of yes side
    const mid = (yesBid + yesAsk) / 2;
    const winProbability = mid > 0 ? mid : lastPrice;

    return {
      ticker: m.ticker,
      eventTicker: m.event_ticker,
      title: m.title,
      status: m.status,
      yesBid,
      yesAsk,
      noBid: m.no_bid / 100,
      noAsk: m.no_ask / 100,
      lastPrice,
      volume: m.volume,
      closeTime: new Date(m.close_time),
      winProbability,
    };
  }
}
