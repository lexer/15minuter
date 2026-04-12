/**
 * BTC 15-minute window win-probability model using a Gaussian random walk
 * with realized volatility estimated from the current 15-minute interval.
 *
 * Sigma (per-√second) priority:
 *  1. Interval realized vol  — computed from BRTI log-returns since interval start.
 *                              Requires ≥10 log-returns; clamped to [0.5σ, 3σ] of static.
 *  2. Momentum dynamic sigma — last-30-tick realized vol from BtcMomentumIndicators.
 *  3. Static sigma           — 80% annual BTC vol: 0.80/√(365×24×3600) ≈ 0.0001424.
 *
 * Two calculation modes:
 *
 * 1. Pre-settlement (secondsLeft > 60):
 *    Φ(z)  where  z = priceChangeFraction / (σ_eff × √secondsLeft) + score × MOMENTUM_SCALE
 *
 * 2. Settlement window (secondsLeft ≤ 60):
 *    KXBTC15M resolves YES if the 60-second BRTI average at close ≥ floor_strike
 *    (the 60-second BRTI average at the start of the 15-min window).
 *    We accumulate BRTI samples and model the expected settlement average.
 *    The probability estimate sharpens as samples accumulate.
 *
 *    σ_avg = σ_eff × secondsLeft × √(secondsLeft/3) / 60
 *    Momentum adjustment is NOT applied in settlement mode (price path is nearly fixed).
 */

import { MomentumState } from './BtcMomentumIndicators';

export const SIGMA_PER_SQRT_SECOND = 0.0001424; // 80% annual vol per √second
const MOMENTUM_SCALE = 1.5;
const MIN_INTERVAL_LOG_RETURNS = 10; // minimum returns for interval sigma estimate

export class BtcProbabilityModel {
  /**
   * Probability that BTC price stays above threshold at expiry.
   * Used when secondsLeft > 60 (pre-settlement window).
   *
   * @param priceChangeFraction - (currentBrti - threshold) / threshold
   * @param secondsRemaining    - seconds until the 15-min window closes
   * @param intervalPrices      - BRTI prices from interval start; used for realized sigma
   * @param momentum            - momentum state; score shifts z-score if no interval sigma
   */
  calculate(
    priceChangeFraction: number,
    secondsRemaining:    number,
    intervalPrices?:     number[] | null,
    momentum?:           MomentumState | null,
  ): number {
    if (secondsRemaining <= 0) {
      if (priceChangeFraction > 0) return 1.0;
      if (priceChangeFraction < 0) return 0.0;
      return 0.5;
    }

    const sigmaPerSqrtS = this.resolveSigma(intervalPrices, momentum);
    const sigma = sigmaPerSqrtS * Math.sqrt(secondsRemaining);
    const z = priceChangeFraction / sigma + (momentum?.score ?? 0) * MOMENTUM_SCALE;
    return this.normalCdf(z);
  }

  /**
   * Probability that the 60-second BRTI settlement average will be above threshold.
   * Used when secondsLeft ≤ 60 (inside the settlement window).
   *
   * @param currentPrice       - latest BRTI price
   * @param threshold          - floor_strike from market (opening BRTI average)
   * @param samples            - BRTI prices already collected in this settlement window
   * @param accumulatedSeconds - how many seconds of the settlement window have elapsed
   * @param secondsLeft        - seconds remaining until market close (≤ 60)
   * @param intervalPrices     - BRTI prices from interval start; used for realized sigma
   */
  calculateSettlement(
    currentPrice:       number,
    threshold:          number,
    samples:            number[],
    accumulatedSeconds: number,
    secondsLeft:        number,
    intervalPrices?:    number[] | null,
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
    // σ_avg = σ_eff × secondsLeft × √(secondsLeft/3) / 60
    const sigmaBase = this.resolveSigma(intervalPrices, null);
    const sigmaAvg = sigmaBase * secondsLeft * Math.sqrt(secondsLeft / 3) / 60;
    if (sigmaAvg <= 0) return priceChangeFraction > 0 ? 1.0 : 0.0;

    const z = priceChangeFraction / sigmaAvg;
    return this.normalCdf(z);
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /**
   * Returns the best available sigma estimate (per √second):
   *  1. Interval realized vol from prices (if ≥10 log-returns available)
   *  2. Momentum dynamic sigma
   *  3. Static 80%-annual sigma
   */
  private resolveSigma(intervalPrices: number[] | null | undefined, momentum: MomentumState | null | undefined): number {
    const intervalSigma = intervalPrices ? this.computeSigmaFromPrices(intervalPrices) : null;
    return intervalSigma ?? momentum?.dynamicSigma ?? SIGMA_PER_SQRT_SECOND;
  }

  /**
   * Computes realized per-√second sigma from an array of consecutive BRTI prices.
   * Returns null if there are fewer than MIN_INTERVAL_LOG_RETURNS log-returns.
   * Clamped to [0.5×, 3×] the static sigma.
   */
  computeSigmaFromPrices(prices: number[]): number | null {
    if (prices.length < MIN_INTERVAL_LOG_RETURNS + 1) return null;
    const logRets: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) {
        logRets.push(Math.log(prices[i] / prices[i - 1]));
      }
    }
    if (logRets.length < MIN_INTERVAL_LOG_RETURNS) return null;
    const mean     = logRets.reduce((a, b) => a + b, 0) / logRets.length;
    const variance = logRets.reduce((a, r) => a + (r - mean) ** 2, 0) / (logRets.length - 1);
    const sigma    = Math.sqrt(variance);
    return Math.max(SIGMA_PER_SQRT_SECOND * 0.5, Math.min(SIGMA_PER_SQRT_SECOND * 3, sigma));
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
