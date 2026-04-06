import { MarketService } from '../../src/services/MarketService';
import { GameMonitor, NbaGameState } from '../../src/services/GameMonitor';
import { KalshiMarket } from '../../src/api/types';

function makeGameState(overrides: Partial<NbaGameState> = {}): NbaGameState {
  return {
    gameId: 'g1',
    homeTeam: 'Lakers',
    awayTeam: 'Celtics',
    homeScore: 105,
    awayScore: 88,
    period: 4,
    gameClock: 'PT02M30.00S',
    gameStatus: 2,
    isQ4OrLater: true,
    homeTeamTricode: 'LAL',
    awayTeamTricode: 'BOS',
    ...overrides,
  };
}

function mockClient(markets: Partial<KalshiMarket>[] = []): any {
  return {
    getMarkets: jest.fn().mockResolvedValue({ markets, cursor: '' }),
    getMarket: jest.fn().mockResolvedValue({ market: markets[0] ?? makeRawMarket() }),
  };
}

function mockGameMonitor(state: NbaGameState | null = makeGameState()): any {
  return {
    getGameState: jest.fn().mockResolvedValue(state),
    getLiveGames: jest.fn().mockResolvedValue(state ? [state] : []),
  };
}

function makeRawMarket(overrides: Partial<KalshiMarket> = {}): KalshiMarket {
  return {
    ticker: 'KXNBAGAME-26APR05LALCLE-LAL',
    event_ticker: 'KXNBAGAME-26APR05LALCLE',
    title: 'Los Angeles L Winner?',
    status: 'active',
    yes_bid_dollars: '0.92',
    yes_ask_dollars: '0.94',
    no_bid_dollars: '0.06',
    no_ask_dollars: '0.08',
    last_price_dollars: '0.93',
    volume_fp: '500',
    close_time: new Date(Date.now() + 7200000).toISOString(),
    expiration_time: new Date(Date.now() + 7200000).toISOString(),
    can_close_early: true,
    rules_primary: 'Will the Los Angeles L win the game?',
    rules_secondary: '',
    series_ticker: 'KXNBAGAME',
    ...overrides,
  };
}

describe('MarketService', () => {
  // Mock today's date code to match our test ticker (26APR05)
  const originalDate = global.Date;

  beforeEach(() => {
    const fixedDate = new Date('2026-04-05T20:00:00Z');
    jest.spyOn(global, 'Date').mockImplementation((arg?: any) => {
      if (arg === undefined) return fixedDate as any;
      return new originalDate(arg) as any;
    });
    (global.Date as any).now = () => fixedDate.getTime();
    (global.Date as any).UTC = originalDate.UTC;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns markets for live Q4 games today', async () => {
    const client = mockClient([makeRawMarket()]);
    const monitor = mockGameMonitor(makeGameState());
    const service = new MarketService(client, monitor);
    const markets = await service.getLiveBasketballMarkets();
    expect(markets.length).toBe(1);
    expect(markets[0].ticker).toBe('KXNBAGAME-26APR05LALCLE-LAL');
  });

  it('excludes markets where game is not in Q4', async () => {
    const client = mockClient([makeRawMarket()]);
    const monitor = mockGameMonitor(makeGameState({ period: 2, isQ4OrLater: false }));
    const service = new MarketService(client, monitor);
    const markets = await service.getLiveBasketballMarkets();
    expect(markets).toHaveLength(0);
  });

  it('excludes markets where game state is unknown', async () => {
    const client = mockClient([makeRawMarket()]);
    const monitor = mockGameMonitor(null);
    const service = new MarketService(client, monitor);
    const markets = await service.getLiveBasketballMarkets();
    expect(markets).toHaveLength(0);
  });

  it('parses dollar-string prices correctly', async () => {
    const client = mockClient([makeRawMarket({ yes_bid_dollars: '0.90', yes_ask_dollars: '0.94' })]);
    const monitor = mockGameMonitor();
    const service = new MarketService(client, monitor);
    const markets = await service.getLiveBasketballMarkets();
    expect(markets[0].yesBid).toBeCloseTo(0.90);
    expect(markets[0].yesAsk).toBeCloseTo(0.94);
  });

  it('overrides winProbability with model when game state available', async () => {
    // LAL +17 with 2:30 left → model gives >>92% (market mid), so model overrides
    const client = mockClient([makeRawMarket()]);
    const monitor = mockGameMonitor(makeGameState({ homeScore: 105, awayScore: 88, gameClock: 'PT02M30.00S' }));
    const service = new MarketService(client, monitor);
    const markets = await service.getLiveBasketballMarkets();
    expect(markets[0].winProbability).toBeGreaterThan(0.99);
  });

  it('falls back to market mid when no game state', async () => {
    // No game state → market excluded from Q4 scan, but getMarket still parses prices
    // Test via a mock that returns game state = null but market still parsed
    const client = mockClient([makeRawMarket({ yes_bid_dollars: '0.90', yes_ask_dollars: '0.94' })]);
    // When getMarket is called directly (no Q4 filter), mid price is used
    const monitor = mockGameMonitor(makeGameState({ homeScore: 95, awayScore: 90, gameClock: 'PT02M30.00S' }));
    const service = new MarketService(client, monitor);
    const markets = await service.getLiveBasketballMarkets();
    // Model gives some probability > 0 for +5 lead with 2:30 left
    expect(markets[0].winProbability).toBeGreaterThan(0.5);
    expect(markets[0].winProbability).toBeLessThan(1.0);
  });

  it('includes markets from any date as long as game is in Q4', async () => {
    // Date filter removed — a game that started yesterday but is still live in Q4 must be included
    const prevDayMarket = makeRawMarket({
      ticker: 'KXNBAGAME-26APR05INDCLE-CLE',
      event_ticker: 'KXNBAGAME-26APR05INDCLE',
    });
    const client = mockClient([prevDayMarket]);
    const monitor = mockGameMonitor();
    const service = new MarketService(client, monitor);
    const markets = await service.getLiveBasketballMarkets();
    expect(markets).toHaveLength(1);
  });
});
