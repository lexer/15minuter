import { BasketballMarket } from '../services/MarketService';

export const ENTRY_PROBABILITY_THRESHOLD = 0.9;
export const EXIT_PROBABILITY_THRESHOLD = 0.8;
export const MAX_CONTRACTS_PER_TRADE = 10;
export const MAX_COST_PER_TRADE_CENTS = 5_000; // $50 max per trade

export interface TradeSignal {
  action: 'buy' | 'sell' | 'hold';
  reason: string;
  market: BasketballMarket;
  suggestedContracts?: number;
  suggestedLimitPrice?: number;
}

export class TradingStrategy {
  evaluateEntry(market: BasketballMarket, availableBalanceCents: number): TradeSignal {
    if (market.status !== 'open') {
      return { action: 'hold', reason: 'Market not open', market };
    }

    if (market.winProbability <= ENTRY_PROBABILITY_THRESHOLD) {
      return {
        action: 'hold',
        reason: `Win probability ${(market.winProbability * 100).toFixed(1)}% below entry threshold ${ENTRY_PROBABILITY_THRESHOLD * 100}%`,
        market,
      };
    }

    // Use the ask price for buying yes contracts
    const limitPrice = market.yesAsk > 0 ? market.yesAsk : market.winProbability;
    const costPerContract = Math.round(limitPrice * 100);
    if (costPerContract <= 0) {
      return { action: 'hold', reason: 'Invalid price', market };
    }

    const maxAffordable = Math.floor(
      Math.min(MAX_COST_PER_TRADE_CENTS, availableBalanceCents) / costPerContract,
    );
    const contracts = Math.min(MAX_CONTRACTS_PER_TRADE, maxAffordable);

    if (contracts <= 0) {
      return { action: 'hold', reason: 'Insufficient balance for even 1 contract', market };
    }

    return {
      action: 'buy',
      reason: `Win probability ${(market.winProbability * 100).toFixed(1)}% exceeds entry threshold`,
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

    if (market.status !== 'open') {
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

  calculatePnl(
    entryPrice: number,
    exitPrice: number,
    contracts: number,
  ): number {
    return (exitPrice - entryPrice) * contracts;
  }
}
