import { BtcMarket } from '../services/MarketService';

// ── Entry thresholds ─────────────────────────────────────────────────────────
export const ENTRY_ASK_THRESHOLD  = 0.9;   // ask must exceed this to enter (YES or NO side)
export const ENTRY_MIN_SECONDS    = 5;     // enter no closer than 5s to close (IOC buffer)
export const ENTRY_MAX_SECONDS    = 90;    // enter up to 90s before close
// Win probability thresholds for side selection:
//   winProb > 1 - ENTRY_NO_WIN_THRESHOLD (= 0.9) → buy YES
//   winProb < ENTRY_NO_WIN_THRESHOLD      (= 0.1) → buy NO
// ── Exit thresholds ──────────────────────────────────────────────────────────
export const EXIT_PROBABILITY_THRESHOLD = 0.8;  // bid ≤ this triggers soft-exit zone
export const EXIT_HARD_STOP             = 0.7;  // bid ≤ this → immediate exit, no guard
export const EXIT_CONFIRMATION_TICKS    = 3;    // consecutive soft-zone ticks before selling
export const EXIT_EMERGENCY_DROP        = 0.15; // single-tick bid crash → immediate exit

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

    const maxSpendCents = Math.min(WINDOW_BUDGET_CENTS, availableBalanceCents);

    // YES entry: market-implied probability ≥ 90¢ ask (win probability logged for analysis only)
    if (market.yesAsk > ENTRY_ASK_THRESHOLD && market.yesAsk < 1.0) {
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
    if (market.noAsk > ENTRY_ASK_THRESHOLD && market.noAsk < 1.0) {
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
   * @param suppressSoftExit - When true (liquidation cascade active), soft-zone
   *   confirmation exits are suspended. Hard stops and emergency exits still fire.
   * @param side - Which side we are holding. Defaults to 'yes'.
   *   For NO positions, uses noBid and P(NO) = 1 - winProbability.
   */
  evaluateExit(market: BtcMarket, heldContracts: number, suppressSoftExit = false, side: 'yes' | 'no' = 'yes'): TradeSignal {
    const bid     = side === 'yes' ? market.yesBid : market.noBid;
    const sideStr = side.toUpperCase();

    // Emergency exit: single-tick bid crash (≥15¢ drop) overrides probability guard
    const prevBid = this.previousBids.get(market.ticker);
    this.previousBids.set(market.ticker, bid);
    if (prevBid !== undefined && prevBid - bid >= EXIT_EMERGENCY_DROP) {
      this.lowBidCounts.delete(market.ticker);
      this.previousBids.delete(market.ticker);
      return {
        action: 'sell',
        side,
        reason: `Emergency exit: ${sideStr} bid crashed ${(prevBid * 100).toFixed(0)}¢→${(bid * 100).toFixed(0)}¢ (${((prevBid - bid) * 100).toFixed(0)}¢ drop in one tick)`,
        market,
        suggestedContracts:  heldContracts,
        suggestedLimitPrice: bid > 0 ? bid : 0,
      };
    }

    // Hard stop: bid ≤ 70¢ — exit immediately, no guard, no confirmation window
    if (bid <= EXIT_HARD_STOP) {
      this.lowBidCounts.delete(market.ticker);
      this.previousBids.delete(market.ticker);
      return {
        action: 'sell',
        side,
        reason: `Hard stop: ${sideStr} bid ${(bid * 100).toFixed(0)}¢ ≤ ${EXIT_HARD_STOP * 100}¢ — exiting immediately`,
        market,
        suggestedContracts:  heldContracts,
        suggestedLimitPrice: bid > 0 ? bid : 0,
      };
    }

    if (bid <= EXIT_PROBABILITY_THRESHOLD) {
      // During a liquidation cascade: suspend soft-zone confirmation to avoid panic sells.
      // Hard stop (above) and emergency exit (above) still fire as safety nets.
      if (suppressSoftExit) {
        this.lowBidCounts.delete(market.ticker);
        return {
          action: 'hold',
          reason: `${sideStr} bid ${(bid * 100).toFixed(0)}¢ soft zone — suspended during liquidation cascade`,
          market,
        };
      }

      const count = (this.lowBidCounts.get(market.ticker) ?? 0) + 1;
      this.lowBidCounts.set(market.ticker, count);
      if (count < EXIT_CONFIRMATION_TICKS) {
        return {
          action: 'hold',
          reason: `${sideStr} bid ${(bid * 100).toFixed(0)}¢ soft zone — confirming (${count}/${EXIT_CONFIRMATION_TICKS}) model_prob=${(market.winProbability * 100).toFixed(1)}%`,
          market,
        };
      }

      this.lowBidCounts.delete(market.ticker);
      return {
        action: 'sell',
        side,
        reason: `${sideStr} bid ${(bid * 100).toFixed(0)}¢ soft zone for ${EXIT_CONFIRMATION_TICKS} ticks`,
        market,
        suggestedContracts:  heldContracts,
        suggestedLimitPrice: bid > 0 ? bid : 0,
      };
    }

    // Bid recovered — reset counter
    this.lowBidCounts.delete(market.ticker);
    return {
      action: 'hold',
      reason: `Hold — ${sideStr} bid ${(bid * 100).toFixed(0)}¢ above exit threshold`,
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
    if (ask <= ENTRY_ASK_THRESHOLD || ask >= 1.0) {
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
