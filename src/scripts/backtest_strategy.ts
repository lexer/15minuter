/**
 * Strategy backtest — replays analysis log tick-by-tick against the current
 * entry/exit rules and reports simulated PnL.
 *
 * Usage:
 *   npx ts-node src/scripts/backtest_strategy.ts [analysis_log_path]
 *   npx ts-node src/scripts/backtest_strategy.ts analysis_2026-04-07.log
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Strategy parameters (mirrors TradingStrategy.ts) ────────────────────────
const ENTRY_CONFIRMATION_THRESHOLD = 0.90;
const ENTRY_CONFIRMATION_TICKS = 3;
const ENTRY_MAX_SECONDS = 600;          // 10-min window (current)
const EXIT_BID_THRESHOLD = 0.70;
const EXIT_PROB_GUARD = 0.85;
const EXIT_CONFIRMATION_TICKS = 3;
const STARTING_BALANCE = 929.31;       // from today's balance in log
const POSITION_FRACTION = 0.25;
// ─────────────────────────────────────────────────────────────────────────────

interface MarketSnapshot {
  team: string;
  winProbability: number | null;
  ask: number;
  bid: number;
  signal?: string;
  signalReason?: string;
}

interface GameAnalysis {
  matchup: string;
  period: number;
  clock: string;   // "mm:ss"
  score: string;   // "away-home"
  markets: MarketSnapshot[];
}

interface Tick {
  timestamp: string;
  balanceDollars: number;
  games: GameAnalysis[];
}

interface SimPosition {
  ticker: string;
  matchup: string;
  team: string;
  contracts: number;
  entryPrice: number;
  entryTime: string;
  entryProb: number;
}

function clockToSeconds(clock: string): number {
  const [m, s] = clock.split(':').map(Number);
  return m * 60 + s;
}

function q4SecondsRemaining(clock: string): number {
  return clockToSeconds(clock);  // period=4: remaining = clock seconds
}

function ticker(matchup: string, team: string): string {
  return `${matchup}-${team}`;
}

function determineWinners(ticks: Tick[]): Map<string, string> {
  // Find the final score for each matchup and return winning team
  const lastScore = new Map<string, { score: string; teams: string[] }>();
  for (const tick of ticks) {
    for (const game of tick.games) {
      if (game.period === 4) {
        const teams = game.markets.map((m) => m.team);
        lastScore.set(game.matchup, { score: game.score, teams });
      }
    }
  }
  const winners = new Map<string, string>();
  for (const [matchup, { score, teams }] of lastScore) {
    const [awayScore, homeScore] = score.split('-').map(Number);
    if (isNaN(awayScore) || isNaN(homeScore) || awayScore === homeScore) continue;
    const [awayTeam, homeTeam] = matchup.split('@');
    // Score format in log is "awayScore-homeScore"
    const winner = awayScore > homeScore ? awayTeam : homeTeam;
    winners.set(matchup, winner);
  }
  return winners;
}

function run(ticks: Tick[]): void {
  const winners = determineWinners(ticks);

  let balanceCents = Math.round(STARTING_BALANCE * 100);
  const openPositions = new Map<string, SimPosition>();
  const closedTrades: { ticker: string; pnl: number; reason: string; entryPrice: number; exitPrice: number; contracts: number }[] = [];

  // Per-ticker state
  const entryConfirmCounts = new Map<string, number>();
  const exitConfirmCounts = new Map<string, number>();
  const entryCooldowns = new Map<string, number>();  // ticker -> cooldown end index

  console.log(`\nBacktest — ${ticks.length} ticks, ${winners.size} completed Q4 games\n`);
  console.log('Game results:');
  for (const [matchup, winner] of winners) {
    const finalTick = [...ticks].reverse().find((t) => t.games.find((g) => g.matchup === matchup && g.period === 4));
    const game = finalTick?.games.find((g) => g.matchup === matchup);
    console.log(`  ${matchup}: ${winner} wins | Final Q4 score: ${game?.score ?? '?'}`);
  }

  let tickIdx = 0;
  for (const tick of ticks) {
    tickIdx++;

    // Settle positions where the game has ended (matchup no longer in tick)
    const activeMatchups = new Set(tick.games.map((g) => g.matchup));
    for (const [t, pos] of openPositions) {
      if (!activeMatchups.has(pos.matchup)) {
        // Game ended — settle at 1 if won, 0 if lost
        const winner = winners.get(pos.matchup);
        const won = winner === pos.team;
        const exitPrice = won ? 1.0 : 0.0;
        const pnl = (exitPrice - pos.entryPrice) * pos.contracts;
        balanceCents += Math.round(exitPrice * pos.contracts * 100);
        closedTrades.push({ ticker: t, pnl, reason: 'settlement', entryPrice: pos.entryPrice, exitPrice, contracts: pos.contracts });
        console.log(`  SETTLED ${t} → ${won ? 'WIN' : 'LOSS'} | entry=$${pos.entryPrice.toFixed(2)} exit=$${exitPrice.toFixed(2)} contracts=${pos.contracts} PnL=$${pnl.toFixed(2)}`);
        openPositions.delete(t);
        entryConfirmCounts.delete(t);
        exitConfirmCounts.delete(t);
      }
    }

    for (const game of tick.games) {
      if (game.period !== 4) continue;
      const secsLeft = q4SecondsRemaining(game.clock);

      for (const mkt of game.markets) {
        if (mkt.winProbability === null) continue;
        const tk = ticker(game.matchup, mkt.team);

        // ── EXIT logic ───────────────────────────────────────────────────────
        const pos = openPositions.get(tk);
        if (pos) {
          if (mkt.bid <= EXIT_BID_THRESHOLD) {
            if (mkt.winProbability >= EXIT_PROB_GUARD) {
              exitConfirmCounts.delete(tk);
            } else {
              const cnt = (exitConfirmCounts.get(tk) ?? 0) + 1;
              exitConfirmCounts.set(tk, cnt);
              if (cnt >= EXIT_CONFIRMATION_TICKS) {
                const pnl = (mkt.bid - pos.entryPrice) * pos.contracts;
                balanceCents += Math.round(mkt.bid * pos.contracts * 100);
                closedTrades.push({ ticker: tk, pnl, reason: 'bid_drop', entryPrice: pos.entryPrice, exitPrice: mkt.bid, contracts: pos.contracts });
                console.log(`  EXIT ${tk} bid=${(mkt.bid * 100).toFixed(0)}¢ | contracts=${pos.contracts} PnL=$${pnl.toFixed(2)}`);
                openPositions.delete(tk);
                exitConfirmCounts.delete(tk);
              }
            }
          } else {
            exitConfirmCounts.delete(tk);
          }
          continue;
        }

        // ── ENTRY logic ──────────────────────────────────────────────────────
        if (openPositions.has(tk)) continue;

        // Cooldown check
        const cooldown = entryCooldowns.get(tk);
        if (cooldown !== undefined && tickIdx < cooldown) continue;

        // Time window
        if (secsLeft > ENTRY_MAX_SECONDS) {
          entryConfirmCounts.delete(tk);
          continue;
        }

        // Ask threshold
        if (mkt.ask <= ENTRY_CONFIRMATION_THRESHOLD || mkt.ask >= 1.0) {
          entryConfirmCounts.delete(tk);
          continue;
        }

        const cnt = (entryConfirmCounts.get(tk) ?? 0) + 1;
        entryConfirmCounts.set(tk, cnt);

        if (cnt >= ENTRY_CONFIRMATION_TICKS) {
          // Size position
          const maxSpendCents = Math.min(
            Math.floor(balanceCents * POSITION_FRACTION),
            balanceCents,
          );
          const costPerContract = Math.round(mkt.ask * 100);
          const contracts = Math.floor(maxSpendCents / costPerContract);
          if (contracts <= 0) continue;

          const totalCost = contracts * mkt.ask;
          balanceCents -= Math.round(totalCost * 100);
          openPositions.set(tk, {
            ticker: tk,
            matchup: game.matchup,
            team: mkt.team,
            contracts,
            entryPrice: mkt.ask,
            entryTime: tick.timestamp,
            entryProb: mkt.winProbability,
          });
          entryConfirmCounts.delete(tk);
          console.log(`  ENTRY ${tk} ask=${(mkt.ask * 100).toFixed(0)}¢ prob=${(mkt.winProbability * 100).toFixed(1)}% | $${totalCost.toFixed(2)} for ${contracts} contracts @ tick ${tickIdx}`);
        }
      }
    }
  }

  // Force-settle any remaining open positions at end of log
  for (const [t, pos] of openPositions) {
    const winner = winners.get(pos.matchup);
    const won = winner === pos.team;
    const exitPrice = won ? 1.0 : 0.0;
    const pnl = (exitPrice - pos.entryPrice) * pos.contracts;
    balanceCents += Math.round(exitPrice * pos.contracts * 100);
    closedTrades.push({ ticker: t, pnl, reason: 'end_of_log', entryPrice: pos.entryPrice, exitPrice, contracts: pos.contracts });
    console.log(`  END-OF-LOG SETTLE ${t} → ${won ? 'WIN' : 'LOSS'} | PnL=$${pnl.toFixed(2)}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  const totalPnl = closedTrades.reduce((s, t) => s + t.pnl, 0);
  const wins = closedTrades.filter((t) => t.pnl > 0).length;
  const finalBalance = STARTING_BALANCE + totalPnl;

  console.log('\n' + '─'.repeat(60));
  console.log('BACKTEST SUMMARY');
  console.log('─'.repeat(60));
  console.log(`Trades:        ${closedTrades.length}`);
  console.log(`Win rate:      ${closedTrades.length > 0 ? (wins / closedTrades.length * 100).toFixed(1) : 'N/A'}%`);
  console.log(`Total PnL:     $${totalPnl.toFixed(2)}`);
  console.log(`Start balance: $${STARTING_BALANCE.toFixed(2)}`);
  console.log(`End balance:   $${finalBalance.toFixed(2)}`);
  console.log(`Return:        ${((totalPnl / STARTING_BALANCE) * 100).toFixed(2)}%`);
  console.log('─'.repeat(60));

  if (closedTrades.length > 0) {
    console.log('\nTrade breakdown:');
    for (const t of closedTrades) {
      const outcome = t.pnl >= 0 ? 'WIN' : 'LOSS';
      console.log(`  [${outcome}] ${t.ticker} | entry=$${t.entryPrice.toFixed(2)} exit=$${t.exitPrice.toFixed(2)} x${t.contracts} = $${t.pnl.toFixed(2)} (${t.reason})`);
    }
  } else {
    console.log('\nNo trades triggered under current strategy parameters.');
    console.log('Reasons: check ENTRY_MAX_SECONDS, ENTRY_CONFIRMATION_THRESHOLD, ask=100¢ filter.');
  }
}

async function main(): Promise<void> {
  const logArg = process.argv[2];
  const logPath = logArg
    ? path.resolve(process.cwd(), logArg)
    : path.resolve(process.cwd(), 'analysis_2026-04-07.log');

  if (!fs.existsSync(logPath)) {
    console.error(`Analysis log not found: ${logPath}`);
    process.exit(1);
  }

  const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
  const ticks: Tick[] = [];
  for (const line of lines) {
    try { ticks.push(JSON.parse(line) as Tick); } catch { /* skip malformed */ }
  }

  console.log(`Loaded ${ticks.length} ticks from ${path.basename(logPath)}`);
  console.log(`Strategy: entry window=${ENTRY_MAX_SECONDS / 60} min, ask > ${ENTRY_CONFIRMATION_THRESHOLD * 100}¢ and < 100¢, ${ENTRY_CONFIRMATION_TICKS} ticks`);

  run(ticks);
}

main().catch((err) => { console.error(err); process.exit(1); });
