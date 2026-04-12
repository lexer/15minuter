/**
 * Momentum indicators derived from the real-time BRTI tick stream.
 *
 * Indicators (computed on every 1-second BRTI tick):
 *  - RSI(30):         Relative Strength Index over the last 30 ticks.
 *                     RSI > 50 → bullish momentum, < 50 → bearish.
 *  - EMA crossover:   Fast EMA (α=2/11) and slow EMA (α=2/31).
 *                     emaFast > emaSlow → uptrend.
 *  - Dynamic σ:       Realized per-√second volatility from last 30 log-returns.
 *                     Replaces the static 80%-annual-vol assumption when live
 *                     data shows calmer or wilder conditions.
 *  - score [-1,1]:    50% RSI component + 50% EMA-cross component.
 *                     Used in BtcProbabilityModel to shift the z-score.
 *
 * Returns null until RSI_PERIOD + 1 = 31 ticks have been received.
 */

const RSI_PERIOD    = 30;   // ticks (seconds)
const EMA_FAST_P    = 10;   // fast EMA period
const EMA_SLOW_P    = 30;   // slow EMA period
const VOL_WINDOW    = 30;   // realized-volatility window (log-returns)
const MAX_BUFFER    = 120;  // keep at most 120 ticks (2 minutes)

/** 80% annual vol expressed as per-√second fraction — used as normalization anchor. */
const STATIC_SIGMA  = 0.0001424;

export interface MomentumState {
  /** RSI value 0–100.  >50 = bullish, <50 = bearish. */
  rsi:          number;
  /** 10-period exponential moving average of BRTI. */
  emaFast:      number;
  /** 30-period exponential moving average of BRTI. */
  emaSlow:      number;
  /** Realized per-√second volatility from last 30 ticks. Clamped to [0.5σ, 3σ]. */
  dynamicSigma: number;
  /** Combined momentum score in [-1, 1].  +1 = max bullish, -1 = max bearish. */
  score:        number;
}

export class BtcMomentumIndicators {
  private prices:  number[]      = [];
  private emaFast: number | null = null;
  private emaSlow: number | null = null;

  private readonly kFast = 2 / (EMA_FAST_P + 1);
  private readonly kSlow = 2 / (EMA_SLOW_P + 1);

  /**
   * Feed the latest BRTI price and receive updated momentum state.
   * Returns null for the first 31 ticks (not enough data to compute RSI).
   */
  update(price: number): MomentumState | null {
    this.prices.push(price);
    if (this.prices.length > MAX_BUFFER) this.prices.shift();

    // Update running EMAs — seeded with the first price
    this.emaFast = this.emaFast === null
      ? price
      : this.emaFast * (1 - this.kFast) + price * this.kFast;
    this.emaSlow = this.emaSlow === null
      ? price
      : this.emaSlow * (1 - this.kSlow) + price * this.kSlow;

    // Need RSI_PERIOD + 1 prices to compute RSI (need RSI_PERIOD price differences)
    if (this.prices.length < RSI_PERIOD + 1) return null;

    const rsi          = this.computeRsi();
    const dynamicSigma = this.computeRealizedSigma();

    // RSI score: (rsi - 50) / 50  → [-1, 1]
    const rsiScore = (rsi - 50) / 50;

    // EMA cross score: normalize fractional cross by typical 1-sigma over slow period,
    // then apply tanh to bound to [-1, 1]
    const emaSafe  = this.emaSlow || 1;
    const emaFrac  = (this.emaFast - emaSafe) / emaSafe;
    const emaScore = Math.tanh(emaFrac / (STATIC_SIGMA * Math.sqrt(EMA_SLOW_P)));

    const score = Math.max(-1, Math.min(1, 0.5 * rsiScore + 0.5 * emaScore));

    return { rsi, emaFast: this.emaFast, emaSlow: this.emaSlow, dynamicSigma, score };
  }

  /** Reset all state (e.g. when restarting the price feed). */
  reset(): void {
    this.prices  = [];
    this.emaFast = null;
    this.emaSlow = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  private computeRsi(): number {
    const n = this.prices.length;
    let gains  = 0;
    let losses = 0;
    for (let i = n - RSI_PERIOD; i < n; i++) {
      const diff = this.prices[i] - this.prices[i - 1];
      if (diff > 0) gains  += diff;
      else          losses -= diff;
    }
    const avgGain = gains  / RSI_PERIOD;
    const avgLoss = losses / RSI_PERIOD;
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  private computeRealizedSigma(): number {
    const n     = this.prices.length;
    const start = Math.max(1, n - VOL_WINDOW);
    const logRets: number[] = [];
    for (let i = start; i < n; i++) {
      if (this.prices[i - 1] > 0) {
        logRets.push(Math.log(this.prices[i] / this.prices[i - 1]));
      }
    }
    if (logRets.length < 2) return STATIC_SIGMA;
    const mean     = logRets.reduce((a, b) => a + b, 0) / logRets.length;
    const variance = logRets.reduce((a, r) => a + (r - mean) ** 2, 0) / (logRets.length - 1);
    // Clamp to [0.5×, 3×] the annualized static sigma
    return Math.max(STATIC_SIGMA * 0.5, Math.min(STATIC_SIGMA * 3, Math.sqrt(variance)));
  }
}
