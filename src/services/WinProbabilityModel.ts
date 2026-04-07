/**
 * NBA win probability model using a Gaussian random walk (Clauset et al. 2015).
 *
 * The score margin evolves as a random walk with volatility σ per second.
 * σ recalibrated against 142 games / 3,408 samples from 2024-25 NBA season:
 *   - Initial σ=0.307 was underconfident in 80–95% range (actual rates 5–8% higher)
 *   - Recalibrated to σ=0.22 to match empirical 80–95% win rates
 *   - 50–70% and 95–100% ranges remain well-calibrated
 */

const SIGMA_PER_SQRT_SECOND = 0.22;
const REGULATION_PERIOD_SECONDS = 12 * 60; // 12 minutes per quarter
const OT_PERIOD_SECONDS = 5 * 60;           // 5 minutes per OT period
const SECONDS_PER_TIMEOUT = 14;             // ~1 extra possession per timeout
const TIMEOUT_WINDOW_SECONDS = 120;         // only adjust in final 2 minutes

export class WinProbabilityModel {
  /**
   * Returns win probability for the team with the given score differential
   * (positive = leading) with secondsRemaining left in the game.
   *
   * Optional: pass timeout counts for each team to adjust effective seconds
   * remaining in the final 2 minutes. Each timeout the trailing team holds
   * over the leading team adds ~14 seconds (one possession) of effective time.
   */
  calculate(
    scoreDiff: number,
    secondsRemaining: number,
    marketTeamTimeouts?: number,
    opposingTeamTimeouts?: number,
  ): number {
    const effectiveSeconds =
      marketTeamTimeouts !== undefined && opposingTeamTimeouts !== undefined
        ? this.adjustForTimeouts(scoreDiff, secondsRemaining, marketTeamTimeouts, opposingTeamTimeouts)
        : secondsRemaining;

    if (effectiveSeconds <= 0) {
      if (scoreDiff > 0) return 1.0;
      if (scoreDiff < 0) return 0.0;
      return 0.5; // tied, needs OT
    }
    const z = scoreDiff / (SIGMA_PER_SQRT_SECOND * Math.sqrt(effectiveSeconds));
    return this.normalCdf(z);
  }

  /**
   * Adjust effective seconds based on timeout differential in the final 2 minutes.
   * The trailing team's extra timeouts let them stop the clock and run more
   * possessions — each timeout ≈ one extra possession ≈ 14 seconds.
   */
  private adjustForTimeouts(
    scoreDiff: number,
    secondsRemaining: number,
    marketTeamTimeouts: number,
    opposingTeamTimeouts: number,
  ): number {
    if (secondsRemaining > TIMEOUT_WINDOW_SECONDS) return secondsRemaining;

    // Positive scoreDiff = market team is leading
    const trailingTimeouts = scoreDiff >= 0 ? opposingTeamTimeouts : marketTeamTimeouts;
    const leadingTimeouts  = scoreDiff >= 0 ? marketTeamTimeouts  : opposingTeamTimeouts;
    const advantage = Math.max(0, trailingTimeouts - leadingTimeouts);

    return secondsRemaining + advantage * SECONDS_PER_TIMEOUT;
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
