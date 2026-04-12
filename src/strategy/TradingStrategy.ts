import { BasketballMarket } from '../services/MarketService';
import { WinProbabilityModel } from '../services/WinProbabilityModel';

export const ENTRY_PROBABILITY_THRESHOLD = 0.9;
export const ENTRY_CONFIRMATION_THRESHOLD = 0.9;    // ask must exceed this to enter
export const ENTRY_MAX_SECONDS = 600;               // only enter in final 10 minutes of game
export const EXIT_PROBABILITY_THRESHOLD = 0.8;  // bid at or below this triggers soft exit (guard + confirmation)
export const EXIT_HARD_STOP = 0.7;              // bid at or below this triggers immediate exit — no guard, no confirmation
export const EXIT_PROBABILITY_GUARD = 0.85;     // don't soft-exit if model prob is above this
export const EXIT_CONFIRMATION_TICKS = 3;       // consecutive ticks below soft threshold required to exit
export const EXIT_EMERGENCY_DROP = 0.15;        // single-tick bid crash threshold — exit immediately bypassing prob guard

// Risk 25% of starting daily budget on a single trade
const MAX_BALANCE_RISK_FRACTION = 0.25;

// Quarter-Kelly: used for informational sizing only
const KELLY_FRACTION = 0.25;

export interface TradeSignal {
  action: 'buy' | 'sell' | 'hold';
  reason: string;
  market: BasketballMarket;
  suggestedContracts?: number;
  suggestedLimitPrice?: number;
}

export class TradingStrategy {
  private readonly lowBidCounts = new Map<string, number>();  // exit confirmation
  private readonly previousBids = new Map<string, number>();  // emergency exit: track last bid per position

  private isTradeable(status: string): boolean {
    return status === 'open' || status === 'active';
  }

  clearExitConfirmation(ticker: string): void {
    this.lowBidCounts.delete(ticker);
    this.previousBids.delete(ticker);
  }

  /**
   * Kelly criterion for a binary bet:
   *   edge = (prob * 1 + (1-prob) * 0 - ask) / (1 - ask)
   *        = (prob - ask) / (1 - ask)
   * Returns fraction of bankroll to wager. Negative = no edge, skip.
   */
  kellyFraction(prob: number, askPrice: number): number {
    const edge = (prob - askPrice) / (1 - askPrice);
    return edge * KELLY_FRACTION;
  }

  sizeContracts(
    prob: number,
    askPrice: number,
    availableBalanceCents: number,
  ): { contracts: number; reason?: string } {
    const kelly = this.kellyFraction(prob, askPrice);

    if (kelly <= 0) {
      return { contracts: 0, reason: `No edge (ask $${askPrice.toFixed(2)} ≥ prob ${(prob * 100).toFixed(1)}%)` };
    }

    const riskFraction = Math.min(kelly, MAX_BALANCE_RISK_FRACTION);
    const maxSpendCents = Math.floor(availableBalanceCents * riskFraction);
    const costPerContractCents = Math.round(askPrice * 100);
    const contracts = Math.floor(maxSpendCents / costPerContractCents);

    return { contracts };
  }

  evaluateEntry(
    market: BasketballMarket,
    availableBalanceCents: number,
    dailyBudgetCents: number,
  ): TradeSignal {
    if (!this.isTradeable(market.status)) {
      return { action: 'hold', reason: `Market not tradeable (status=${market.status})`, market };
    }

    // Require game state to verify time remaining
    if (!market.gameState) {
      return { action: 'hold', reason: 'No game state — cannot verify time remaining', market };
    }

    // Only enter in the final 5 minutes
    const secondsLeft = WinProbabilityModel.secondsRemaining(
      market.gameState.period,
      market.gameState.gameClock,
    );
    if (secondsLeft > ENTRY_MAX_SECONDS) {
      return {
        action: 'hold',
        reason: `${(secondsLeft / 60).toFixed(1)} min remaining — entry only in final ${ENTRY_MAX_SECONDS / 60} min`,
        market,
      };
    }

    // Ask must exceed threshold to enter; skip if at 100¢ (no profit potential, Kalshi rejects price=100)
    if (market.yesAsk <= ENTRY_CONFIRMATION_THRESHOLD) {
      return {
        action: 'hold',
        reason: `Ask ${(market.yesAsk * 100).toFixed(1)}¢ at or below entry threshold ${ENTRY_CONFIRMATION_THRESHOLD * 100}¢`,
        market,
      };
    }
    if (market.yesAsk >= 1.0) {
      return {
        action: 'hold',
        reason: `Ask 100¢ — no profit potential, skipping`,
        market,
      };
    }

    // Size at 25% of starting daily budget, capped at available cash
    const maxSpendCents = Math.min(
      Math.floor(dailyBudgetCents * MAX_BALANCE_RISK_FRACTION),
      availableBalanceCents,
    );
    const costPerContractCents = Math.round(market.yesAsk * 100);
    const contracts = Math.floor(maxSpendCents / costPerContractCents);

    if (contracts <= 0) {
      return { action: 'hold', reason: 'Insufficient balance for even 1 contract', market };
    }

    const spendDollars = (contracts * market.yesAsk).toFixed(2);
    const balancePct = (contracts * costPerContractCents / availableBalanceCents * 100).toFixed(1);

    return {
      action: 'buy',
      reason: `ask=${(market.yesAsk * 100).toFixed(0)}¢ | risking $${spendDollars} (${balancePct}% of balance)`,
      market,
      suggestedContracts: contracts,
      suggestedLimitPrice: market.yesAsk,
    };
  }

  evaluateExit(market: BasketballMarket, heldContracts: number): TradeSignal {
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
        suggestedContracts: heldContracts,
        suggestedLimitPrice: market.yesBid > 0 ? market.yesBid : 0,
      };
    }

    // Hard stop: bid at or below floor — exit immediately, no guard, no confirmation window
    if (market.yesBid <= EXIT_HARD_STOP) {
      this.lowBidCounts.delete(market.ticker);
      this.previousBids.delete(market.ticker);
      return {
        action: 'sell',
        reason: `Hard stop: bid ${(market.yesBid * 100).toFixed(0)}¢ ≤ ${EXIT_HARD_STOP * 100}¢ — exiting immediately`,
        market,
        suggestedContracts: heldContracts,
        suggestedLimitPrice: market.yesBid > 0 ? market.yesBid : 0,
      };
    }

    if (market.yesBid <= EXIT_PROBABILITY_THRESHOLD) {
      // Probability guard: suppress exit if model still shows high confidence
      if (market.winProbability >= EXIT_PROBABILITY_GUARD) {
        this.lowBidCounts.delete(market.ticker);
        return {
          action: 'hold',
          reason: `Bid ${(market.yesBid * 100).toFixed(0)}¢ below threshold but prob=${(market.winProbability * 100).toFixed(1)}% above guard ${EXIT_PROBABILITY_GUARD * 100}% — ignoring dip`,
          market,
        };
      }

      // Confirmation window: require N consecutive low-bid ticks
      const count = (this.lowBidCounts.get(market.ticker) ?? 0) + 1;
      this.lowBidCounts.set(market.ticker, count);

      if (count < EXIT_CONFIRMATION_TICKS) {
        return {
          action: 'hold',
          reason: `Bid ${(market.yesBid * 100).toFixed(0)}¢ below threshold — confirming (${count}/${EXIT_CONFIRMATION_TICKS})`,
          market,
        };
      }

      this.lowBidCounts.delete(market.ticker);
      return {
        action: 'sell',
        reason: `Bid ${(market.yesBid * 100).toFixed(0)}¢ below exit threshold for ${EXIT_CONFIRMATION_TICKS} ticks`,
        market,
        suggestedContracts: heldContracts,
        suggestedLimitPrice: market.yesBid > 0 ? market.yesBid : 0,
      };
    }

    // Bid recovered — reset counter
    this.lowBidCounts.delete(market.ticker);
    return { action: 'hold', reason: `Hold — bid ${(market.yesBid * 100).toFixed(0)}¢ above exit threshold`, market };
  }

  /**
   * Check if an existing open position should be topped up to target size.
   * No confirmation window — we're already committed to this position.
   * Returns contracts to buy (0 if already at target or entry criteria not met).
   */
  evaluateTopUp(
    market: BasketballMarket,
    heldContracts: number,
    balanceCents: number,
    dailyBudgetCents: number,
  ): { contracts: number; reason: string } {
    if (!market.gameState) {
      return { contracts: 0, reason: 'No game state' };
    }

    const secondsLeft = WinProbabilityModel.secondsRemaining(
      market.gameState.period,
      market.gameState.gameClock,
    );
    if (secondsLeft > ENTRY_MAX_SECONDS) {
      return { contracts: 0, reason: `Outside entry window (${(secondsLeft / 60).toFixed(1)} min left)` };
    }

    if (market.yesAsk <= ENTRY_CONFIRMATION_THRESHOLD || market.yesAsk >= 1.0) {
      return { contracts: 0, reason: `Ask ${(market.yesAsk * 100).toFixed(0)}¢ outside entry range` };
    }

    const maxSpendCents = Math.min(
      Math.floor(dailyBudgetCents * MAX_BALANCE_RISK_FRACTION),
      balanceCents,
    );
    const costPerContractCents = Math.round(market.yesAsk * 100);
    const targetContracts = Math.floor(maxSpendCents / costPerContractCents);
    const topUp = Math.max(0, targetContracts - heldContracts);

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
