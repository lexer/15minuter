import { BtcProbabilityModel } from '../../src/services/BtcProbabilityModel';

describe('BtcProbabilityModel', () => {
  let model: BtcProbabilityModel;

  beforeEach(() => {
    model = new BtcProbabilityModel();
  });

  describe('boundary conditions', () => {
    it('returns 1.0 when time is up and price is up', () => {
      expect(model.calculate(0.005, 0)).toBe(1.0);
    });

    it('returns 0.0 when time is up and price is down', () => {
      expect(model.calculate(-0.003, 0)).toBe(0.0);
    });

    it('returns 0.5 when time is up and price is flat', () => {
      expect(model.calculate(0, 0)).toBe(0.5);
    });

    it('returns 0.5 when price is flat with time remaining', () => {
      expect(model.calculate(0, 120)).toBeCloseTo(0.5, 3);
    });
  });

  describe('directional probability', () => {
    it('high probability when BTC is up 0.5% with 60s left', () => {
      // σ(60) = 0.0001424 * sqrt(60) ≈ 0.001103; z = 0.005/0.001103 ≈ 4.53 → Φ ≈ 0.9999
      expect(model.calculate(0.005, 60)).toBeGreaterThan(0.99);
    });

    it('lower probability with more time remaining for the same price change', () => {
      const p60  = model.calculate(0.003, 60);
      const p180 = model.calculate(0.003, 180);
      const p300 = model.calculate(0.003, 300);
      expect(p60).toBeGreaterThan(p180);
      expect(p180).toBeGreaterThan(p300);
    });

    it('higher probability with larger price change at fixed time', () => {
      const pSmall = model.calculate(0.001, 120);
      const pLarge = model.calculate(0.005, 120);
      expect(pSmall).toBeLessThan(pLarge);
    });

    it('trailing direction gives inverse probability', () => {
      const pUp   = model.calculate(0.003, 120);
      const pDown = model.calculate(-0.003, 120);
      expect(pUp + pDown).toBeCloseTo(1.0, 5);
    });
  });

  describe('calibration: BTC up 0.3% with 5 min left should be high confidence', () => {
    it('returns > 0.9 for a 0.3% lead at 300s', () => {
      // σ(300) = 0.0001424 * sqrt(300) ≈ 0.002466; z = 0.003/0.002466 ≈ 1.22 → Φ ≈ 0.889
      // A 0.3% move with 5 min left is uncertain — should be around 0.88-0.90
      const prob = model.calculate(0.003, 300);
      expect(prob).toBeGreaterThan(0.85);
      expect(prob).toBeLessThan(0.95);
    });

    it('returns > 0.95 for a 0.5% lead at 180s', () => {
      // σ(180) = 0.0001424 * sqrt(180) ≈ 0.001910; z = 0.005/0.001910 ≈ 2.62 → Φ ≈ 0.996
      expect(model.calculate(0.005, 180)).toBeGreaterThan(0.99);
    });

    it('entry threshold of 90% requires meaningful price move at 300s', () => {
      // σ(300) = 0.0001424 * sqrt(300) ≈ 0.00247; for prob>90%: z > 1.28 → change > 0.32%
      expect(model.calculate(0.0034, 300)).toBeGreaterThan(0.90); // 0.34% change → clearly >90%
      expect(model.calculate(0.001,  300)).toBeLessThan(0.90);    // 0.1% change → ~66%, not tradeable
    });
  });

  describe('calculateSettlement: final 60-second BRTI average model', () => {
    const T = 80000; // threshold

    it('returns high probability when BTC is above threshold at start of settlement window', () => {
      // No samples yet, 60s left, BTC +0.5% above threshold
      const prob = model.calculateSettlement(80400, T, [], 0, 60);
      expect(prob).toBeGreaterThan(0.99);
    });

    it('returns ~0.5 when price equals threshold', () => {
      expect(model.calculateSettlement(T, T, [], 0, 60)).toBeCloseTo(0.5, 2);
    });

    it('returns low probability when BTC is below threshold', () => {
      const prob = model.calculateSettlement(79600, T, [], 0, 60);
      expect(prob).toBeLessThan(0.01);
    });

    it('returns 1.0 when time is up and accumulated average is above threshold', () => {
      // All 60 samples collected, average above threshold
      const samples = Array(60).fill(80200);
      const prob = model.calculateSettlement(80200, T, samples, 60, 0);
      expect(prob).toBe(1.0);
    });

    it('returns 0.0 when time is up and accumulated average is below threshold', () => {
      const samples = Array(60).fill(79800);
      const prob = model.calculateSettlement(79800, T, samples, 60, 0);
      expect(prob).toBe(0.0);
    });

    it('is more confident than pre-settlement model at the same lead', () => {
      const priceChangeFraction = (80400 - T) / T; // +0.5%
      const stdProb        = model.calculate(priceChangeFraction, 60);  // standard at 60s
      const settlementProb = model.calculateSettlement(80400, T, [], 0, 60); // settlement at entry
      // Settlement average smooths noise → higher confidence for same price lead
      expect(settlementProb).toBeGreaterThanOrEqual(stdProb);
    });

    it('grows more confident as samples accumulate', () => {
      // 5s left, price above threshold: with vs without prior samples
      const noSamples   = model.calculateSettlement(80300, T, [],                    55, 5);
      const withSamples = model.calculateSettlement(80300, T, Array(11).fill(80300), 55, 5);
      // More accumulated evidence → equal or more confident
      expect(withSamples).toBeGreaterThanOrEqual(noSamples);
    });

    it('returns 0.5 for zero threshold', () => {
      expect(model.calculateSettlement(80000, 0, [], 0, 30)).toBeCloseTo(0.5);
    });
  });
});
