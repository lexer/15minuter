import { BtcMarket } from '../services/MarketService';

// ── Entry thresholds ─────────────────────────────────────────────────────────
export const ENTRY_ASK_THRESHOLD  = 0.9;   // ask must exceed this to enter (YES or NO side)
export const ENTRY_MAX_ASK        = 0.98;  // ask must not exceed this (avoid 99¢+ illiquid fills)
export const ENTRY_MIN_SECONDS    = 0;     // enter right up to market close
export const ENTRY_MAX_SECONDS    = 90;    // enter up to 90s before close

// ── Exit thresholds ──────────────────────────────────────────────────────────
/** Take-profit: bid ≥ 99¢ → sell immediately, locking in near-maximum gain. */
export const EXIT_TAKE_PROFIT = 0.99;
/** Hard stop: bid ≤ 60¢ → sell immediately. Caps max loss at ~30¢/contract. */
export const EXIT_HARD_STOP = 0.6;

// ── Sizing ───────────────────────────────────────────────────────────────────
/** Maximum spend per 15-minute window: $10. */
export const WINDOW_BUDGET_CENTS = 1_000;

export interface TradeSignal {
  action: 'buy' | 'sell' | 'hold';
  /** Which side of the market to trade. Required for 'buy'/'sell', omitted for 'hold'. */
  side?: 'yes' | 'no';
  reason: string;
  market: BtcMarket;
  suggestedContracts?: number;
  /** For YES: limit price in dollars. For NO: limit price in NO dollars (e.g. 0.06). */
  suggestedLimitPrice?: number;
}

export class TradingStrategy {
  private isTradeable(status: string): boolean {
    return status === 'open' || status === 'active';
  }

  evaluateEntry(market: BtcMarket, availableBalanceCents: number): TradeSignal {
    if (!this.isTradeable(market.status)) {
      return { action: 'hold', reason: `Market not tradeable (status=${market.status})`, market };
    }

    if (!market.isInTradingWindow) {
      return {
        action: 'hold',
        reason: `${market.secondsLeft.toFixed(0)}s remaining — entry window: ${ENTRY_MIN_SECONDS}–${ENTRY_MAX_SECONDS}s before close`,
        market,
      };
    }

    const maxSpendCents = Math.min(WINDOW_BUDGET_CENTS, availableBalanceCents);

    // YES entry: market-implied probability ≥ 90¢ ask (win probability logged for analysis only)
    if (market.yesAsk > ENTRY_ASK_THRESHOLD && market.yesAsk <= ENTRY_MAX_ASK) {
      const costCents = Math.round(market.yesAsk * 100);
      const contracts = Math.floor(maxSpendCents / costCents);
      if (contracts > 0) {
        const spendDollars = (contracts * market.yesAsk).toFixed(2);
        const balancePct   = (contracts * costCents / availableBalanceCents * 100).toFixed(1);
        return {
          action: 'buy',
          side:   'yes',
          reason: `YES ask=${(market.yesAsk * 100).toFixed(0)}¢ model_prob=${(market.winProbability * 100).toFixed(1)}% | ${market.secondsLeft.toFixed(0)}s left | risking $${spendDollars} (${balancePct}% of balance)`,
          market,
          suggestedContracts:  contracts,
          suggestedLimitPrice: market.yesAsk,
        };
      }
    }

    // NO entry: market-implied NO probability ≥ 90¢ ask (YES bid < 10¢)
    if (market.noAsk > ENTRY_ASK_THRESHOLD && market.noAsk <= ENTRY_MAX_ASK) {
      const costCents = Math.round(market.noAsk * 100);
      const contracts = Math.floor(maxSpendCents / costCents);
      if (contracts > 0) {
        const spendDollars = (contracts * market.noAsk).toFixed(2);
        const balancePct   = (contracts * costCents / availableBalanceCents * 100).toFixed(1);
        return {
          action: 'buy',
          side:   'no',
          reason: `NO ask=${(market.noAsk * 100).toFixed(0)}¢ model_prob=${((1 - market.winProbability) * 100).toFixed(1)}% | ${market.secondsLeft.toFixed(0)}s left | risking $${spendDollars} (${balancePct}% of balance)`,
          market,
          suggestedContracts:  contracts,
          suggestedLimitPrice: market.noAsk,
        };
      }
    }

    return {
      action: 'hold',
      reason: `YES ask=${(market.yesAsk * 100).toFixed(0)}¢ NO ask=${(market.noAsk * 100).toFixed(0)}¢ model_prob=${(market.winProbability * 100).toFixed(1)}% — no qualifying side`,
      market,
    };
  }

  /**
   * Single exit rule: hard stop when bid ≤ 60¢, hold otherwise.
   * Uses YES bid for YES positions, NO bid (= 1 − yesAsk) for NO positions.
   */
  evaluateExit(market: BtcMarket, heldContracts: number, side: 'yes' | 'no' = 'yes'): TradeSignal {
    const bid     = side === 'yes' ? market.yesBid : market.noBid;
    const sideStr = side.toUpperCase();

    if (bid >= EXIT_TAKE_PROFIT) {
      return {
        action: 'sell',
        side,
        reason: `Take profit: ${sideStr} bid ${(bid * 100).toFixed(0)}¢ ≥ ${EXIT_TAKE_PROFIT * 100}¢ — locking in gain`,
        market,
        suggestedContracts:  heldContracts,
        suggestedLimitPrice: bid,
      };
    }

    if (bid <= EXIT_HARD_STOP) {
      return {
        action: 'sell',
        side,
        reason: `Hard stop: ${sideStr} bid ${(bid * 100).toFixed(0)}¢ ≤ ${EXIT_HARD_STOP * 100}¢ — exiting immediately`,
        market,
        suggestedContracts:  heldContracts,
        suggestedLimitPrice: bid > 0 ? bid : 0,
      };
    }

    return {
      action: 'hold',
      reason: `Hold — ${sideStr} bid ${(bid * 100).toFixed(0)}¢ above ${EXIT_HARD_STOP * 100}¢ threshold model_prob=${(market.winProbability * 100).toFixed(1)}%`,
      market,
    };
  }

  /**
   * Check if an existing open position should be topped up to the window budget limit.
   * Returns contracts to buy (0 if already at target or entry criteria not met).
   */
  evaluateTopUp(
    market: BtcMarket,
    heldContracts: number,
    balanceCents: number,
    side: 'yes' | 'no' = 'yes',
  ): { contracts: number; reason: string } {
    if (!market.isInTradingWindow) {
      return { contracts: 0, reason: `Outside entry window (${market.secondsLeft.toFixed(0)}s left)` };
    }

    const ask = side === 'yes' ? market.yesAsk : market.noAsk;
    if (ask <= ENTRY_ASK_THRESHOLD || ask > ENTRY_MAX_ASK) {
      return { contracts: 0, reason: `${side.toUpperCase()} ask ${(ask * 100).toFixed(0)}¢ outside entry range` };
    }

    const maxSpendCents        = Math.min(WINDOW_BUDGET_CENTS, balanceCents);
    const costPerContractCents = Math.round(ask * 100);
    const targetContracts      = Math.floor(maxSpendCents / costPerContractCents);
    const topUp                = Math.max(0, targetContracts - heldContracts);

    if (topUp <= 0) {
      return { contracts: 0, reason: `Already at target size (held=${heldContracts} target=${targetContracts})` };
    }

    return {
      contracts: topUp,
      reason: `Top-up shortfall: have ${heldContracts}, target ${targetContracts} (${side.toUpperCase()} ask=${(ask * 100).toFixed(0)}¢)`,
    };
  }

  calculatePnl(entryPrice: number, exitPrice: number, contracts: number): number {
    return (exitPrice - entryPrice) * contracts;
  }
}
