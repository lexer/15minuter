import { MarketService } from '../../src/services/MarketService';
import { KalshiMarket } from '../../src/api/types';

function mockClient(markets: Partial<KalshiMarket>[] = [], events = []): any {
  return {
    getMarkets: jest.fn().mockResolvedValue({ markets, cursor: '' }),
    getEvents: jest.fn().mockResolvedValue({ events, cursor: '' }),
    getMarket: jest.fn().mockResolvedValue({
      market: markets[0] ?? makeRawMarket(),
    }),
  };
}

function makeRawMarket(overrides: Partial<KalshiMarket> = {}): KalshiMarket {
  return {
    ticker: 'KXNBA-LAL-BOS-2024',
    event_ticker: 'KXNBA-LAL-BOS',
    title: 'Lakers will win the game vs Celtics',
    status: 'open',
    yes_bid: 92,
    yes_ask: 94,
    no_bid: 6,
    no_ask: 8,
    last_price: 93,
    volume: 500,
    open_interest: 200,
    close_time: new Date(Date.now() + 7200000).toISOString(),
    expiration_time: new Date(Date.now() + 7200000).toISOString(),
    can_close_early: true,
    rules_primary: 'Will the Lakers win the game?',
    rules_secondary: '',
    category: 'sports',
    series_ticker: 'KXNBA',
    ...overrides,
  };
}

describe('MarketService', () => {
  it('returns basketball winner markets', async () => {
    const client = mockClient([makeRawMarket()]);
    const service = new MarketService(client);
    const markets = await service.getLiveBasketballMarkets();
    expect(markets.length).toBeGreaterThan(0);
    expect(markets[0].ticker).toBe('KXNBA-LAL-BOS-2024');
  });

  it('filters out non-winner markets', async () => {
    const propMarket = makeRawMarket({
      ticker: 'NBA-POINTS-LAL',
      title: 'Lakers total points over 110',
    });
    const client = mockClient([propMarket]);
    const service = new MarketService(client);
    const markets = await service.getLiveBasketballMarkets();
    expect(markets).toHaveLength(0);
  });

  it('calculates win probability from mid-price', async () => {
    const raw = makeRawMarket({ yes_bid: 90, yes_ask: 94 });
    const client = mockClient([raw]);
    const service = new MarketService(client);
    const markets = await service.getLiveBasketballMarkets();
    // mid = (0.90 + 0.94) / 2 = 0.92
    expect(markets[0].winProbability).toBeCloseTo(0.92);
  });

  it('deduplicates markets from series and events', async () => {
    const raw = makeRawMarket();
    const client = mockClient([raw]);
    const service = new MarketService(client);
    const markets = await service.getLiveBasketballMarkets();
    const tickers = markets.map((m) => m.ticker);
    const unique = [...new Set(tickers)];
    expect(unique.length).toBe(tickers.length);
  });
});
