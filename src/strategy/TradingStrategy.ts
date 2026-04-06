import { BasketballMarket } from '../services/MarketService';

export const ENTRY_PROBABILITY_THRESHOLD = 0.9;
export const EXIT_PROBABILITY_THRESHOLD = 0.8;
export const EXIT_PROBABILITY_GUARD = 0.85; // don't exit on bid dip if model prob is above this
export const EXIT_CONFIRMATION_TICKS = 3;   // consecutive ticks below bid threshold required to exit
export const MAX_CONTRACTS_PER_TRADE = 50;

// Quarter-Kelly: risk this fraction of balance per trade, scaled by edge
const KELLY_FRACTION = 0.25;

// Risk at least 25% of current balance on a single trade
const MAX_BALANCE_RISK_FRACTION = 0.25;

export interface TradeSignal {
  action: 'buy' | 'sell' | 'hold';
  reason: string;
  market: BasketballMarket;
  suggestedContracts?: number;
  suggestedLimitPrice?: number;
}

export class TradingStrategy {
  private readonly lowBidCounts = new Map<string, number>();

  private isTradeable(status: string): boolean {
    return status === 'open' || status === 'active';
  }

  clearExitConfirmation(ticker: string): void {
    this.lowBidCounts.delete(ticker);
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

    // Cap at MAX_BALANCE_RISK_FRACTION regardless of Kelly
    const riskFraction = Math.min(kelly, MAX_BALANCE_RISK_FRACTION);
    const maxSpendCents = Math.floor(availableBalanceCents * riskFraction);
    const costPerContractCents = Math.round(askPrice * 100);

    const contracts = Math.min(
      MAX_CONTRACTS_PER_TRADE,
      Math.floor(maxSpendCents / costPerContractCents),
    );

    return { contracts };
  }

  evaluateEntry(market: BasketballMarket, availableBalanceCents: number): TradeSignal {
    if (!this.isTradeable(market.status)) {
      return { action: 'hold', reason: `Market not tradeable (status=${market.status})`, market };
    }

    if (market.yesAsk <= ENTRY_PROBABILITY_THRESHOLD) {
      return {
        action: 'hold',
        reason: `Ask ${(market.yesAsk * 100).toFixed(1)}¢ at or below entry threshold ${ENTRY_PROBABILITY_THRESHOLD * 100}¢`,
        market,
      };
    }

    if (market.yesAsk >= 1.0) {
      return { action: 'hold', reason: 'Ask at $1.00 — no upside', market };
    }

    if (market.yesAsk <= 0) {
      return { action: 'hold', reason: 'Invalid ask price', market };
    }

    // Size at 25% of balance — no contract count cap, balance fraction governs
    const maxSpendCents = Math.floor(availableBalanceCents * MAX_BALANCE_RISK_FRACTION);
    const costPerContractCents = Math.round(market.yesAsk * 100);
    const contracts = Math.floor(maxSpendCents / costPerContractCents);

    if (contracts <= 0) {
      return { action: 'hold', reason: 'Insufficient balance for even 1 contract', market };
    }

    const spendDollars = (contracts * costPerContractCents / 100).toFixed(2);
    const balancePct = (contracts * costPerContractCents / availableBalanceCents * 100).toFixed(1);

    return {
      action: 'buy',
      reason: `ask=${(market.yesAsk * 100).toFixed(0)}¢ > ${ENTRY_PROBABILITY_THRESHOLD * 100}¢ | risking $${spendDollars} (${balancePct}% of balance)`,
      market,
      suggestedContracts: contracts,
      suggestedLimitPrice: market.yesAsk,
    };
  }

  evaluateExit(market: BasketballMarket, heldContracts: number): TradeSignal {
    if (!this.isTradeable(market.status)) {
      this.lowBidCounts.delete(market.ticker);
      return {
        action: 'sell',
        reason: `Market ${market.status} — closing position`,
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
