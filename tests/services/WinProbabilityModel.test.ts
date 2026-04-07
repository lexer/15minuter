import { WinProbabilityModel } from '../../src/services/WinProbabilityModel';

describe('WinProbabilityModel', () => {
  let model: WinProbabilityModel;

  beforeEach(() => {
    model = new WinProbabilityModel();
  });

  describe('calculate', () => {
    it('returns 1.0 when time is up and leading', () => {
      expect(model.calculate(5, 0)).toBe(1.0);
    });

    it('returns 0.0 when time is up and trailing', () => {
      expect(model.calculate(-3, 0)).toBe(0.0);
    });

    it('returns 0.5 when time is up and tied', () => {
      expect(model.calculate(0, 0)).toBe(0.5);
    });

    it('+10 lead with 5 minutes left is very high probability (σ=0.22)', () => {
      // With σ=0.22: z = 10 / (0.22 * sqrt(300)) = 2.63 → Φ(2.63) ≈ 0.996
      expect(model.calculate(10, 300)).toBeGreaterThan(0.99);
    });

    it('trailing team has inverse probability', () => {
      const leading = model.calculate(10, 300);
      const trailing = model.calculate(-10, 300);
      expect(leading + trailing).toBeCloseTo(1.0, 5);
    });

    it('probability increases as time decreases with same lead', () => {
      const p5min = model.calculate(5, 300);
      const p2min = model.calculate(5, 120);
      const p30sec = model.calculate(5, 30);
      expect(p5min).toBeLessThan(p2min);
      expect(p2min).toBeLessThan(p30sec);
    });

    it('probability increases as lead grows with same time', () => {
      expect(model.calculate(3, 120)).toBeLessThan(model.calculate(8, 120));
    });

    it('timeout adjustment has no effect outside final 2 minutes', () => {
      const withTimeouts = model.calculate(5, 180, 3, 0);
      const without = model.calculate(5, 180);
      expect(withTimeouts).toBeCloseTo(without, 5);
    });

    it('trailing team with extra timeouts increases effective seconds (lower win prob for leader)', () => {
      // Leading team: scoreDiff=+5, 60s left, opposing (trailing) has 2 extra timeouts
      // Extra timeouts → +28s effective → more variance → leader's prob should drop slightly
      const withExtraTimeouts = model.calculate(5, 60, 0, 2);
      const withoutTimeouts = model.calculate(5, 60, 0, 0);
      expect(withExtraTimeouts).toBeLessThan(withoutTimeouts);
    });

    it('leading team with extra timeouts has no adjustment (trailing team at 0)', () => {
      // Leading team has 2 timeouts, trailing has 0 — no advantage for trailing
      const withLeadingTimeouts = model.calculate(5, 60, 2, 0);
      const withoutTimeouts = model.calculate(5, 60, 0, 0);
      expect(withLeadingTimeouts).toBeCloseTo(withoutTimeouts, 5);
    });

    it('equal timeouts produce no adjustment', () => {
      const withEqual = model.calculate(5, 60, 2, 2);
      const without = model.calculate(5, 60, 0, 0);
      expect(withEqual).toBeCloseTo(without, 5);
    });
  });

  describe('clockToSeconds', () => {
    it('parses minutes and seconds', () => {
      expect(WinProbabilityModel.clockToSeconds('PT02M30.00S')).toBe(150);
    });

    it('parses zero clock', () => {
      expect(WinProbabilityModel.clockToSeconds('PT00M00.00S')).toBe(0);
    });

    it('returns 0 for unparseable input', () => {
      expect(WinProbabilityModel.clockToSeconds('')).toBe(0);
    });
  });

  describe('secondsRemaining', () => {
    it('Q4 with 2:30 left = 150 seconds', () => {
      expect(WinProbabilityModel.secondsRemaining(4, 'PT02M30.00S')).toBe(150);
    });

    it('Q3 with 5:00 left = 1 full quarter + 5 min = 17 min = 1020 sec', () => {
      expect(WinProbabilityModel.secondsRemaining(3, 'PT05M00.00S')).toBe(1020);
    });

    it('OT with 3:00 left = 180 seconds', () => {
      expect(WinProbabilityModel.secondsRemaining(5, 'PT03M00.00S')).toBe(180);
    });
  });
});
