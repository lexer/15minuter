import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TradeHistory, TradeRecord } from '../../src/storage/TradeHistory';

let tempFile: string;

function makeRecord(id: string): TradeRecord {
  return {
    id,
    ticker: 'KXBTC15M-26APR11-T83499',
    marketTitle: 'BTC 15m market',
    side: 'yes',
    action: 'buy',
    contracts: 5,
    pricePerContract: 0.92,
    totalCost: 4.6,
    winProbabilityAtEntry: 0.93,
    entryTime: new Date().toISOString(),
  };
}

describe('TradeHistory', () => {
  beforeEach(() => {
    tempFile = path.join(os.tmpdir(), `trade_history_test_${Date.now()}.json`);
  });

  afterEach(() => {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  });

  it('starts with empty history', () => {
    const h = new TradeHistory(tempFile);
    expect(h.getAllTrades()).toHaveLength(0);
    expect(h.getOpenTrades()).toHaveLength(0);
  });

  it('records a trade and persists to disk', () => {
    const h = new TradeHistory(tempFile);
    h.recordTrade(makeRecord('trade-1'));
    expect(h.getAllTrades()).toHaveLength(1);
    expect(fs.existsSync(tempFile)).toBe(true);
  });

  it('loads persisted trades on construction', () => {
    const h1 = new TradeHistory(tempFile);
    h1.recordTrade(makeRecord('trade-1'));
    const h2 = new TradeHistory(tempFile);
    expect(h2.getAllTrades()).toHaveLength(1);
  });

  it('updates a trade with exit data', () => {
    const h = new TradeHistory(tempFile);
    h.recordTrade(makeRecord('trade-1'));
    h.updateTrade('trade-1', { pnl: 0.5, exitTime: new Date().toISOString() });
    const trade = h.getAllTrades()[0];
    expect(trade.pnl).toBe(0.5);
    expect(trade.exitTime).toBeDefined();
  });

  it('getOpenTrades returns only trades without exitTime', () => {
    const h = new TradeHistory(tempFile);
    h.recordTrade(makeRecord('trade-1'));
    h.recordTrade(makeRecord('trade-2'));
    h.updateTrade('trade-1', { exitTime: new Date().toISOString() });
    expect(h.getOpenTrades()).toHaveLength(1);
    expect(h.getOpenTrades()[0].id).toBe('trade-2');
  });

  it('computes summary correctly', () => {
    const h = new TradeHistory(tempFile);
    h.recordTrade(makeRecord('trade-1'));
    h.recordTrade(makeRecord('trade-2'));
    h.updateTrade('trade-1', { pnl: 1.0 });
    h.updateTrade('trade-2', { pnl: -0.5 });
    const summary = h.getSummary();
    expect(summary.totalTrades).toBe(2);
    expect(summary.realizedPnl).toBeCloseTo(0.5);
    expect(summary.winRate).toBe(0.5);
  });
});
