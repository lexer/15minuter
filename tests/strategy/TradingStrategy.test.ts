import { TradingStrategy, ENTRY_PROBABILITY_THRESHOLD, EXIT_PROBABILITY_THRESHOLD } from '../../src/strategy/TradingStrategy';
import { BasketballMarket } from '../../src/services/MarketService';

function makeMarket(overrides: Partial<BasketballMarket> = {}): BasketballMarket {
  return {
    ticker: 'TEST-GAME-1',
    eventTicker: 'TEST-GAME',
    title: 'Lakers vs Celtics',
    status: 'open',
    yesBid: 0.92,
    yesAsk: 0.94,
    noBid: 0.06,
    noAsk: 0.08,
    lastPrice: 0.93,
    volume: 1000,
    closeTime: new Date(Date.now() + 3_600_000),
    winProbability: 0.93,
    ...overrides,
  };
}

describe('TradingStrategy', () => {
  let strategy: TradingStrategy;

  beforeEach(() => {
    strategy = new TradingStrategy();
  });

  describe('evaluateEntry', () => {
    it('returns buy when probability exceeds threshold', () => {
      const market = makeMarket({ winProbability: 0.95 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.suggestedContracts).toBeGreaterThan(0);
    });

    it('returns hold when probability is below threshold', () => {
      const market = makeMarket({ winProbability: 0.85 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('hold');
    });

    it('returns hold at exactly the threshold', () => {
      const market = makeMarket({ winProbability: ENTRY_PROBABILITY_THRESHOLD });
      const signal = strategy.evaluateEntry(market, 100_000);
      // Exactly at threshold is not above it
      expect(signal.action).toBe('hold');
    });

    it('returns hold when market is closed', () => {
      const market = makeMarket({ status: 'closed', winProbability: 0.99 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('hold');
    });

    it('returns hold when balance insufficient', () => {
      const market = makeMarket({ winProbability: 0.95, yesAsk: 0.94 });
      // Only 50 cents — can't buy even 1 contract at $0.94
      const signal = strategy.evaluateEntry(market, 50);
      expect(signal.action).toBe('hold');
    });

    it('caps contracts at MAX_CONTRACTS_PER_TRADE', () => {
      const market = makeMarket({ winProbability: 0.95, yesAsk: 0.01 });
      const signal = strategy.evaluateEntry(market, 1_000_000);
      expect(signal.suggestedContracts).toBeLessThanOrEqual(10);
    });
  });

  describe('evaluateExit', () => {
    it('returns sell when probability drops below threshold', () => {
      const market = makeMarket({ winProbability: 0.75 });
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('sell');
    });

    it('returns hold when probability stays above threshold', () => {
      const market = makeMarket({ winProbability: 0.88 });
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('hold');
    });

    it('returns sell when market is closed', () => {
      const market = makeMarket({ status: 'closed', winProbability: 0.99 });
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('sell');
    });

    it('returns sell at exactly exit threshold', () => {
      const market = makeMarket({ winProbability: EXIT_PROBABILITY_THRESHOLD });
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('sell');
    });
  });

  describe('calculatePnl', () => {
    it('calculates positive PnL on a winning trade', () => {
      const pnl = strategy.calculatePnl(0.92, 0.97, 10);
      expect(pnl).toBeCloseTo(0.5);
    });

    it('calculates negative PnL on a losing trade', () => {
      const pnl = strategy.calculatePnl(0.92, 0.80, 10);
      expect(pnl).toBeCloseTo(-1.2);
    });
  });
});
