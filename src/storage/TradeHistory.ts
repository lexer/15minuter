import * as fs from 'fs';
import * as path from 'path';

export interface TradeRecord {
  id: string;
  ticker: string;
  marketTitle: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  contracts: number;
  pricePerContract: number;
  totalCost: number;
  winProbabilityAtEntry: number;
  winProbabilityAtExit?: number;
  entryTime: string;
  exitTime?: string;
  exitReason?: 'probability_drop' | 'game_over' | 'manual';
  pnl?: number;
  gameCompleted?: boolean;
  gameResult?: 'win' | 'loss' | 'pending';
}

export interface TradeHistoryData {
  trades: TradeRecord[];
  completedGames: CompletedGame[];
  realizedPnl: number;
  totalTrades: number;
  winningTrades: number;
}

export interface CompletedGame {
  eventTicker: string;
  ticker: string;
  title: string;
  result: 'win' | 'loss';
  entryProbability: number;
  exitProbability?: number;
  pnl: number;
  completedAt: string;
}

const DEFAULT_HISTORY_FILE = path.resolve(process.cwd(), 'trade_history.json');

export class TradeHistory {
  private data: TradeHistoryData;
  private readonly filePath: string;

  constructor(filePath: string = DEFAULT_HISTORY_FILE) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): TradeHistoryData {
    if (fs.existsSync(this.filePath)) {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as TradeHistoryData & { totalPnl?: number };
      // Migrate legacy totalPnl field to realizedPnl
      if (parsed.realizedPnl === undefined) {
        parsed.realizedPnl = parsed.totalPnl ?? 0;
      }
      return parsed;
    }
    return {
      trades: [],
      completedGames: [],
      realizedPnl: 0,
      totalTrades: 0,
      winningTrades: 0,
    };
  }

  private save(): void {
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  recordTrade(trade: TradeRecord): void {
    this.data.trades.push(trade);
    this.data.totalTrades++;
    this.save();
  }

  updateTrade(id: string, updates: Partial<TradeRecord>): void {
    const idx = this.data.trades.findIndex((t) => t.id === id);
    if (idx >= 0) {
      this.data.trades[idx] = { ...this.data.trades[idx], ...updates };
      if (updates.pnl !== undefined) {
        this.data.realizedPnl += updates.pnl;
        if (updates.pnl > 0) this.data.winningTrades++;
      }
      this.save();
    }
  }

  recordCompletedGame(game: CompletedGame): void {
    this.data.completedGames.push(game);
    this.save();
  }

  getOpenTrades(): TradeRecord[] {
    return this.data.trades.filter((t) => !t.exitTime);
  }

  getAllTrades(): TradeRecord[] {
    return [...this.data.trades];
  }

  getSummary(): { realizedPnl: number; totalTrades: number; winRate: number } {
    const closedTrades = this.data.trades.filter((t) => t.pnl !== undefined);
    const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
    return {
      realizedPnl: this.data.realizedPnl,
      totalTrades: this.data.totalTrades,
      winRate: closedTrades.length > 0 ? wins / closedTrades.length : 0,
    };
  }
}
