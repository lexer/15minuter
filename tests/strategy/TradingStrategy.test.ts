import {
  TradingStrategy,
  ENTRY_ASK_THRESHOLD,
  ENTRY_MIN_SECONDS,
  ENTRY_MAX_SECONDS,
  EXIT_PROBABILITY_THRESHOLD,
  EXIT_HARD_STOP,
  EXIT_PROBABILITY_GUARD,
  EXIT_CONFIRMATION_TICKS,
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
      const signal = strategy.evaluateEntry(makeMarket({ yesAsk: 0.94 }), 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.side).toBe('yes');
      expect(signal.suggestedContracts).toBeGreaterThan(0);
      expect(signal.suggestedLimitPrice).toBe(0.94);
    });

    it('returns NO buy when win probability is ≤ 10% and NO ask > 90¢', () => {
      // winProbability=0.05 → P(NO)=95%; noAsk=0.95 → buy NO
      const signal = strategy.evaluateEntry(
        makeMarket({ winProbability: 0.05, noAsk: 0.95, noBid: 0.93, yesAsk: 0.07, yesBid: 0.05 }),
        100_000,
      );
      expect(signal.action).toBe('buy');
      expect(signal.side).toBe('no');
      expect(signal.suggestedLimitPrice).toBe(0.95);
      expect(signal.suggestedContracts).toBeGreaterThan(0);
    });

    it('holds when win probability is between 10% and 90% (no qualifying side)', () => {
      const signal = strategy.evaluateEntry(
        makeMarket({ winProbability: 0.5, yesAsk: 0.5, noAsk: 0.5 }),
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

    it('holds when ask is 100¢', () => {
      const signal = strategy.evaluateEntry(makeMarket({ yesAsk: 1.0 }), 100_000);
      expect(signal.action).toBe('hold');
      expect(signal.reason).toMatch(/100¢/);
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
    it('exits immediately on hard stop — no confirmation, no probability guard', () => {
      const market = makeMarket({ yesBid: EXIT_HARD_STOP, winProbability: 0.95 });
      expect(strategy.evaluateExit(market, 5).action).toBe('sell');
      expect(strategy.evaluateExit(makeMarket({ yesBid: EXIT_HARD_STOP }), 5).reason).toMatch(/Hard stop/);
    });

    it('exits immediately well below hard stop regardless of probability', () => {
      const market = makeMarket({ yesBid: 0.50, winProbability: 0.99 });
      expect(strategy.evaluateExit(market, 5).action).toBe('sell');
    });

    it('holds on first low-bid tick in soft zone (confirmation window)', () => {
      const market = makeMarket({ yesBid: 0.75, winProbability: 0.65 });
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('hold');
      expect(signal.reason).toMatch(/confirming \(1\//);
    });

    it('sells after EXIT_CONFIRMATION_TICKS consecutive low-bid ticks', () => {
      const market = makeMarket({ yesBid: 0.75, winProbability: 0.65 });
      for (let i = 1; i < EXIT_CONFIRMATION_TICKS; i++) {
        expect(strategy.evaluateExit(market, 5).action).toBe('hold');
      }
      expect(strategy.evaluateExit(market, 5).action).toBe('sell');
    });

    it('resets confirmation counter when bid recovers above soft threshold', () => {
      const low  = makeMarket({ yesBid: 0.75, winProbability: 0.65 });
      const high = makeMarket({ yesBid: 0.85, winProbability: 0.85 });

      strategy.evaluateExit(low, 5);
      strategy.evaluateExit(low, 5);
      strategy.evaluateExit(high, 5); // recovery — resets counter
      for (let i = 1; i < EXIT_CONFIRMATION_TICKS; i++) {
        expect(strategy.evaluateExit(low, 5).action).toBe('hold');
      }
      expect(strategy.evaluateExit(low, 5).action).toBe('sell');
    });

    it('holds in soft zone when model probability is above guard', () => {
      const market = makeMarket({ yesBid: 0.75, winProbability: EXIT_PROBABILITY_GUARD + 0.01 });
      for (let i = 0; i < EXIT_CONFIRMATION_TICKS + 2; i++) {
        expect(strategy.evaluateExit(market, 5).action).toBe('hold');
      }
    });

    it('sells in soft zone when probability is below guard (after confirmation)', () => {
      const market = makeMarket({ yesBid: 0.75, winProbability: EXIT_PROBABILITY_GUARD - 0.01 });
      for (let i = 1; i < EXIT_CONFIRMATION_TICKS; i++) {
        expect(strategy.evaluateExit(market, 5).action).toBe('hold');
      }
      expect(strategy.evaluateExit(market, 5).action).toBe('sell');
    });

    it('holds when bid is above exit threshold', () => {
      expect(strategy.evaluateExit(makeMarket({ yesBid: 0.88 }), 5).action).toBe('hold');
    });

    it('suppresses soft-zone exit during liquidation cascade', () => {
      const market = makeMarket({ yesBid: 0.75, winProbability: 0.65 });
      // Baseline: without suppressSoftExit, sells after EXIT_CONFIRMATION_TICKS ticks
      for (let i = 1; i < EXIT_CONFIRMATION_TICKS; i++) {
        expect(strategy.evaluateExit(market, 5, false).action).toBe('hold');
      }
      expect(strategy.evaluateExit(market, 5, false).action).toBe('sell');

      // With suppressSoftExit=true: stays in hold indefinitely in soft zone
      strategy = new TradingStrategy();
      for (let i = 0; i < EXIT_CONFIRMATION_TICKS + 2; i++) {
        const result = strategy.evaluateExit(market, 5, true);
        expect(result.action).toBe('hold');
        expect(result.reason).toMatch(/cascade/);
      }
    });

    it('still hard-stops during liquidation cascade (suppressSoftExit does not block hard stop)', () => {
      const market = makeMarket({ yesBid: EXIT_HARD_STOP, winProbability: 0.95 });
      expect(strategy.evaluateExit(market, 5, true).action).toBe('sell');
      expect(strategy.evaluateExit(market, 5, true).reason).toMatch(/Hard stop/);
    });

    it('triggers emergency exit on single-tick bid crash ≥15¢', () => {
      // First tick establishes previous bid
      strategy.evaluateExit(makeMarket({ yesBid: 0.92 }), 5);
      // Second tick: bid crashes 20¢ — emergency exit
      const signal = strategy.evaluateExit(makeMarket({ yesBid: 0.72, winProbability: 0.90 }), 5);
      expect(signal.action).toBe('sell');
      expect(signal.reason).toMatch(/Emergency/);
    });

    it('evaluates NO exit using noBid and P(NO) = 1 - winProbability', () => {
      // noBid=0.92 → above threshold → hold
      expect(strategy.evaluateExit(makeMarket({ noBid: 0.92 }), 5, false, 'no').action).toBe('hold');
      // noBid=0.60 → hard stop → sell
      expect(strategy.evaluateExit(makeMarket({ noBid: 0.60 }), 5, false, 'no').action).toBe('sell');
    });

    it('NO hard stop fires using noBid regardless of yesBid', () => {
      // yesBid is high (no YES hard stop), but noBid is below hard stop
      const market = makeMarket({ yesBid: 0.92, noBid: 0.65, winProbability: 0.08 });
      const signal = strategy.evaluateExit(market, 5, false, 'no');
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
