import * as fs from 'fs';
import * as path from 'path';
import { NbaGameState } from '../services/GameMonitor';
import { BasketballMarket } from '../services/MarketService';
import { TradeSignal } from '../strategy/TradingStrategy';
import { TradeRecord } from './TradeHistory';

function extractTeam(ticker: string): string {
  return ticker.match(/-([A-Z]{3})$/)?.[1] ?? ticker;
}

export interface MarketSnapshot {
  team: string;
  winProbability: number | null; // model probability (null pre-game — no score/time data)
  kalshiAsk: number;             // Kalshi ask = market-implied win probability
  kalshiBid: number;
}

export interface GameAnalysis {
  matchup: string;
  period: number;
  clock: string;
  score: string;
  isQ4: boolean;
  status: 'live' | 'upcoming' | 'final';
  markets: MarketSnapshot[];     // Kalshi markets for this game's teams
}

export interface TickAnalysis {
  timestamp: string;
  balanceDollars: number;
  games: GameAnalysis[];         // live/upcoming games with embedded market data
  q4Markets: MarketAnalysis[];   // Q4 markets with trading signals
  decisions: DecisionLog[];
  openPositions: PositionAnalysis[];
  summary: { totalTrades: number; totalPnl: number; winRate: number };
}

export interface MarketAnalysis {
  ticker: string;
  team: string;            // e.g. "HOU" — both winProbability and kalshiAskProb refer to this team winning
  title: string;
  winProbability: number;  // model probability (Gaussian random walk on score/time)
  kalshiAskProb: number;   // Kalshi ask price = market-implied win probability for this team
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
      q4Markets: [],
      decisions: [],
      openPositions: [],
    };
  }

  /**
   * Join NBA game states with Kalshi market data into unified game entries.
   * Pre-game Kalshi markets with no live NBA match are included as upcoming entries.
   */
  logGames(games: NbaGameState[], markets: BasketballMarket[]): void {
    // Group markets by their live game (matched by team codes via gameState)
    const marketsByGameKey = new Map<string, BasketballMarket[]>();
    const pregameMarkets: BasketballMarket[] = [];

    for (const m of markets) {
      if (m.gameState) {
        const key = `${m.gameState.awayTeamTricode}@${m.gameState.homeTeamTricode}`;
        const arr = marketsByGameKey.get(key) ?? [];
        arr.push(m);
        marketsByGameKey.set(key, arr);
      } else {
        pregameMarkets.push(m);
      }
    }

    // Build entries for live/final games
    const entries: GameAnalysis[] = games.map((g) => {
      const key = `${g.awayTeamTricode}@${g.homeTeamTricode}`;
      const gameMarkets = marketsByGameKey.get(key) ?? [];
      return {
        matchup: key,
        period: g.period,
        clock: g.gameClock,
        score: `${g.awayScore}-${g.homeScore}`,
        isQ4: g.isQ4OrLater,
        status: g.gameStatus === 1 ? 'upcoming' : g.gameStatus === 3 ? 'final' : 'live',
        markets: gameMarkets.map((m) => ({
          team: extractTeam(m.ticker),
          winProbability: g.period > 0 ? m.winProbability : null,
          kalshiAsk: m.yesAsk,
          kalshiBid: m.yesBid,
        })),
      };
    });

    // Append pre-game Kalshi markets not matched to a live game, grouped by event
    const byEvent = new Map<string, BasketballMarket[]>();
    for (const m of pregameMarkets) {
      const arr = byEvent.get(m.eventTicker) ?? [];
      arr.push(m);
      byEvent.set(m.eventTicker, arr);
    }
    for (const [eventTicker, eventMarkets] of byEvent) {
      const codes = eventTicker.match(/\d{2}[A-Z]{3}\d{2}([A-Z]{3})([A-Z]{3})$/);
      const away = codes?.[1] ?? '';
      const home = codes?.[2] ?? '';
      entries.push({
        matchup: `${away}@${home}`,
        period: 0,
        clock: '',
        score: '',
        isQ4: false,
        status: 'upcoming',
        markets: eventMarkets.map((m) => ({
          team: extractTeam(m.ticker),
          winProbability: null,
          kalshiAsk: m.yesAsk,
          kalshiBid: m.yesBid,
        })),
      });
    }

    this.pendingTick.games = entries;
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
