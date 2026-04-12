/**
 * One-off script: pull actual KXBTC15M fill and position data from Kalshi
 * and reconcile against local btc_trade_history.json.
 *
 * Usage: npx ts-node src/scripts/audit_trades.ts
 */

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { KalshiClient } from '../api/KalshiClient';
import { KalshiFill } from '../api/types';

dotenv.config();

const KEY_ID         = process.env.KALSHI_API_KEY!;
const PRIVATE_KEY    = path.resolve('private_key.pem');
const HISTORY_PATH   = path.resolve('btc_trade_history.json');

interface LocalTrade {
  id: string;
  ticker: string;
  side: string;
  action: string;
  contracts: number;
  pricePerContract: number;
  totalCost: number;
  winProbabilityAtEntry: number;
  entryTime: string;
  exitTime?: string;
  exitReason?: string;
  pnl?: number;
}

function parseFP(fp: string | undefined): number {
  return fp ? parseFloat(fp) : 0;
}

async function main(): Promise<void> {
  const client = new KalshiClient(KEY_ID, PRIVATE_KEY);

  // ── 1. Fetch all fills (paginated) ────────────────────────────────────────
  console.log('\n=== Fetching fills from Kalshi ===\n');
  const allFills: KalshiFill[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.getFilledOrders({ limit: 200, cursor });
    allFills.push(...res.fills);
    cursor = res.cursor || undefined;
  } while (cursor);

  const btcFills = allFills.filter((f) => f.ticker.startsWith('KXBTC15M'));
  console.log(`Total fills: ${allFills.length}  BTC fills: ${btcFills.length}\n`);

  // ── 2. Group fills by ticker ───────────────────────────────────────────────
  const byTicker = new Map<string, KalshiFill[]>();
  for (const f of btcFills) {
    const arr = byTicker.get(f.ticker) ?? [];
    arr.push(f);
    byTicker.set(f.ticker, arr);
  }

  // ── 3. Compute per-market P&L from fills ──────────────────────────────────
  // YES buy:  cost = +yesPrice × count
  // YES sell: revenue = +yesPrice × count
  // NO buy:   cost = +noPrice × count
  // NO sell:  revenue = +noPrice × count
  // pnl = revenue - cost  (settlement payout handled separately)

  console.log('=== Per-Market Fill Summary ===\n');
  console.log(
    'Ticker'.padEnd(40),
    'Side'.padEnd(6),
    'Act'.padEnd(5),
    'Qty'.padEnd(6),
    'Price'.padEnd(8),
    'Time',
  );
  console.log('-'.repeat(100));

  for (const [ticker, fills] of [...byTicker.entries()].sort()) {
    for (const f of fills.sort((a, b) => a.created_time.localeCompare(b.created_time))) {
      const price = f.side === 'yes' ? parseFP(f.yes_price_dollars) : parseFP(f.no_price_dollars);
      const qty   = parseFP(f.count_fp);
      console.log(
        ticker.padEnd(40),
        f.side.padEnd(6),
        f.action.padEnd(5),
        String(qty).padEnd(6),
        `$${price.toFixed(3)}`.padEnd(8),
        new Date(f.created_time).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }),
      );
    }
  }

  // ── 4. Fetch settled positions (realized P&L from Kalshi) ─────────────────
  console.log('\n=== Positions from Kalshi (realized PnL per market) ===\n');
  const allPositions = [];
  let posCursor: string | undefined;
  do {
    const res = await client.getPositions({ limit: 200, cursor: posCursor });
    allPositions.push(...res.market_positions);
    posCursor = res.cursor || undefined;
  } while (posCursor);

  const btcPositions = allPositions.filter((p) => p.ticker.startsWith('KXBTC15M'));
  console.log(`Total positions: ${allPositions.length}  BTC positions: ${btcPositions.length}\n`);

  console.log(
    'Ticker'.padEnd(40),
    'Net pos'.padEnd(9),
    'RealizedPnL'.padEnd(14),
    'TotalTraded'.padEnd(14),
    'Fees',
  );
  console.log('-'.repeat(100));

  let totalRealizedPnl = 0;
  let totalFees = 0;
  for (const p of btcPositions.sort((a, b) => a.ticker.localeCompare(b.ticker))) {
    const pnl  = parseFP(p.realized_pnl_dollars);
    const fees = parseFP(p.fees_paid_dollars);
    const traded = parseFP(p.total_traded_dollars);
    const pos  = parseFP(p.position_fp);
    totalRealizedPnl += pnl;
    totalFees += fees;
    console.log(
      p.ticker.padEnd(40),
      String(pos).padEnd(9),
      `$${pnl.toFixed(4)}`.padEnd(14),
      `$${traded.toFixed(4)}`.padEnd(14),
      `$${fees.toFixed(4)}`,
    );
  }

  console.log('\n' + '-'.repeat(100));
  console.log(`TOTAL realized PnL: $${totalRealizedPnl.toFixed(4)}   Total fees: $${totalFees.toFixed(4)}`);

  // ── 5. Compare with local trade history ───────────────────────────────────
  console.log('\n=== Local btc_trade_history.json ===\n');
  if (!fs.existsSync(HISTORY_PATH)) {
    console.log('  (file not found)');
    return;
  }
  const history: { trades: LocalTrade[]; realizedPnl: number; totalTrades: number; winningTrades: number } =
    JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));

  console.log(
    'Ticker'.padEnd(40),
    'Side'.padEnd(5),
    'Qty'.padEnd(5),
    'Entry$'.padEnd(8),
    'ExitReason'.padEnd(12),
    'Local PnL',
  );
  console.log('-'.repeat(100));
  for (const t of history.trades) {
    console.log(
      t.ticker.padEnd(40),
      t.side.padEnd(5),
      String(t.contracts).padEnd(5),
      `$${t.pricePerContract.toFixed(3)}`.padEnd(8),
      (t.exitReason ?? 'open').padEnd(12),
      `$${(t.pnl ?? 0).toFixed(4)}`,
    );
  }
  console.log(
    `\nLocal totals — trades: ${history.totalTrades}  wins: ${history.winningTrades}  realizedPnl: $${history.realizedPnl.toFixed(4)}`,
  );

  // ── 6. Fetch market results and compute actual PnL from fills ────────────
  console.log('\n=== Actual PnL from fills + settlement ===\n');

  // Collect unique tickers from BTC fills
  const tickers = [...byTicker.keys()];

  // Build per-market net cost and contract count from fills
  interface MarketSummary {
    buyCost: number;
    buyContracts: number;
    sellRevenue: number;
    sellContracts: number;
    side: 'yes' | 'no';
    result?: string;
    actualPnl?: number;
  }
  const marketSummary = new Map<string, MarketSummary>();

  for (const [ticker, fills] of byTicker.entries()) {
    let buyCost = 0, buyContracts = 0, sellRevenue = 0, sellContracts = 0;
    let side: 'yes' | 'no' = 'yes';
    for (const f of fills) {
      side = f.side;
      const price = f.side === 'yes' ? parseFP(f.yes_price_dollars) : parseFP(f.no_price_dollars);
      const qty = parseFP(f.count_fp);
      if (f.action === 'buy') { buyCost += price * qty; buyContracts += qty; }
      else                    { sellRevenue += price * qty; sellContracts += qty; }
    }
    marketSummary.set(ticker, { buyCost, buyContracts, sellRevenue, sellContracts, side });
  }

  // Fetch market results
  for (const ticker of tickers) {
    try {
      const { market } = await client.getMarket(ticker);
      const summary = marketSummary.get(ticker)!;
      summary.result = market.result ?? 'open';

      const netContracts = summary.buyContracts - summary.sellContracts;
      const settlementPayout =
        market.result === summary.side ? netContracts * 1.0 : 0;

      summary.actualPnl = settlementPayout + summary.sellRevenue - summary.buyCost;
    } catch {
      // market may be gone
    }
  }

  console.log(
    'Ticker'.padEnd(40),
    'Side'.padEnd(5),
    'Bought'.padEnd(8),
    'BuyCost'.padEnd(10),
    'Result'.padEnd(8),
    'ActualPnL'.padEnd(12),
    'LocalPnL',
  );
  console.log('-'.repeat(110));

  let totalActual = 0;
  let totalLocal  = 0;
  for (const ticker of tickers.sort()) {
    const s = marketSummary.get(ticker)!;
    const local = history.trades.filter((t) => t.ticker === ticker);
    const localPnl = local.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
    totalActual += s.actualPnl ?? 0;
    totalLocal  += localPnl;
    console.log(
      ticker.padEnd(40),
      s.side.padEnd(5),
      `${s.buyContracts}@${s.buyCost.toFixed(2)}`.padEnd(8),
      ''.padEnd(2),
      (s.result ?? '?').padEnd(8),
      `$${(s.actualPnl ?? 0).toFixed(4)}`.padEnd(12),
      `$${localPnl.toFixed(4)}`,
    );
  }

  console.log('-'.repeat(110));
  console.log(
    'TOTAL'.padEnd(40),
    ''.padEnd(5),
    ''.padEnd(10),
    ''.padEnd(2),
    ''.padEnd(8),
    `$${totalActual.toFixed(4)}`.padEnd(12),
    `$${totalLocal.toFixed(4)}`,
  );
  console.log(`\nDelta (actual − local): $${(totalActual - totalLocal).toFixed(4)}`);

  // ── 7. Delta from Kalshi positions ────────────────────────────────────────
  const delta = totalRealizedPnl - history.realizedPnl;
  console.log(`Kalshi positions realized PnL vs local: $${delta.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
