/**
 * NBA win probability model using a Gaussian random walk (Clauset et al. 2015).
 *
 * The score margin evolves as a random walk with volatility σ per second.
 * σ is calibrated so that a +10 point lead with 5 minutes remaining gives ~97% win probability.
 *
 * Calibration:
 *   Φ(10 / (σ × sqrt(300))) = 0.97
 *   → σ = 10 / (1.88 × sqrt(300)) ≈ 0.307
 */

const SIGMA_PER_SQRT_SECOND = 0.307;
const REGULATION_PERIOD_SECONDS = 12 * 60; // 12 minutes per quarter
const OT_PERIOD_SECONDS = 5 * 60;           // 5 minutes per OT period

export class WinProbabilityModel {
  /**
   * Returns win probability for the team with the given score differential
   * (positive = leading) with secondsRemaining left in the game.
   */
  calculate(scoreDiff: number, secondsRemaining: number): number {
    if (secondsRemaining <= 0) {
      if (scoreDiff > 0) return 1.0;
      if (scoreDiff < 0) return 0.0;
      return 0.5; // tied, needs OT
    }
    const z = scoreDiff / (SIGMA_PER_SQRT_SECOND * Math.sqrt(secondsRemaining));
    return this.normalCdf(z);
  }

  /**
   * Parse game clock string "PT02M16.00S" → seconds remaining in current period.
   */
  static clockToSeconds(gameClock: string): number {
    const m = gameClock.match(/PT(\d+)M([\d.]+)S/);
    if (!m) return 0;
    return parseInt(m[1], 10) * 60 + parseFloat(m[2]);
  }

  /**
   * Total seconds remaining in regulation given period and clock.
   * For OT (period >= 5) returns only remaining OT seconds (conservative).
   */
  static secondsRemaining(period: number, gameClock: string): number {
    const clockSec = WinProbabilityModel.clockToSeconds(gameClock);
    if (period <= 4) {
      return (4 - period) * REGULATION_PERIOD_SECONDS + clockSec;
    }
    // Overtime — only count current OT period remaining
    return clockSec;
  }

  /** Abramowitz & Stegun approximation of standard normal CDF (max error 7.5e-8) */
  private normalCdf(z: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const poly =
      t * (0.31938153 +
        t * (-0.356563782 +
          t * (1.781477937 +
            t * (-1.821255978 +
              t * 1.330274429))));
    const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
    const cdf = 1 - pdf * poly;
    return z >= 0 ? cdf : 1 - cdf;
  }
}
