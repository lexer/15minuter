import {
  TradingStrategy,
  ENTRY_PROBABILITY_THRESHOLD,
  ENTRY_CONFIRMATION_THRESHOLD,
  ENTRY_MAX_SECONDS,
  EXIT_PROBABILITY_THRESHOLD,
  EXIT_PROBABILITY_GUARD,
  EXIT_CONFIRMATION_TICKS,
} from '../../src/strategy/TradingStrategy';
import { BasketballMarket } from '../../src/services/MarketService';
import { NbaGameState } from '../../src/services/GameMonitor';

function makeGameState(secondsRemaining: number = 120): NbaGameState {
  // Build a Q4 clock string for the given seconds remaining
  const mins = Math.floor(secondsRemaining / 60);
  const secs = secondsRemaining % 60;
  const clock = `PT${String(mins).padStart(2, '0')}M${String(secs).padStart(2, '0')}.00S`;
  return {
    gameId: 'g1',
    homeTeam: 'Lakers',
    awayTeam: 'Celtics',
    homeScore: 105,
    awayScore: 88,
    period: 4,
    gameClock: clock,
    gameStatus: 2,
    isQ4OrLater: true,
    homeTeamTricode: 'LAL',
    awayTeamTricode: 'BOS',
    homeTimeoutsRemaining: 2,
    awayTimeoutsRemaining: 1,
  };
}

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
    isQ4: true,
    gameState: makeGameState(120), // 2 min left — within 5-min window by default
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
      // kelly=0.125 (< 25% cap), spend=12500 cents, ask=94 → floor(12500/94)=132
      const { contracts } = strategy.sizeContracts(0.97, 0.94, 100_000);
      expect(contracts).toBe(132);
    });

    it('buys fewer contracts with smaller balance', () => {
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
    it('returns buy on first tick when ask exceeds threshold in final 5 min', () => {
      const market = makeMarket({ yesAsk: 0.94 });
      const signal = strategy.evaluateEntry(market, 100_000, 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.suggestedContracts).toBeGreaterThan(0);
      expect(signal.suggestedLimitPrice).toBe(0.94);
    });

    it('holds when more than 5 minutes remaining', () => {
      const market = makeMarket({ gameState: makeGameState(ENTRY_MAX_SECONDS + 60) });
      const signal = strategy.evaluateEntry(market, 100_000, 100_000);
      expect(signal.action).toBe('hold');
      expect(signal.reason).toMatch(/entry only in final/);
    });

    it('holds when no game state available', () => {
      const market = makeMarket({ gameState: undefined });
      const signal = strategy.evaluateEntry(market, 100_000, 100_000);
      expect(signal.action).toBe('hold');
      expect(signal.reason).toMatch(/No game state/);
    });

    it('holds when ask is at or below entry threshold', () => {
      const market = makeMarket({ yesAsk: 0.85 });
      const signal = strategy.evaluateEntry(market, 100_000, 100_000);
      expect(signal.action).toBe('hold');
    });

    it('holds when market status is not tradeable', () => {
      const market = makeMarket({ status: 'closed', yesAsk: 0.94 });
      const signal = strategy.evaluateEntry(market, 100_000, 100_000);
      expect(signal.action).toBe('hold');
    });

    it('holds when balance is too small for 1 contract', () => {
      // cash=$0.50, dailyBudget=$1000 → 25% of budget=$250, capped at $0.50 → 0 contracts
      const market = makeMarket({ yesAsk: 0.94 });
      const signal = strategy.evaluateEntry(market, 50, 100_000);
      expect(signal.action).toBe('hold');
    });

    it('sizes to 25% of daily budget', () => {
      // ask=0.91, dailyBudget=$1000 → 25% = $250 → floor(25000/91) = 274
      const market = makeMarket({ yesAsk: 0.91 });
      const signal = strategy.evaluateEntry(market, 100_000, 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.suggestedContracts).toBe(274);
    });

    it('sizes to 25% of daily budget regardless of open positions', () => {
      // dailyBudget=$1000, cash=$250, ask=0.95 → 25% of $1000 = $250 capped at $250 → floor(25000/95) = 263
      const market = makeMarket({ yesAsk: 0.95 });
      const signal = strategy.evaluateEntry(market, 25_000, 100_000);
      expect(signal.action).toBe('buy');
      expect(signal.suggestedContracts).toBe(263);
    });

    it('caps spend at available cash when cash is less than 25% of daily budget', () => {
      // dailyBudget=$1000, cash=$100, 25% of budget=$250, capped at $100 → floor(10000/94) = 106
      const market = makeMarket({ yesAsk: 0.94 });
      const s = strategy.evaluateEntry(market, 10_000, 100_000);
      expect(s.action).toBe('buy');
      expect(s.suggestedContracts).toBe(106);
    });
  });

  describe('evaluateExit', () => {
    it('holds on first low-bid tick (confirmation window)', () => {
      const market = makeMarket({ yesBid: 0.65, winProbability: 0.65 });
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('hold');
      expect(signal.reason).toMatch(/confirming \(1\//);
    });

    it('sells after EXIT_CONFIRMATION_TICKS consecutive low-bid ticks', () => {
      const market = makeMarket({ yesBid: 0.65, winProbability: 0.65 });
      for (let i = 1; i < EXIT_CONFIRMATION_TICKS; i++) {
        expect(strategy.evaluateExit(market, 5).action).toBe('hold');
      }
      const signal = strategy.evaluateExit(market, 5);
      expect(signal.action).toBe('sell');
    });

    it('resets confirmation counter when bid recovers', () => {
      const lowMarket = makeMarket({ yesBid: 0.65, winProbability: 0.65 });
      const highMarket = makeMarket({ yesBid: 0.77, winProbability: 0.77 }); // recovery < 15¢ above low to avoid emergency exit

      strategy.evaluateExit(lowMarket, 5);
      strategy.evaluateExit(lowMarket, 5);
      strategy.evaluateExit(highMarket, 5);
      for (let i = 1; i < EXIT_CONFIRMATION_TICKS; i++) {
        expect(strategy.evaluateExit(lowMarket, 5).action).toBe('hold');
      }
      expect(strategy.evaluateExit(lowMarket, 5).action).toBe('sell');
    });

    it('holds when bid is low but model probability is above guard', () => {
      const market = makeMarket({ yesBid: 0.65, winProbability: EXIT_PROBABILITY_GUARD + 0.01 });
      for (let i = 0; i < EXIT_CONFIRMATION_TICKS + 2; i++) {
        expect(strategy.evaluateExit(market, 5).action).toBe('hold');
      }
    });

    it('sells when both bid is low and probability is below guard', () => {
      const market = makeMarket({ yesBid: 0.65, winProbability: EXIT_PROBABILITY_GUARD - 0.01 });
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

  describe('evaluateTopUp', () => {
    it('returns contracts shortfall when position is below target', () => {
      // dailyBudget=$1000, cash=$1000, 25%=$250, ask=0.94 → target=floor(25000/94)=265; held=100 → topUp=165
      const market = makeMarket({ yesAsk: 0.94 });
      const result = strategy.evaluateTopUp(market, 100, 100_000, 100_000);
      expect(result.contracts).toBe(165);
    });

    it('returns 0 when already at or above target', () => {
      const market = makeMarket({ yesAsk: 0.94 });
      const result = strategy.evaluateTopUp(market, 265, 100_000, 100_000);
      expect(result.contracts).toBe(0);
    });

    it('returns 0 when ask is at or below entry threshold', () => {
      const market = makeMarket({ yesAsk: 0.85 });
      const result = strategy.evaluateTopUp(market, 0, 100_000, 100_000);
      expect(result.contracts).toBe(0);
    });

    it('returns 0 when outside entry window', () => {
      const market = makeMarket({ gameState: makeGameState(ENTRY_MAX_SECONDS + 60) });
      const result = strategy.evaluateTopUp(market, 0, 100_000, 100_000);
      expect(result.contracts).toBe(0);
    });

    it('returns 0 when no game state', () => {
      const market = makeMarket({ gameState: undefined });
      const result = strategy.evaluateTopUp(market, 0, 100_000, 100_000);
      expect(result.contracts).toBe(0);
    });

    it('caps top-up at available cash when cash is less than 25% of daily budget', () => {
      // dailyBudget=$1000, cash=$250, 25% of budget=$250 capped at $250, ask=0.94 → target=265; held=100 → topUp=165
      const market = makeMarket({ yesAsk: 0.94 });
      const result = strategy.evaluateTopUp(market, 100, 25_000, 100_000);
      expect(result.contracts).toBe(165);
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
