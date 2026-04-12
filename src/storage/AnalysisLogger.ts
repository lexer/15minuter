import * as fs from 'fs';
import * as path from 'path';
import { BtcMarket } from '../services/MarketService';
import { TradeSignal } from '../strategy/TradingStrategy';
import { TradeRecord } from './TradeHistory';

function r4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export interface MarketSnapshot {
  ticker:             string;
  targetPrice:        number;       // floor_strike from API: 60s BRTI average at interval open
  priceChangePct:     number;       // (currentBrti - targetPrice) / targetPrice * 100
  settlementCount:    number;       // BRTI samples collected in settlement window
  /** Projected 60-second closing average. Present only in the final 60s (settlement window).
   *  = (mean(samples) × elapsed + currentBrti × secondsLeft) / 60 */
  sixtySecondsAvg?:   number;
  winProbability:     number;
  ask:                number;
  bid:                number;
  secondsLeft:        number;
  // Present only for markets evaluated for entry
  signal?:            'buy' | 'sell' | 'hold';
  signalReason?:      string;
  contracts?:         number;
  limitPrice?:        number;
}

export interface BtcWindowAnalysis {
  currentPrice: number;  // live BRTI value
  markets: MarketSnapshot[];
}

export interface TickAnalysis {
  timestamp: string;
  balanceDollars: number;
  btc?: BtcWindowAnalysis;
  decisions?: DecisionLog[];
  openPositions?: PositionAnalysis[];
  summary: { totalTrades: number; realizedPnl: number; unrealizedPnl: number; totalPnl: number; winRate: number };
}

export interface DecisionLog {
  type: 'entry' | 'exit' | 'hold';
  ticker: string;
  reason: string;
  contracts?: number;
  filledContracts?: number;
  price?: number;
  pnl?: number;
  orderId?: string;
  fillStatus?: 'filled' | 'partial' | 'unfilled';
}

export interface PositionAnalysis {
  ticker: string;
  contracts: number;
  entryPrice: number;
  entryProb: number;
  entryTime: string;
  currentProb?: number;
  bid?: number;
  unrealizedPnl?: number;
}

function pstDateString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function dailyLogPath(): string {
  return path.resolve(process.cwd(), `btc_analysis_${pstDateString()}.log`);
}

export class AnalysisLogger {
  private pendingTick: Partial<TickAnalysis> = {};

  startTick(balanceCents: number): void {
    this.pendingTick = {
      timestamp:     new Date().toISOString(),
      balanceDollars: balanceCents / 100,
      decisions:     [],
      openPositions: [],
    };
  }

  logBrtiState(brtiPrice: number | undefined, markets: BtcMarket[]): void {
    if (brtiPrice === undefined) return;
    this.pendingTick.btc = {
      currentPrice: brtiPrice,
      markets: markets.map((m) => {
        const secondsLeft = Math.round(m.secondsLeft);
        const snapshot: MarketSnapshot = {
          ticker:          m.ticker,
          targetPrice:     m.threshold,
          priceChangePct:  m.threshold > 0 ? r4((brtiPrice - m.threshold) / m.threshold * 100) : 0,
          settlementCount: m.settlementSamples.length,
          winProbability:  r4(m.winProbability),
          ask:             m.yesAsk,
          bid:             m.yesBid,
          secondsLeft,
        };

        // In the settlement window, compute the projected 60-second closing average:
        //   (mean(samples) × elapsedSeconds + currentBrti × secondsLeft) / 60
        if (secondsLeft <= 60 && secondsLeft > 0) {
          const elapsed    = Math.max(0, 60 - secondsLeft);
          const partialSum = m.settlementSamples.length > 0
            ? (m.settlementSamples.reduce((a, b) => a + b, 0) / m.settlementSamples.length) * elapsed
            : 0;
          snapshot.sixtySecondsAvg = r4((partialSum + secondsLeft * brtiPrice) / 60);
          // priceChangePct should compare the projected closing average against targetPrice,
          // not spot vs targetPrice — that's what actually determines resolution
          if (m.threshold > 0 && snapshot.sixtySecondsAvg !== undefined) {
            snapshot.priceChangePct = r4((snapshot.sixtySecondsAvg - m.threshold) / m.threshold * 100);
          }
        }

        return snapshot;
      }),
    };
  }

  /**
   * Attach signal data to the market snapshot inside btc.markets[].
   * Called after evaluateEntry for each candidate market.
   */
  logMarketEval(market: BtcMarket, signal: TradeSignal): void {
    if (market.yesAsk <= 0.10 || market.yesAsk >= 0.99) return;
    const btc = this.pendingTick.btc;
    if (!btc) return;
    const snapshot = btc.markets.find((m) => m.ticker === market.ticker);
    if (snapshot) {
      snapshot.signal       = signal.action === 'buy' ? 'buy' : signal.action === 'sell' ? 'sell' : 'hold';
      snapshot.signalReason = signal.reason;
      if (signal.suggestedContracts  !== undefined) snapshot.contracts  = signal.suggestedContracts;
      if (signal.suggestedLimitPrice !== undefined) snapshot.limitPrice = signal.suggestedLimitPrice;
    }
  }

  logDecision(decision: DecisionLog): void {
    // Only log entry/exit — hold decisions are redundant with signal in markets
    if (decision.type === 'hold') return;
    this.pendingTick.decisions = this.pendingTick.decisions ?? [];
    this.pendingTick.decisions.push(decision);
  }

  logOpenPositions(trades: TradeRecord[], markets: Map<string, BtcMarket>): void {
    this.pendingTick.openPositions = trades.map((t) => {
      const market        = markets.get(t.ticker);
      const currentProb   = market?.winProbability !== undefined ? r4(market.winProbability) : undefined;
      const unrealizedPnl = currentProb !== undefined
        ? Math.round((currentProb - t.pricePerContract) * t.contracts * 100) / 100
        : undefined;
      return {
        ticker:       t.ticker,
        contracts:    t.contracts,
        entryPrice:   t.pricePerContract,
        entryProb:    r4(t.winProbabilityAtEntry),
        entryTime:    t.entryTime,
        currentProb,
        bid:          market?.yesBid,
        unrealizedPnl,
      };
    });
  }

  finalizeTick(
    summary: { totalTrades: number; realizedPnl: number; winRate: number },
    unrealizedPnl: number,
  ): void {
    const decisions     = this.pendingTick.decisions ?? [];
    const openPositions = this.pendingTick.openPositions ?? [];
    const btc           = this.pendingTick.btc;

    if (!btc && decisions.length === 0 && openPositions.length === 0) {
      this.pendingTick = {};
      return;
    }

    const tick: Record<string, unknown> = {
      timestamp:      this.pendingTick.timestamp ?? new Date().toISOString(),
      balanceDollars: this.pendingTick.balanceDollars ?? 0,
      summary: {
        totalTrades:   summary.totalTrades,
        realizedPnl:   Math.round(summary.realizedPnl * 100) / 100,
        unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
        totalPnl:      Math.round((summary.realizedPnl + unrealizedPnl) * 100) / 100,
        winRate:       r4(summary.winRate),
      },
    };
    if (btc)                    tick.btc           = btc;
    if (decisions.length > 0)    tick.decisions     = decisions;
    if (openPositions.length > 0) tick.openPositions = openPositions;

    fs.appendFile(dailyLogPath(), JSON.stringify(tick) + '\n', 'utf-8', (err) => {
      if (err) process.stderr.write(`[AnalysisLogger] Failed to write tick: ${err.message}\n`);
    });
    this.pendingTick = {};
  }
}
