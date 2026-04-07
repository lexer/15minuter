import * as fs from 'fs';
import * as path from 'path';
import { NbaGameState } from '../services/GameMonitor';
import { BasketballMarket } from '../services/MarketService';
import { TradeSignal } from '../strategy/TradingStrategy';
import { TradeRecord } from './TradeHistory';

function extractTeam(ticker: string): string {
  return ticker.match(/-([A-Z]{3})$/)?.[1] ?? ticker;
}

export interface LiveMarketSnapshot {
  ticker: string;
  team: string;
  period: number;
  winProbability: number | null; // model probability (null when game not live — no score/time data)
  kalshiAskProb: number;         // Kalshi ask = market-implied win probability
  bid: number;
  isQ4: boolean;
}

export interface TickAnalysis {
  timestamp: string;
  balanceDollars: number;
  games: GameAnalysis[];
  allMarkets: LiveMarketSnapshot[]; // all live Kalshi markets regardless of quarter
  q4Markets: MarketAnalysis[];      // Q4 markets with trading signals
  decisions: DecisionLog[];
  openPositions: PositionAnalysis[];
  summary: { totalTrades: number; totalPnl: number; winRate: number };
}

export interface GameAnalysis {
  matchup: string;
  period: number;
  clock: string;
  score: string;
  isQ4: boolean;
  status: 'live' | 'upcoming' | 'final';
}

export interface MarketAnalysis {
  ticker: string;
  team: string;           // e.g. "HOU" — both winProbability and kalshiAskProb refer to this team winning
  title: string;
  winProbability: number; // model probability (Gaussian random walk on score/time)
  kalshiAskProb: number;  // Kalshi ask price = market-implied win probability for this team
  bid: number;
  signal: 'buy' | 'sell' | 'hold' | 'skip';
  signalReason: string;
  contracts?: number;
  limitPrice?: number;
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
  team: string;              // e.g. "HOU"
  contracts: number;
  entryPrice: number;
  entryProb: number;
  entryTime: string;
  currentProb?: number;      // model probability
  kalshiAskProb?: number;    // Kalshi ask = market-implied win probability for this team
  unrealizedPnl?: number;
}

function pstDateString(): string {
  // Games are in the US — use America/Los_Angeles so one log file = one NBA game day
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
      allMarkets: [],
      q4Markets: [],
      decisions: [],
      openPositions: [],
    };
  }

  logAllMarkets(markets: BasketballMarket[]): void {
    this.pendingTick.allMarkets = markets.map((m) => ({
      ticker: m.ticker,
      team: extractTeam(m.ticker),
      period: m.gameState?.period ?? 0,
      // Only log model probability when game is live — pre-game has no score/clock
      winProbability: m.gameState && m.gameState.period > 0 ? m.winProbability : null,
      kalshiAskProb: m.yesAsk,
      bid: m.yesBid,
      isQ4: m.isQ4,
    }));
  }

  logGames(games: NbaGameState[]): void {
    this.pendingTick.games = games.map((g) => ({
      matchup: `${g.awayTeamTricode}@${g.homeTeamTricode}`,
      period: g.period,
      clock: g.gameClock,
      score: `${g.awayScore}-${g.homeScore}`,
      isQ4: g.isQ4OrLater,
      status: g.gameStatus === 1 ? 'upcoming' : g.gameStatus === 3 ? 'final' : 'live',
    }));
  }

  logMarketEval(market: BasketballMarket, signal: TradeSignal): void {
    this.pendingTick.q4Markets = this.pendingTick.q4Markets ?? [];
    this.pendingTick.q4Markets.push({
      ticker: market.ticker,
      team: extractTeam(market.ticker),
      title: market.title,
      winProbability: market.winProbability,
      kalshiAskProb: market.yesAsk,
      bid: market.yesBid,
      signal: signal.action === 'buy' ? 'buy' : signal.action === 'sell' ? 'sell' : 'hold',
      signalReason: signal.reason,
      contracts: signal.suggestedContracts,
      limitPrice: signal.suggestedLimitPrice,
    });
  }

  logDecision(decision: DecisionLog): void {
    this.pendingTick.decisions = this.pendingTick.decisions ?? [];
    this.pendingTick.decisions.push(decision);
  }

  logOpenPositions(trades: TradeRecord[], markets: Map<string, BasketballMarket>): void {
    this.pendingTick.openPositions = trades.map((t) => {
      const market = markets.get(t.ticker);
      const currentProb = market?.winProbability;
      const kalshiAskProb = market?.yesAsk;
      const unrealizedPnl = currentProb !== undefined
        ? (currentProb - t.pricePerContract) * t.contracts
        : undefined;
      return {
        ticker: t.ticker,
        team: extractTeam(t.ticker),
        contracts: t.contracts,
        entryPrice: t.pricePerContract,
        entryProb: t.winProbabilityAtEntry,
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
      allMarkets: this.pendingTick.allMarkets ?? [],
      q4Markets: this.pendingTick.q4Markets ?? [],
      decisions: this.pendingTick.decisions ?? [],
      openPositions: this.pendingTick.openPositions ?? [],
      summary,
    };
    fs.appendFileSync(dailyLogPath('analysis'), JSON.stringify(tick) + '\n', 'utf-8');
    this.pendingTick = {};
  }
}
