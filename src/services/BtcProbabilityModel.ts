/**
 * BTC 15-minute window win-probability model using a Gaussian random walk.
 *
 * BTC annual volatility ≈ 80%. Per-second volatility (as a price fraction):
 *   σ_per_√second = 0.80 / √(365 × 24 × 3600) ≈ 0.0001424
 *
 * Given that BTC is currently priceChangeFraction above the window open price
 * with secondsRemaining until the 15-min window closes, the probability that
 * BTC remains above the open at expiry is Φ(priceChangeFraction / σ(T)).
 */

const SIGMA_PER_SQRT_SECOND = 0.0001424; // calibrated from 80% annual BTC volatility

export class BtcProbabilityModel {
  /**
   * Probability that BTC price stays above the window open price at expiry.
   *
   * @param priceChangeFraction - (currentPrice - openPrice) / openPrice;
   *                              positive = BTC currently up in this window
   * @param secondsRemaining    - seconds until the 15-min window closes
   */
  calculate(priceChangeFraction: number, secondsRemaining: number): number {
    if (secondsRemaining <= 0) {
      if (priceChangeFraction > 0) return 1.0;
      if (priceChangeFraction < 0) return 0.0;
      return 0.5;
    }

    const sigma = SIGMA_PER_SQRT_SECOND * Math.sqrt(secondsRemaining);
    const z = priceChangeFraction / sigma;
    return this.normalCdf(z);
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
