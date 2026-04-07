import * as fs from 'fs';
import * as path from 'path';
import { NbaGameState } from '../services/GameMonitor';
import { BasketballMarket } from '../services/MarketService';
import { TradeSignal } from '../strategy/TradingStrategy';
import { TradeRecord } from './TradeHistory';

function extractTeam(ticker: string): string {
  return ticker.match(/-([A-Z]{3})$/)?.[1] ?? ticker;
}

export interface TickAnalysis {
  timestamp: string;
  balanceDollars: number;
  games: GameAnalysis[];
  q4Markets: MarketAnalysis[];
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

function dailyLogPath(prefix: string): string {
  const d = new Date();
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return path.resolve(process.cwd(), `${prefix}_${date}.log`);
}

export class AnalysisLogger {
  private pendingTick: Partial<TickAnalysis> = {};

  startTick(balanceCents: number): void {
    this.pendingTick = {
      timestamp: new Date().toISOString(),
      balanceDollars: balanceCents / 100,
      games: [],
      q4Markets: [],
      decisions: [],
      openPositions: [],
    };
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
      q4Markets: this.pendingTick.q4Markets ?? [],
      decisions: this.pendingTick.decisions ?? [],
      openPositions: this.pendingTick.openPositions ?? [],
      summary,
    };
    fs.appendFileSync(dailyLogPath('analysis'), JSON.stringify(tick) + '\n', 'utf-8');
    this.pendingTick = {};
  }
}
