import { BasketballMarket } from '../services/MarketService';

export const ENTRY_PROBABILITY_THRESHOLD = 0.9;
export const EXIT_PROBABILITY_THRESHOLD = 0.8;
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
    if (market.yesBid <= EXIT_PROBABILITY_THRESHOLD) {
      return {
        action: 'sell',
        reason: `Bid ${(market.yesBid * 100).toFixed(0)}¢ below exit threshold ${EXIT_PROBABILITY_THRESHOLD * 100}¢`,
        market,
        suggestedContracts: heldContracts,
        suggestedLimitPrice: market.yesBid > 0 ? market.yesBid : 0,
      };
    }

    if (!this.isTradeable(market.status)) {
      return {
        action: 'sell',
        reason: `Market ${market.status} — closing position`,
        market,
        suggestedContracts: heldContracts,
        suggestedLimitPrice: market.yesBid > 0 ? market.yesBid : 0,
      };
    }

    return { action: 'hold', reason: `Hold — bid ${(market.yesBid * 100).toFixed(0)}¢ above exit threshold`, market };
  }

  calculatePnl(entryPrice: number, exitPrice: number, contracts: number): number {
    return (exitPrice - entryPrice) * contracts;
  }
}
