import { BasketballMarket } from '../services/MarketService';

export const ENTRY_PROBABILITY_THRESHOLD = 0.9;
export const EXIT_PROBABILITY_THRESHOLD = 0.8;
export const MAX_CONTRACTS_PER_TRADE = 50;

// Quarter-Kelly: risk this fraction of balance per trade, scaled by edge
const KELLY_FRACTION = 0.25;

// Never risk more than 10% of current balance on a single trade
const MAX_BALANCE_RISK_FRACTION = 0.1;

export interface TradeSignal {
  action: 'buy' | 'sell' | 'hold';
  reason: string;
  market: BasketballMarket;
  suggestedContracts?: number;
  suggestedLimitPrice?: number;
}

export class TradingStrategy {
  private isTradeable(status: string): boolean {
    return status === 'open' || status === 'active';
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

    // Market ask must cross 90¢ first (momentum trigger); model edge is validated below via Kelly
    if (market.yesAsk <= ENTRY_PROBABILITY_THRESHOLD) {
      return {
        action: 'hold',
        reason: `Ask ${(market.yesAsk * 100).toFixed(1)}¢ below entry threshold ${ENTRY_PROBABILITY_THRESHOLD * 100}¢ — market not confirming`,
        market,
      };
    }

    const limitPrice = market.yesAsk > 0 ? market.yesAsk : market.winProbability;
    if (limitPrice <= 0) {
      return { action: 'hold', reason: 'Invalid price', market };
    }

    const { contracts, reason } = this.sizeContracts(
      market.winProbability,
      limitPrice,
      availableBalanceCents,
    );

    if (contracts <= 0) {
      return {
        action: 'hold',
        reason: reason ?? 'Insufficient balance for even 1 contract',
        market,
      };
    }

    const spendDollars = (contracts * Math.round(limitPrice * 100) / 100).toFixed(2);
    const balancePct = (contracts * limitPrice * 100 / availableBalanceCents * 100).toFixed(1);

    return {
      action: 'buy',
      reason: `prob=${( market.winProbability * 100).toFixed(1)}% | kelly=${(this.kellyFraction(market.winProbability, limitPrice) * 100).toFixed(1)}% | risking $${spendDollars} (${balancePct}% of balance)`,
      market,
      suggestedContracts: contracts,
      suggestedLimitPrice: limitPrice,
    };
  }

  evaluateExit(market: BasketballMarket, heldContracts: number): TradeSignal {
    if (market.winProbability <= EXIT_PROBABILITY_THRESHOLD) {
      const limitPrice = market.yesBid > 0 ? market.yesBid : market.winProbability;
      return {
        action: 'sell',
        reason: `Win probability ${(market.winProbability * 100).toFixed(1)}% dropped below exit threshold ${EXIT_PROBABILITY_THRESHOLD * 100}%`,
        market,
        suggestedContracts: heldContracts,
        suggestedLimitPrice: limitPrice,
      };
    }

    if (!this.isTradeable(market.status)) {
      return {
        action: 'sell',
        reason: `Market ${market.status} — closing position`,
        market,
        suggestedContracts: heldContracts,
        suggestedLimitPrice: market.yesBid > 0 ? market.yesBid : market.winProbability,
      };
    }

    return { action: 'hold', reason: 'Hold — probability still above exit threshold', market };
  }

  calculatePnl(entryPrice: number, exitPrice: number, contracts: number): number {
    return (exitPrice - entryPrice) * contracts;
  }
}
