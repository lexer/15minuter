import { BtcMomentumIndicators } from '../../src/services/BtcMomentumIndicators';

function feedPrices(indicators: BtcMomentumIndicators, prices: number[]) {
  let last = null;
  for (const p of prices) last = indicators.update(p);
  return last;
}

function generatePrices(start: number, step: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => start + i * step);
}

describe('BtcMomentumIndicators', () => {
  let ind: BtcMomentumIndicators;

  beforeEach(() => {
    ind = new BtcMomentumIndicators();
  });

  it('returns null on the 30th tick (not yet enough for RSI-30)', () => {
    // RSI(30) needs 31 prices (30 differences). The 30th tick leaves us 1 short.
    for (let i = 0; i < 29; i++) ind.update(80000 + i);
    expect(ind.update(80029)).toBeNull();
  });

  it('returns non-null on the 31st tick and beyond', () => {
    const state = feedPrices(ind, generatePrices(80000, 1, 31));
    expect(state).not.toBeNull();
  });

  it('score is in [-1, 1]', () => {
    const state = feedPrices(ind, generatePrices(80000, 5, 60));
    expect(state!.score).toBeGreaterThanOrEqual(-1);
    expect(state!.score).toBeLessThanOrEqual(1);
  });

  it('RSI is in [0, 100]', () => {
    const state = feedPrices(ind, generatePrices(80000, 3, 50));
    expect(state!.rsi).toBeGreaterThanOrEqual(0);
    expect(state!.rsi).toBeLessThanOrEqual(100);
  });

  describe('RSI direction', () => {
    it('returns RSI > 50 for consistently rising prices', () => {
      const state = feedPrices(ind, generatePrices(80000, 10, 60));
      expect(state!.rsi).toBeGreaterThan(50);
    });

    it('returns RSI < 50 for consistently falling prices', () => {
      const state = feedPrices(ind, generatePrices(83000, -10, 60));
      expect(state!.rsi).toBeLessThan(50);
    });

    it('returns RSI near 100 when all ticks are gains', () => {
      const state = feedPrices(ind, generatePrices(80000, 5, 50));
      expect(state!.rsi).toBeGreaterThan(95);
    });

    it('returns RSI near 0 when all ticks are losses', () => {
      const state = feedPrices(ind, generatePrices(84000, -5, 50));
      expect(state!.rsi).toBeLessThan(5);
    });
  });

  describe('EMA relationship', () => {
    it('emaFast lags less than emaSlow on a rising series', () => {
      const prices = generatePrices(80000, 10, 60);
      const state  = feedPrices(ind, prices)!;
      // Fast EMA converges faster — should be closer to the latest price
      const latest = prices[prices.length - 1];
      expect(Math.abs(latest - state.emaFast)).toBeLessThan(Math.abs(latest - state.emaSlow));
    });

    it('score is positive when emaFast > emaSlow (uptrend)', () => {
      const state = feedPrices(ind, generatePrices(80000, 10, 60))!;
      expect(state.emaFast).toBeGreaterThan(state.emaSlow);
      expect(state.score).toBeGreaterThan(0);
    });

    it('score is negative when emaFast < emaSlow (downtrend)', () => {
      const state = feedPrices(ind, generatePrices(84000, -10, 60))!;
      expect(state.emaFast).toBeLessThan(state.emaSlow);
      expect(state.score).toBeLessThan(0);
    });
  });

  describe('dynamicSigma', () => {
    it('returns a positive dynamic sigma', () => {
      const state = feedPrices(ind, generatePrices(80000, 5, 60))!;
      expect(state.dynamicSigma).toBeGreaterThan(0);
    });

    it('is clamped to at most 3× static sigma (0.0001424)', () => {
      // Inject extreme price jumps
      const prices = [80000, 90000, 70000, 85000, 75000];
      for (let i = 0; i < 26; i++) prices.push(80000 + i);
      const state = feedPrices(ind, prices)!;
      expect(state.dynamicSigma).toBeLessThanOrEqual(0.0001424 * 3 + 1e-10);
    });

    it('is clamped to at least 0.5× static sigma', () => {
      // Flat prices → near-zero log returns
      const state = feedPrices(ind, Array(60).fill(80000))!;
      expect(state.dynamicSigma).toBeGreaterThanOrEqual(0.0001424 * 0.5 - 1e-10);
    });
  });

  describe('reset()', () => {
    it('returns null after reset', () => {
      feedPrices(ind, generatePrices(80000, 5, 60));
      ind.reset();
      expect(ind.update(80000)).toBeNull();
    });
  });
});
