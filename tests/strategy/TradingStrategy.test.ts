import {
  TradingStrategy,
  ENTRY_ASK_THRESHOLD,
  ENTRY_MAX_ASK,
  ENTRY_MIN_SECONDS,
  ENTRY_MAX_SECONDS,
  EXIT_HARD_STOP,
  EXIT_TAKE_PROFIT,
  WINDOW_BUDGET_CENTS,
} from '../../src/strategy/TradingStrategy';
import { BtcMarket } from '../../src/services/MarketService';

function makeMarket(overrides: Partial<BtcMarket> = {}): BtcMarket {
  return {
    ticker:             'KXBTC15M-TEST',
    eventTicker:        'KXBTC15M',
    title:              'BTC 15-min test market',
    status:             'active',
    yesBid:             0.92,
    yesAsk:             0.94,
    noBid:              0.06,
    noAsk:              0.08,
    lastPrice:          0.93,
    volume:             500,
    closeTime:          new Date(Date.now() + 120_000),
    winProbability:     0.93,
    isInTradingWindow:  true,
    secondsLeft:        120,
    threshold:          80000,
    settlementSamples:  [],
    ...overrides,
  };
}

describe('TradingStrategy', () => {
  let strategy: TradingStrategy;

  beforeEach(() => {
    strategy = new TradingStrategy();
  });

  describe('evaluateEntry', () => {
    it('returns YES buy when YES ask exceeds threshold', () => {
      // yesAsk=0.94 > 90¢ → qualifies regardless of model probability
      const signal = strategy.evaluateEntry(makeMarket({ yesAsk: 0.94, winProbability: 0.93 }), 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.side).toBe('yes');
      expect(signal.suggestedContracts).toBeGreaterThan(0);
      expect(signal.suggestedLimitPrice).toBe(0.94);
    });

    it('returns YES buy even when model probability is low if market ask > 90¢', () => {
      // Market price is the sole gate — model probability is logged only
      const signal = strategy.evaluateEntry(makeMarket({ yesAsk: 0.94, winProbability: 0.50 }), 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.side).toBe('yes');
    });

    it('returns NO buy when NO ask > 90¢', () => {
      // noAsk=0.95 → buy NO; model probability is logged only
      const signal = strategy.evaluateEntry(
        makeMarket({ winProbability: 0.05, noAsk: 0.95, noBid: 0.93, yesAsk: 0.07, yesBid: 0.05 }),
        100_000,
      );
      expect(signal.action).toBe('buy');
      expect(signal.side).toBe('no');
      expect(signal.suggestedLimitPrice).toBe(0.95);
      expect(signal.suggestedContracts).toBeGreaterThan(0);
    });

    it('holds when neither YES nor NO ask exceeds 90¢', () => {
      const signal = strategy.evaluateEntry(
        makeMarket({ yesAsk: 0.5, noAsk: 0.5 }),
        100_000,
      );
      expect(signal.action).toBe('hold');
    });

    it('holds when not in trading window', () => {
      const market = makeMarket({ isInTradingWindow: false, secondsLeft: 400 });
      const signal = strategy.evaluateEntry(market, 100_000);
      expect(signal.action).toBe('hold');
      expect(signal.reason).toMatch(/entry window/);
    });

    it('holds when ask is exactly at entry threshold (not strictly above)', () => {
      const signal = strategy.evaluateEntry(makeMarket({ yesAsk: ENTRY_ASK_THRESHOLD }), 100_000);
      expect(signal.action).toBe('hold');
    });

    it('holds when ask is above 98¢ cap', () => {
      const signal = strategy.evaluateEntry(makeMarket({ yesAsk: 0.99 }), 100_000);
      expect(signal.action).toBe('hold');
    });

    it('holds when ask is 100¢', () => {
      const signal = strategy.evaluateEntry(makeMarket({ yesAsk: 1.0 }), 100_000);
      expect(signal.action).toBe('hold');
    });

    it('ENTRY_MAX_ASK constant is 98¢', () => {
      expect(ENTRY_MAX_ASK).toBe(0.98);
    });

    it('holds when market is not tradeable', () => {
      const signal = strategy.evaluateEntry(makeMarket({ status: 'closed', yesAsk: 0.94 }), 100_000);
      expect(signal.action).toBe('hold');
    });

    it('holds when balance is too small for 1 contract on either side', () => {
      // ask=0.94 → 94¢/contract; balance=50 cents → 0 YES contracts; NO ask=8¢ → not ≥90¢
      const signal = strategy.evaluateEntry(makeMarket({ yesAsk: 0.94 }), 50);
      expect(signal.action).toBe('hold');
    });

    it('sizes at window budget ($10) when balance is ample', () => {
      // ask=0.91 → 91 cents/contract; windowBudget=1000 cents → floor(1000/91)=10
      const signal = strategy.evaluateEntry(makeMarket({ yesAsk: 0.91 }), 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.suggestedContracts).toBe(10);
    });

    it('caps spend at available balance when balance < window budget', () => {
      // ask=0.91 → 91 cents/contract; balance=500 cents → floor(500/91)=5
      const signal = strategy.evaluateEntry(makeMarket({ yesAsk: 0.91 }), 500);
      expect(signal.action).toBe('buy');
      expect(signal.suggestedContracts).toBe(5);
    });

    it('window budget constant is $10 (1000 cents)', () => {
      expect(WINDOW_BUDGET_CENTS).toBe(1_000);
    });
  });

  describe('evaluateExit', () => {
    it('take profit fires when bid reaches 99¢', () => {
      const market = makeMarket({ yesBid: EXIT_TAKE_PROFIT });
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('sell');
      expect(signal.reason).toMatch(/Take profit/);
      expect(signal.suggestedLimitPrice).toBe(EXIT_TAKE_PROFIT);
    });

    it('take profit fires above 99¢ threshold', () => {
      expect(strategy.evaluateExit(makeMarket({ yesBid: 1.0 }), 5).action).toBe('sell');
    });

    it('holds at 98¢ (below take-profit threshold)', () => {
      expect(strategy.evaluateExit(makeMarket({ yesBid: 0.98 }), 5).action).toBe('hold');
    });

    it('hard stop fires when bid equals threshold', () => {
      const market = makeMarket({ yesBid: EXIT_HARD_STOP });
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('sell');
      expect(signal.reason).toMatch(/Hard stop/);
    });

    it('hard stop fires well below threshold regardless of probability', () => {
      expect(strategy.evaluateExit(makeMarket({ yesBid: 0.30 }), 5).action).toBe('sell');
    });

    it('holds when bid is above hard stop threshold', () => {
      expect(strategy.evaluateExit(makeMarket({ yesBid: 0.65 }), 5).action).toBe('hold');
      expect(strategy.evaluateExit(makeMarket({ yesBid: 0.90 }), 5).action).toBe('hold');
    });

    it('hold reason includes model_prob for logging', () => {
      const signal = strategy.evaluateExit(makeMarket({ yesBid: 0.90, winProbability: 0.93 }), 5);
      expect(signal.reason).toMatch(/model_prob/);
    });

    it('evaluates NO exit using noBid', () => {
      // noBid=0.92 → above threshold → hold
      expect(strategy.evaluateExit(makeMarket({ noBid: 0.92 }), 5, 'no').action).toBe('hold');
      // noBid=0.55 → hard stop → sell
      expect(strategy.evaluateExit(makeMarket({ noBid: 0.55 }), 5, 'no').action).toBe('sell');
    });

    it('NO hard stop fires using noBid regardless of yesBid', () => {
      const market = makeMarket({ yesBid: 0.92, noBid: 0.55, winProbability: 0.08 });
      const signal = strategy.evaluateExit(market, 5, 'no');
      expect(signal.action).toBe('sell');
      expect(signal.reason).toMatch(/Hard stop/);
      expect(signal.side).toBe('no');
    });
  });

  describe('evaluateTopUp', () => {
    it('returns contracts shortfall when position is below window budget', () => {
      // ask=0.94 → 94 cents; windowBudget=1000 → target=floor(1000/94)=10; held=3 → topUp=7
      const market = makeMarket({ yesAsk: 0.94 });
      const result = strategy.evaluateTopUp(market, 3, 100_000);
      expect(result.contracts).toBe(7);
    });

    it('returns 0 when already at target', () => {
      const market = makeMarket({ yesAsk: 0.94 });
      const result = strategy.evaluateTopUp(market, 10, 100_000);
      expect(result.contracts).toBe(0);
    });

    it('returns 0 when outside entry window', () => {
      const market = makeMarket({ isInTradingWindow: false, secondsLeft: 400 });
      expect(strategy.evaluateTopUp(market, 0, 100_000).contracts).toBe(0);
    });

    it('returns 0 when ask is out of range', () => {
      expect(strategy.evaluateTopUp(makeMarket({ yesAsk: 0.85 }), 0, 100_000).contracts).toBe(0);
      expect(strategy.evaluateTopUp(makeMarket({ yesAsk: 0.99 }), 0, 100_000).contracts).toBe(0);
      expect(strategy.evaluateTopUp(makeMarket({ yesAsk: 1.0  }), 0, 100_000).contracts).toBe(0);
    });

    it('caps top-up at available balance', () => {
      // ask=0.94 → target=10; balance=200 cents → floor(200/94)=2; held=0 → topUp=2
      const result = strategy.evaluateTopUp(makeMarket({ yesAsk: 0.94 }), 0, 200);
      expect(result.contracts).toBe(2);
    });
  });

  describe('calculatePnl', () => {
    it('calculates positive PnL on winning trade', () => {
      expect(strategy.calculatePnl(0.92, 1.00, 10)).toBeCloseTo(0.8);
    });

    it('calculates negative PnL on losing trade', () => {
      expect(strategy.calculatePnl(0.92, 0.70, 10)).toBeCloseTo(-2.2);
    });
  });
});
