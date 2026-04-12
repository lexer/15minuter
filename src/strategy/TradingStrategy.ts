import { BtcMarket } from '../services/MarketService';

// ── Entry thresholds ─────────────────────────────────────────────────────────
export const ENTRY_ASK_THRESHOLD  = 0.9;   // YES ask must exceed this to enter
export const ENTRY_MIN_SECONDS    = 60;    // enter no closer than 60s to close
export const ENTRY_MAX_SECONDS    = 300;   // enter no earlier than 300s before close

// ── Exit thresholds ──────────────────────────────────────────────────────────
export const EXIT_PROBABILITY_THRESHOLD = 0.8;  // bid ≤ this triggers soft-exit zone
export const EXIT_HARD_STOP             = 0.7;  // bid ≤ this → immediate exit, no guard
export const EXIT_PROBABILITY_GUARD     = 0.85; // suppress soft exit if model prob ≥ this
export const EXIT_CONFIRMATION_TICKS    = 3;    // consecutive soft-zone ticks before selling
export const EXIT_EMERGENCY_DROP        = 0.15; // single-tick bid crash → immediate exit

// ── Sizing ───────────────────────────────────────────────────────────────────
/** Maximum spend per 15-minute window: $10. */
export const WINDOW_BUDGET_CENTS = 1_000;

export interface TradeSignal {
  action: 'buy' | 'sell' | 'hold';
  reason: string;
  market: BtcMarket;
  suggestedContracts?: number;
  suggestedLimitPrice?: number;
}

export class TradingStrategy {
  private readonly lowBidCounts = new Map<string, number>(); // soft-exit confirmation
  private readonly previousBids = new Map<string, number>(); // emergency exit tracking

  private isTradeable(status: string): boolean {
    return status === 'open' || status === 'active';
  }

  clearExitConfirmation(ticker: string): void {
    this.lowBidCounts.delete(ticker);
    this.previousBids.delete(ticker);
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

    if (market.yesAsk <= ENTRY_ASK_THRESHOLD) {
      return {
        action: 'hold',
        reason: `Ask ${(market.yesAsk * 100).toFixed(1)}¢ ≤ entry threshold ${ENTRY_ASK_THRESHOLD * 100}¢`,
        market,
      };
    }
    if (market.yesAsk >= 1.0) {
      return { action: 'hold', reason: 'Ask 100¢ — no profit potential', market };
    }

    // Size: up to $10 window budget, capped at available cash
    const maxSpendCents         = Math.min(WINDOW_BUDGET_CENTS, availableBalanceCents);
    const costPerContractCents  = Math.round(market.yesAsk * 100);
    const contracts             = Math.floor(maxSpendCents / costPerContractCents);

    if (contracts <= 0) {
      return { action: 'hold', reason: 'Insufficient balance for 1 contract', market };
    }

    const spendDollars = (contracts * market.yesAsk).toFixed(2);
    const balancePct   = (contracts * costPerContractCents / availableBalanceCents * 100).toFixed(1);

    return {
      action: 'buy',
      reason: `ask=${(market.yesAsk * 100).toFixed(0)}¢ | ${market.secondsLeft.toFixed(0)}s left | risking $${spendDollars} (${balancePct}% of balance)`,
      market,
      suggestedContracts:   contracts,
      suggestedLimitPrice:  market.yesAsk,
    };
  }

  evaluateExit(market: BtcMarket, heldContracts: number): TradeSignal {
    // Emergency exit: single-tick bid crash (≥15¢ drop) overrides probability guard
    const prevBid = this.previousBids.get(market.ticker);
    this.previousBids.set(market.ticker, market.yesBid);
    if (prevBid !== undefined && prevBid - market.yesBid >= EXIT_EMERGENCY_DROP) {
      this.lowBidCounts.delete(market.ticker);
      this.previousBids.delete(market.ticker);
      return {
        action: 'sell',
        reason: `Emergency exit: bid crashed ${(prevBid * 100).toFixed(0)}¢→${(market.yesBid * 100).toFixed(0)}¢ (${((prevBid - market.yesBid) * 100).toFixed(0)}¢ drop in one tick)`,
        market,
        suggestedContracts:  heldContracts,
        suggestedLimitPrice: market.yesBid > 0 ? market.yesBid : 0,
      };
    }

    // Hard stop: bid ≤ 70¢ — exit immediately, no guard, no confirmation window
    if (market.yesBid <= EXIT_HARD_STOP) {
      this.lowBidCounts.delete(market.ticker);
      this.previousBids.delete(market.ticker);
      return {
        action: 'sell',
        reason: `Hard stop: bid ${(market.yesBid * 100).toFixed(0)}¢ ≤ ${EXIT_HARD_STOP * 100}¢ — exiting immediately`,
        market,
        suggestedContracts:  heldContracts,
        suggestedLimitPrice: market.yesBid > 0 ? market.yesBid : 0,
      };
    }

    if (market.yesBid <= EXIT_PROBABILITY_THRESHOLD) {
      // Probability guard: suppress exit if model still shows high confidence
      if (market.winProbability >= EXIT_PROBABILITY_GUARD) {
        this.lowBidCounts.delete(market.ticker);
        return {
          action: 'hold',
          reason: `Bid ${(market.yesBid * 100).toFixed(0)}¢ soft zone but prob=${(market.winProbability * 100).toFixed(1)}% above guard — holding`,
          market,
        };
      }

      const count = (this.lowBidCounts.get(market.ticker) ?? 0) + 1;
      this.lowBidCounts.set(market.ticker, count);
      if (count < EXIT_CONFIRMATION_TICKS) {
        return {
          action: 'hold',
          reason: `Bid ${(market.yesBid * 100).toFixed(0)}¢ soft zone — confirming (${count}/${EXIT_CONFIRMATION_TICKS})`,
          market,
        };
      }

      this.lowBidCounts.delete(market.ticker);
      return {
        action: 'sell',
        reason: `Bid ${(market.yesBid * 100).toFixed(0)}¢ soft zone for ${EXIT_CONFIRMATION_TICKS} ticks`,
        market,
        suggestedContracts:  heldContracts,
        suggestedLimitPrice: market.yesBid > 0 ? market.yesBid : 0,
      };
    }

    // Bid recovered — reset counter
    this.lowBidCounts.delete(market.ticker);
    return {
      action: 'hold',
      reason: `Hold — bid ${(market.yesBid * 100).toFixed(0)}¢ above exit threshold`,
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
  ): { contracts: number; reason: string } {
    if (!market.isInTradingWindow) {
      return { contracts: 0, reason: `Outside entry window (${market.secondsLeft.toFixed(0)}s left)` };
    }
    if (market.yesAsk <= ENTRY_ASK_THRESHOLD || market.yesAsk >= 1.0) {
      return { contracts: 0, reason: `Ask ${(market.yesAsk * 100).toFixed(0)}¢ outside entry range` };
    }

    const maxSpendCents        = Math.min(WINDOW_BUDGET_CENTS, balanceCents);
    const costPerContractCents = Math.round(market.yesAsk * 100);
    const targetContracts      = Math.floor(maxSpendCents / costPerContractCents);
    const topUp                = Math.max(0, targetContracts - heldContracts);

    if (topUp <= 0) {
      return { contracts: 0, reason: `Already at target size (held=${heldContracts} target=${targetContracts})` };
    }

    return {
      contracts: topUp,
      reason: `Top-up shortfall: have ${heldContracts}, target ${targetContracts} (ask=${(market.yesAsk * 100).toFixed(0)}¢)`,
    };
  }

  calculatePnl(entryPrice: number, exitPrice: number, contracts: number): number {
    return (exitPrice - entryPrice) * contracts;
  }
}
