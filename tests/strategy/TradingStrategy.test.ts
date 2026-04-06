import { TradingStrategy, ENTRY_PROBABILITY_THRESHOLD, EXIT_PROBABILITY_THRESHOLD, EXIT_PROBABILITY_GUARD, EXIT_CONFIRMATION_TICKS } from '../../src/strategy/TradingStrategy';
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
    it('returns buy when ask exceeds threshold', () => {
      // ask=0.94 > 0.90 → buy at 25% of balance
      const market = makeMarket({ yesAsk: 0.94 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.suggestedContracts).toBeGreaterThan(0);
      expect(signal.suggestedLimitPrice).toBe(0.94);
    });

    it('returns hold when ask is at or below entry threshold', () => {
      const market = makeMarket({ yesAsk: 0.85 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('hold');
    });

    it('returns hold at exactly the ask threshold', () => {
      const market = makeMarket({ yesAsk: ENTRY_PROBABILITY_THRESHOLD });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('hold');
    });

    it('returns hold when market status is not tradeable', () => {
      const market = makeMarket({ status: 'closed', yesAsk: 0.99 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('hold');
    });

    it('accepts active status as tradeable', () => {
      const market = makeMarket({ status: 'active', yesAsk: 0.94 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('buy');
    });

    it('returns hold when balance is too small for 1 contract', () => {
      const market = makeMarket({ yesAsk: 0.94 });
      // balance=50 cents → 25% = 12 cents, can't afford $0.94
      const signal = strategy.evaluateEntry(market, 50);
      expect(signal.action).toBe('hold');
    });

    it('sizes to 25% of balance', () => {
      // ask=0.91, balance=$1000 (100_000 cents) → 25% = $250 (25_000 cents) → floor(25000/91) = 274
      const market = makeMarket({ yesAsk: 0.91 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.suggestedContracts).toBe(274);
    });

    it('sizes to 25% of balance at $1000 (current budget)', () => {
      // ask=0.95, balance=$1000 (100_000 cents) → 25% = $250 (25_000 cents) → floor(25000/95) = 263
      const market = makeMarket({ yesAsk: 0.95 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.suggestedContracts).toBe(263);
    });
  });

  describe('evaluateExit', () => {
    it('holds on first low-bid tick (confirmation window)', () => {
      const market = makeMarket({ yesBid: 0.75, winProbability: 0.75 });
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('hold');
      expect(signal.reason).toMatch(/confirming \(1\//);
    });

    it('sells after EXIT_CONFIRMATION_TICKS consecutive low-bid ticks', () => {
      const market = makeMarket({ yesBid: 0.75, winProbability: 0.75 });
      for (let i = 1; i < EXIT_CONFIRMATION_TICKS; i++) {
        expect(strategy.evaluateExit(market, 5).action).toBe('hold');
      }
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('sell');
    });

    it('resets confirmation counter when bid recovers', () => {
      const lowMarket = makeMarket({ yesBid: 0.75, winProbability: 0.75 });
      const highMarket = makeMarket({ yesBid: 0.88, winProbability: 0.88 });

      // Two ticks below threshold
      strategy.evaluateExit(lowMarket, 5);
      strategy.evaluateExit(lowMarket, 5);
      // Bid recovers — counter resets
      strategy.evaluateExit(highMarket, 5);
      // Needs full confirmation window again
      for (let i = 1; i < EXIT_CONFIRMATION_TICKS; i++) {
        expect(strategy.evaluateExit(lowMarket, 5).action).toBe('hold');
      }
      expect(strategy.evaluateExit(lowMarket, 5).action).toBe('sell');
    });

    it('holds when bid is low but model probability is above guard', () => {
      const market = makeMarket({ yesBid: 0.72, winProbability: EXIT_PROBABILITY_GUARD + 0.01 });
      // Should never sell regardless of ticks
      for (let i = 0; i < EXIT_CONFIRMATION_TICKS + 2; i++) {
        expect(strategy.evaluateExit(market, 5).action).toBe('hold');
      }
    });

    it('sells when both bid is low and probability is below guard', () => {
      const market = makeMarket({ yesBid: 0.72, winProbability: EXIT_PROBABILITY_GUARD - 0.01 });
      for (let i = 1; i < EXIT_CONFIRMATION_TICKS; i++) {
        expect(strategy.evaluateExit(market, 5).action).toBe('hold');
      }
      expect(strategy.evaluateExit(market, 5).action).toBe('sell');
    });

    it('returns hold when bid stays above exit threshold', () => {
      const market = makeMarket({ yesBid: 0.88 });
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('hold');
    });

    it('returns sell when market is not tradeable', () => {
      const market = makeMarket({ status: 'closed', yesBid: 0.99 });
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('sell');
    });

    it('returns sell at exactly exit threshold after confirmation', () => {
      const market = makeMarket({ yesBid: EXIT_PROBABILITY_THRESHOLD, winProbability: 0.75 });
      for (let i = 1; i < EXIT_CONFIRMATION_TICKS; i++) {
        expect(strategy.evaluateExit(market, 5).action).toBe('hold');
      }
      expect(strategy.evaluateExit(market, 5).action).toBe('sell');
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
