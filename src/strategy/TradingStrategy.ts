import { BasketballMarket } from '../services/MarketService';
import { WinProbabilityModel } from '../services/WinProbabilityModel';

export const ENTRY_PROBABILITY_THRESHOLD = 0.9;
export const ENTRY_CONFIRMATION_THRESHOLD = 0.9;    // ask must exceed this for consecutive-tick confirmation (same as entry threshold)
export const ENTRY_CONFIRMATION_TICKS = 3;          // consecutive ticks above threshold required before entry
export const ENTRY_MAX_SECONDS = 600;               // only enter in final 10 minutes of game
export const EXIT_PROBABILITY_THRESHOLD = 0.7;
export const EXIT_PROBABILITY_GUARD = 0.85; // don't exit on bid dip if model prob is above this
export const EXIT_CONFIRMATION_TICKS = 3;   // consecutive ticks below bid threshold required to exit
export const EXIT_EMERGENCY_DROP = 0.15;    // single-tick bid crash threshold — exit immediately bypassing prob guard

// Risk 25% of current balance on a single trade
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
  private readonly highAskCounts = new Map<string, number>(); // entry confirmation
  private readonly lowBidCounts = new Map<string, number>();  // exit confirmation
  private readonly previousBids = new Map<string, number>();  // emergency exit: track last bid per position

  private isTradeable(status: string): boolean {
    return status === 'open' || status === 'active';
  }

  clearEntryConfirmation(ticker: string): void {
    this.highAskCounts.delete(ticker);
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
    openPositionsCostCents: number = 0,
  ): TradeSignal {
    if (!this.isTradeable(market.status)) {
      this.highAskCounts.delete(market.ticker);
      return { action: 'hold', reason: `Market not tradeable (status=${market.status})`, market };
    }

    // Require game state to verify time remaining
    if (!market.gameState) {
      this.highAskCounts.delete(market.ticker);
      return { action: 'hold', reason: 'No game state — cannot verify time remaining', market };
    }

    // Only enter in the final 5 minutes
    const secondsLeft = WinProbabilityModel.secondsRemaining(
      market.gameState.period,
      market.gameState.gameClock,
    );
    if (secondsLeft > ENTRY_MAX_SECONDS) {
      this.highAskCounts.delete(market.ticker);
      return {
        action: 'hold',
        reason: `${(secondsLeft / 60).toFixed(1)} min remaining — entry only in final ${ENTRY_MAX_SECONDS / 60} min`,
        market,
      };
    }

    // Ask must exceed confirmation threshold for N consecutive ticks
    // Also skip if ask is at maximum (100¢) — no profit potential and Kalshi rejects price=100
    if (market.yesAsk <= ENTRY_CONFIRMATION_THRESHOLD) {
      this.highAskCounts.delete(market.ticker);
      return {
        action: 'hold',
        reason: `Ask ${(market.yesAsk * 100).toFixed(1)}¢ at or below confirmation threshold ${ENTRY_CONFIRMATION_THRESHOLD * 100}¢`,
        market,
      };
    }
    if (market.yesAsk >= 1.0) {
      this.highAskCounts.delete(market.ticker);
      return {
        action: 'hold',
        reason: `Ask 100¢ — no profit potential, skipping`,
        market,
      };
    }

    const count = (this.highAskCounts.get(market.ticker) ?? 0) + 1;
    this.highAskCounts.set(market.ticker, count);

    if (count < ENTRY_CONFIRMATION_TICKS) {
      return {
        action: 'hold',
        reason: `Ask ${(market.yesAsk * 100).toFixed(0)}¢ above threshold — confirming entry (${count}/${ENTRY_CONFIRMATION_TICKS})`,
        market,
      };
    }

    // Entry range check
    if (market.yesAsk <= ENTRY_PROBABILITY_THRESHOLD) {
      return {
        action: 'hold',
        reason: `Ask ${(market.yesAsk * 100).toFixed(1)}¢ at or below entry threshold ${ENTRY_PROBABILITY_THRESHOLD * 100}¢`,
        market,
      };
    }

    // Size at 25% of total portfolio (cash + open positions), capped at available cash
    const totalFundsCents = availableBalanceCents + openPositionsCostCents;
    const maxSpendCents = Math.min(
      Math.floor(totalFundsCents * MAX_BALANCE_RISK_FRACTION),
      availableBalanceCents,
    );
    const costPerContractCents = Math.round(market.yesAsk * 100);
    const contracts = Math.floor(maxSpendCents / costPerContractCents);

    if (contracts <= 0) {
      return { action: 'hold', reason: 'Insufficient balance for even 1 contract', market };
    }

    const spendDollars = (contracts * costPerContractCents / 100).toFixed(2);
    const balancePct = (contracts * costPerContractCents / availableBalanceCents * 100).toFixed(1);

    return {
      action: 'buy',
      reason: `ask=${(market.yesAsk * 100).toFixed(0)}¢ confirmed ${ENTRY_CONFIRMATION_TICKS} ticks | risking $${spendDollars} (${balancePct}% of balance)`,
      market,
      suggestedContracts: contracts,
      suggestedLimitPrice: market.yesAsk,
    };
  }

  evaluateExit(market: BasketballMarket, heldContracts: number): TradeSignal {
    if (!this.isTradeable(market.status)) {
      this.lowBidCounts.delete(market.ticker);
      this.previousBids.delete(market.ticker);
      return {
        action: 'sell',
        reason: `Market ${market.status} — closing position`,
        market,
        suggestedContracts: heldContracts,
        suggestedLimitPrice: market.yesBid > 0 ? market.yesBid : 0,
      };
    }

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

  calculatePnl(entryPrice: number, exitPrice: number, contracts: number): number {
    return (exitPrice - entryPrice) * contracts;
  }
}
