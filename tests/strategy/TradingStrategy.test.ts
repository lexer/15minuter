import { TradingStrategy, ENTRY_PROBABILITY_THRESHOLD, EXIT_PROBABILITY_THRESHOLD } from '../../src/strategy/TradingStrategy';
import { BasketballMarket } from '../../src/services/MarketService';

function makeMarket(overrides: Partial<BasketballMarket> = {}): BasketballMarket {
  return {
    ticker: 'TEST-GAME-1',
    eventTicker: 'TEST-GAME',
    title: 'Lakers vs Celtics',
    status: 'active',
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

  describe('kellyFraction', () => {
    it('returns positive fraction when prob exceeds ask', () => {
      // prob=0.97, ask=0.94 → edge=(0.97-0.94)/(1-0.94)=0.5 → kelly=0.5*0.25=0.125
      expect(strategy.kellyFraction(0.97, 0.94)).toBeCloseTo(0.125);
    });

    it('returns zero when prob equals ask', () => {
      expect(strategy.kellyFraction(0.94, 0.94)).toBeCloseTo(0);
    });

    it('returns negative when ask exceeds prob', () => {
      expect(strategy.kellyFraction(0.92, 0.95)).toBeLessThan(0);
    });
  });

  describe('sizeContracts', () => {
    it('sizes proportionally to balance', () => {
      // prob=0.97, ask=0.94, balance=$1000 (100000 cents)
      // kelly=0.125, capped at 10%, spend=0.1*100000=10000 cents=$100
      // contracts=floor(10000/94)=106 → capped at MAX_CONTRACTS_PER_TRADE=50
      const { contracts } = strategy.sizeContracts(0.97, 0.94, 100_000);
      expect(contracts).toBe(50);
    });

    it('buys fewer contracts with smaller balance', () => {
      // balance=$20 (2000 cents), ask=0.94
      // kelly=0.125, capped at 10%, spend=200 cents
      // contracts=floor(200/94)=2
      const { contracts } = strategy.sizeContracts(0.97, 0.94, 2_000);
      expect(contracts).toBe(2);
    });

    it('returns 0 contracts with no edge', () => {
      const { contracts, reason } = strategy.sizeContracts(0.94, 0.97, 100_000);
      expect(contracts).toBe(0);
      expect(reason).toMatch(/No edge/);
    });

    it('scales down as balance shrinks', () => {
      const large = strategy.sizeContracts(0.97, 0.94, 50_000).contracts;
      const small = strategy.sizeContracts(0.97, 0.94, 5_000).contracts;
      expect(large).toBeGreaterThan(small);
    });
  });

  describe('evaluateEntry', () => {
    it('returns buy when probability exceeds threshold with positive edge', () => {
      // prob=0.97 > ask=0.94 → positive edge
      const market = makeMarket({ winProbability: 0.97, yesAsk: 0.94 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.suggestedContracts).toBeGreaterThan(0);
    });

    it('returns hold when probability is below entry threshold', () => {
      const market = makeMarket({ winProbability: 0.85 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('hold');
    });

    it('returns hold at exactly the threshold', () => {
      const market = makeMarket({ winProbability: ENTRY_PROBABILITY_THRESHOLD });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('hold');
    });

    it('returns hold when market status is not tradeable', () => {
      const market = makeMarket({ status: 'closed', winProbability: 0.99 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('hold');
    });

    it('accepts active status as tradeable', () => {
      const market = makeMarket({ status: 'active', winProbability: 0.97, yesAsk: 0.94 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('buy');
    });

    it('returns hold when balance is too small for 1 contract', () => {
      const market = makeMarket({ winProbability: 0.97, yesAsk: 0.94 });
      // balance=50 cents → 10% = 5 cents, can't afford $0.94
      const signal = strategy.evaluateEntry(market, 50);
      expect(signal.action).toBe('hold');
    });

    it('caps contracts at MAX_CONTRACTS_PER_TRADE', () => {
      const market = makeMarket({ winProbability: 0.99, yesAsk: 0.01 });
      const signal = strategy.evaluateEntry(market, 10_000_000);
      expect(signal.suggestedContracts).toBeLessThanOrEqual(50);
    });

    it('returns hold when ask has no edge over prob', () => {
      // prob=0.93 but ask=0.95 → no edge
      const market = makeMarket({ winProbability: 0.93, yesAsk: 0.95 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('hold');
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

    it('returns sell when market is not tradeable', () => {
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
      expect(strategy.calculatePnl(0.92, 0.97, 10)).toBeCloseTo(0.5);
    });

    it('calculates negative PnL on a losing trade', () => {
      expect(strategy.calculatePnl(0.92, 0.80, 10)).toBeCloseTo(-1.2);
    });
  });
});
