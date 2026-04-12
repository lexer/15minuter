/**
 * BTC 15-minute window win-probability model using a Gaussian random walk
 * augmented by real-time momentum indicators.
 *
 * BTC annual volatility ≈ 80%. Per-second volatility (as a price fraction):
 *   σ_per_√second = 0.80 / √(365 × 24 × 3600) ≈ 0.0001424
 *
 * Two calculation modes:
 *
 * 1. Pre-settlement (secondsLeft > 60):
 *    Φ(z)  where  z = priceChangeFraction / (σ_eff × √secondsLeft) + score × MOMENTUM_SCALE
 *
 *    σ_eff = momentum.dynamicSigma if available, else SIGMA_PER_SQRT_SECOND
 *    score = momentum.score ∈ [-1, 1]; MOMENTUM_SCALE = 1.5
 *
 * 2. Settlement window (secondsLeft ≤ 60):
 *    KXBTC15M resolves YES if the 60-second average of BRTI > threshold.
 *    During the final 60s we accumulate actual BRTI samples. The expected
 *    settlement average = (accumulated_partial_sum + secondsLeft × currentBrti) / 60.
 *    The variance of the average narrows as samples accumulate, making the
 *    probability estimate progressively sharper.
 *
 *    σ_avg = σ_per_√s × secondsLeft × √(secondsLeft/3) / 60
 *    (derived from the variance of a random-walk average over secondsLeft steps)
 *    Momentum adjustment is NOT applied in settlement mode (price path is nearly fixed).
 */

import { MomentumState } from './BtcMomentumIndicators';

const SIGMA_PER_SQRT_SECOND = 0.0001424; // calibrated from 80% annual BTC volatility

/**
 * Momentum shifts the z-score by up to ±1.5 standard deviations.
 * score=+1 (max bullish) adds 1.5σ; score=-1 (max bearish) subtracts 1.5σ.
 */
const MOMENTUM_SCALE = 1.5;

export class BtcProbabilityModel {
  /**
   * Probability that BTC price stays above threshold at expiry.
   * Used when secondsLeft > 60 (pre-settlement window).
   *
   * @param priceChangeFraction - (currentBrti - threshold) / threshold
   * @param secondsRemaining    - seconds until the 15-min window closes
   * @param momentum            - optional momentum state; uses dynamic σ + score if present
   */
  calculate(
    priceChangeFraction: number,
    secondsRemaining:    number,
    momentum?:           MomentumState | null,
  ): number {
    if (secondsRemaining <= 0) {
      if (priceChangeFraction > 0) return 1.0;
      if (priceChangeFraction < 0) return 0.0;
      return 0.5;
    }

    const sigma = (momentum?.dynamicSigma ?? SIGMA_PER_SQRT_SECOND) * Math.sqrt(secondsRemaining);
    const z = priceChangeFraction / sigma + (momentum?.score ?? 0) * MOMENTUM_SCALE;
    return this.normalCdf(z);
  }

  /**
   * Probability that the 60-second BRTI settlement average will be above threshold.
   * Used when secondsLeft ≤ 60 (inside the settlement window).
   *
   * @param currentPrice       - latest BRTI price
   * @param threshold          - market threshold (T-value from ticker)
   * @param samples            - BRTI prices already collected in this settlement window
   * @param accumulatedSeconds - how many seconds of the settlement window have elapsed
   * @param secondsLeft        - seconds remaining until market close (≤ 60)
   */
  calculateSettlement(
    currentPrice:       number,
    threshold:          number,
    samples:            number[],
    accumulatedSeconds: number,
    secondsLeft:        number,
  ): number {
    if (threshold <= 0) return 0.5;

    // Partial sum estimate: average of collected samples × elapsed seconds
    const partialSum = samples.length > 0
      ? (samples.reduce((a, b) => a + b, 0) / samples.length) * accumulatedSeconds
      : 0;

    const expectedAvg = (partialSum + secondsLeft * currentPrice) / 60;
    const priceChangeFraction = (expectedAvg - threshold) / threshold;

    if (secondsLeft <= 0) {
      if (priceChangeFraction > 0) return 1.0;
      if (priceChangeFraction < 0) return 0.0;
      return 0.5;
    }

    // σ of the settlement average (as a price fraction):
    // σ_avg = σ_per_√s × secondsLeft × √(secondsLeft/3) / 60
    // This reflects that averaging over secondsLeft steps reduces variance by ~1/√3.
    const sigmaAvg = SIGMA_PER_SQRT_SECOND * secondsLeft * Math.sqrt(secondsLeft / 3) / 60;
    if (sigmaAvg <= 0) return priceChangeFraction > 0 ? 1.0 : 0.0;

    const z = priceChangeFraction / sigmaAvg;
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
