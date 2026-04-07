import * as fs from 'fs';
import * as path from 'path';
import { NbaGameState } from '../services/GameMonitor';
import { BasketballMarket } from '../services/MarketService';
import { TradeSignal } from '../strategy/TradingStrategy';
import { TradeRecord } from './TradeHistory';
import { GameMonitor } from '../services/GameMonitor';

function extractTeam(ticker: string): string {
  return ticker.match(/-([A-Z]{3})$/)?.[1] ?? ticker;
}

function r4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export interface MarketSnapshot {
  team: string;
  winProbability: number | null; // model probability (null pre-game — no score/time data)
  ask: number;
  bid: number;
  // Present only for Q4 markets evaluated for entry
  signal?: 'buy' | 'sell' | 'hold';
  signalReason?: string;
  contracts?: number;
  limitPrice?: number;
}

export interface GameAnalysis {
  matchup: string;
  period: number;
  clock: string;          // formatted "mm:ss"
  score: string;
  isQ4: boolean;
  markets: MarketSnapshot[];
}

export interface TickAnalysis {
  timestamp: string;
  balanceDollars: number;
  games: GameAnalysis[];
  decisions: DecisionLog[];
  openPositions: PositionAnalysis[];
  summary: { totalTrades: number; totalPnl: number; winRate: number };
}

export interface DecisionLog {
  type: 'entry' | 'exit' | 'hold';
  ticker: string;
  reason: string;
  contracts?: number;
  price?: number;
  pnl?: number;
  orderId?: string;
}

export interface PositionAnalysis {
  ticker: string;
  team: string;
  contracts: number;
  entryPrice: number;
  entryProb: number;
  entryTime: string;
  currentProb?: number;
  kalshiAskProb?: number;
  unrealizedPnl?: number;
}

function pstDateString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function dailyLogPath(prefix: string): string {
  return path.resolve(process.cwd(), `${prefix}_${pstDateString()}.log`);
}

export class AnalysisLogger {
  private pendingTick: Partial<TickAnalysis> = {};

  startTick(balanceCents: number): void {
    this.pendingTick = {
      timestamp: new Date().toISOString(),
      balanceDollars: balanceCents / 100,
      games: [],
      decisions: [],
      openPositions: [],
    };
  }

  /**
   * Join NBA game states with Kalshi market data into unified game entries.
   */
  logGames(games: NbaGameState[], markets: BasketballMarket[]): void {
    const marketsByGameKey = new Map<string, BasketballMarket[]>();

    for (const m of markets) {
      if (m.gameState) {
        const key = `${m.gameState.awayTeamTricode}@${m.gameState.homeTeamTricode}`;
        const arr = marketsByGameKey.get(key) ?? [];
        arr.push(m);
        marketsByGameKey.set(key, arr);
      }
    }

    this.pendingTick.games = games
      .filter((g) => g.gameStatus !== 1 && g.gameStatus !== 3)
      .map((g) => {
        const key = `${g.awayTeamTricode}@${g.homeTeamTricode}`;
        const gameMarkets = marketsByGameKey.get(key) ?? [];
        return {
          matchup: key,
          period: g.period,
          clock: GameMonitor.formatClock(g.gameClock),
          score: `${g.awayScore}-${g.homeScore}`,
          isQ4: g.isQ4OrLater,
          markets: gameMarkets.map((m) => ({
            team: extractTeam(m.ticker),
            winProbability: g.period > 0 ? r4(m.winProbability) : null,
            ask: m.yesAsk,
            bid: m.yesBid,
          })),
        };
      });
  }

  /**
   * Attach signal data to the existing market snapshot inside games[].
   * Avoids duplicating winProbability/ask/bid already logged in the game entry.
   */
  logMarketEval(market: BasketballMarket, signal: TradeSignal): void {
    const team = extractTeam(market.ticker);
    for (const game of this.pendingTick.games ?? []) {
      const snapshot = game.markets.find((m) => m.team === team);
      if (snapshot) {
        snapshot.signal = signal.action === 'buy' ? 'buy'
          : signal.action === 'sell' ? 'sell'
          : 'hold';
        snapshot.signalReason = signal.reason;
        if (signal.suggestedContracts !== undefined) snapshot.contracts = signal.suggestedContracts;
        if (signal.suggestedLimitPrice !== undefined) snapshot.limitPrice = signal.suggestedLimitPrice;
        return;
      }
    }
  }

  logDecision(decision: DecisionLog): void {
    this.pendingTick.decisions = this.pendingTick.decisions ?? [];
    this.pendingTick.decisions.push(decision);
  }

  logOpenPositions(trades: TradeRecord[], markets: Map<string, BasketballMarket>): void {
    this.pendingTick.openPositions = trades.map((t) => {
      const market = markets.get(t.ticker);
      const currentProb = market?.winProbability !== undefined ? r4(market.winProbability) : undefined;
      const kalshiAskProb = market?.yesAsk;
      const unrealizedPnl = currentProb !== undefined
        ? Math.round((currentProb - t.pricePerContract) * t.contracts * 100) / 100
        : undefined;
      return {
        ticker: t.ticker,
        team: extractTeam(t.ticker),
        contracts: t.contracts,
        entryPrice: t.pricePerContract,
        entryProb: r4(t.winProbabilityAtEntry),
        entryTime: t.entryTime,
        currentProb,
        kalshiAskProb,
        unrealizedPnl,
      };
    });
  }

  finalizeTick(summary: { totalTrades: number; totalPnl: number; winRate: number }): void {
    const tick: TickAnalysis = {
      timestamp: this.pendingTick.timestamp ?? new Date().toISOString(),
      balanceDollars: this.pendingTick.balanceDollars ?? 0,
      games: this.pendingTick.games ?? [],
      decisions: this.pendingTick.decisions ?? [],
      openPositions: this.pendingTick.openPositions ?? [],
      summary: {
        totalTrades: summary.totalTrades,
        totalPnl: Math.round(summary.totalPnl * 100) / 100,
        winRate: r4(summary.winRate),
      },
    };
    fs.appendFileSync(dailyLogPath('analysis'), JSON.stringify(tick) + '\n', 'utf-8');
    this.pendingTick = {};
  }
}
