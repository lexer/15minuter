/**
 * Backtest the WinProbabilityModel against NBA play-by-play data.
 *
 * Uses stats.nba.com (playbyplayv3) to pull Q4 actions for recent games,
 * samples the score at regular intervals, and compares model probability
 * against the actual game outcome.
 *
 * Usage: npm run backtest [-- --season 2024-25 --games 200]
 */

import { WinProbabilityModel } from '../services/WinProbabilityModel';

const STATS_HEADERS: Record<string, string> = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.nba.com',
  'Referer': 'https://www.nba.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
};

const STATS_BASE = 'https://stats.nba.com/stats';
const RATE_LIMIT_MS = 700;

// Seconds remaining in Q4 to sample at
const SAMPLE_SECONDS = [600, 480, 360, 300, 240, 180, 120, 90, 60, 45, 30, 15];

interface Action {
  clock: string;      // "PT02M30.00S"
  period: number;
  scoreHome: string;  // "95"
  scoreAway: string;  // "88"
}

interface CalibrationBucket {
  label: string;
  lo: number;
  hi: number;
  total: number;
  wins: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url, { headers: STATS_HEADERS });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${url}`);
  const data = await resp.json();
  if (!data || Object.keys(data).length === 0) throw new Error(`Empty response from ${url}`);
  return data;
}

async function fetchGameIds(season: string, maxGames: number): Promise<string[]> {
  const url = `${STATS_BASE}/leaguegamelog?Counter=0&DateFrom=&DateTo=&Direction=DESC&LeagueID=00&PlayerOrTeam=T&Season=${season}&SeasonType=Regular+Season&Sorter=DATE`;
  const data = await fetchJson(url);
  const rs = data.resultSets?.[0];
  if (!rs) throw new Error('leaguegamelog: unexpected response shape');
  const headers: string[] = rs.headers;
  const gameIdIdx = headers.indexOf('GAME_ID');

  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rs.rowSet as any[][]) {
    const gid = row[gameIdIdx] as string;
    if (!seen.has(gid)) { seen.add(gid); ids.push(gid); }
    if (ids.length >= maxGames) break;
  }
  return ids;
}

async function fetchQ4Actions(gameId: string): Promise<Action[]> {
  const url = `${STATS_BASE}/playbyplayv3?GameID=${gameId}&StartPeriod=4&EndPeriod=4`;
  const data = await fetchJson(url);
  const actions: any[] = data.game?.actions ?? [];
  return actions
    .filter((a) => a.period === 4 && a.clock && a.scoreHome !== '' && a.scoreAway !== '')
    .map((a) => ({ clock: a.clock, period: a.period, scoreHome: String(a.scoreHome), scoreAway: String(a.scoreAway) }));
}

/** "PT02M30.00S" → seconds remaining in Q4 */
function clockToSeconds(clock: string): number {
  return WinProbabilityModel.clockToSeconds(clock);
}

/** Find action closest to targetSec remaining */
function actionAtTime(actions: Action[], targetSec: number): Action | null {
  let best: Action | null = null;
  let bestDiff = Infinity;
  for (const a of actions) {
    const diff = Math.abs(clockToSeconds(a.clock) - targetSec);
    if (diff < bestDiff) { bestDiff = diff; best = a; }
  }
  return best;
}

function makeBuckets(): CalibrationBucket[] {
  return [
    { label: '50–60%', lo: 0.50, hi: 0.60, total: 0, wins: 0 },
    { label: '60–70%', lo: 0.60, hi: 0.70, total: 0, wins: 0 },
    { label: '70–80%', lo: 0.70, hi: 0.80, total: 0, wins: 0 },
    { label: '80–90%', lo: 0.80, hi: 0.90, total: 0, wins: 0 },
    { label: '90–95%', lo: 0.90, hi: 0.95, total: 0, wins: 0 },
    { label: '95–99%', lo: 0.95, hi: 0.99, total: 0, wins: 0 },
    { label: '99–100%', lo: 0.99, hi: 1.01, total: 0, wins: 0 },
  ];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const season = args[args.indexOf('--season') + 1] ?? '2024-25';
  const maxGames = parseInt(args[args.indexOf('--games') + 1] ?? '150', 10);

  const model = new WinProbabilityModel();
  console.log(`\nBacktest: WinProbabilityModel vs NBA play-by-play (${season}, up to ${maxGames} games)\n`);

  console.log('Fetching game list...');
  await sleep(RATE_LIMIT_MS);
  const gameIds = await fetchGameIds(season, maxGames);
  console.log(`Found ${gameIds.length} games\n`);

  const buckets = makeBuckets();
  let totalSamples = 0;
  let brierSum = 0;
  let processed = 0;
  let skipped = 0;

  for (let i = 0; i < gameIds.length; i++) {
    const gameId = gameIds[i];
    process.stdout.write(`\r[${i + 1}/${gameIds.length}] ${gameId} — ${processed} processed, ${skipped} skipped  `);

    try {
      await sleep(RATE_LIMIT_MS);
      const actions = await fetchQ4Actions(gameId);
      if (actions.length === 0) { skipped++; continue; }

      // Determine final result from last action with scores
      const last = actions[actions.length - 1];
      const finalHome = parseInt(last.scoreHome, 10);
      const finalAway = parseInt(last.scoreAway, 10);
      if (isNaN(finalHome) || isNaN(finalAway) || finalHome === finalAway) { skipped++; continue; } // OT
      const homeWon = finalHome > finalAway;

      for (const targetSec of SAMPLE_SECONDS) {
        const action = actionAtTime(actions, targetSec);
        if (!action) continue;

        const home = parseInt(action.scoreHome, 10);
        const away = parseInt(action.scoreAway, 10);
        if (isNaN(home) || isNaN(away)) continue;

        const margin = home - away; // positive = home leading
        const secondsLeft = WinProbabilityModel.secondsRemaining(4, action.clock);
        const homeProb = model.calculate(margin, secondsLeft);
        const awayProb = 1 - homeProb;

        // Home team perspective
        const homeBucket = buckets.find((b) => homeProb >= b.lo && homeProb < b.hi);
        if (homeBucket) { homeBucket.total++; if (homeWon) homeBucket.wins++; }
        brierSum += (homeProb - (homeWon ? 1 : 0)) ** 2;

        // Away team perspective
        const awayBucket = buckets.find((b) => awayProb >= b.lo && awayProb < b.hi);
        if (awayBucket) { awayBucket.total++; if (!homeWon) awayBucket.wins++; }
        brierSum += (awayProb - (!homeWon ? 1 : 0)) ** 2;

        totalSamples += 2;
      }
      processed++;
    } catch {
      skipped++;
    }
  }

  console.log(`\n\nResults: ${processed} games, ${skipped} skipped, ${totalSamples.toLocaleString()} samples\n`);

  console.log('Calibration — model probability vs empirical win rate:');
  console.log('─'.repeat(65));
  console.log(`${'Bucket'.padEnd(10)} ${'N'.padStart(6)} ${'Model'.padStart(8)} ${'Actual'.padStart(8)} ${'Error'.padStart(8)} ${'Verdict'}`);
  console.log('─'.repeat(65));

  for (const b of buckets) {
    if (b.total === 0) continue;
    const empirical = b.wins / b.total;
    const modelMid = (b.lo + Math.min(b.hi, 1.0)) / 2;
    const error = empirical - modelMid;
    const sign = error >= 0 ? '+' : '';
    const verdict = Math.abs(error) < 0.03 ? '✓ good' : error > 0 ? '↑ underconfident' : '↓ overconfident';
    console.log(
      `${b.label.padEnd(10)} ${String(b.total).padStart(6)} ${(modelMid * 100).toFixed(1).padStart(7)}% ${(empirical * 100).toFixed(1).padStart(7)}% ${(sign + (error * 100).toFixed(1) + '%').padStart(8)}  ${verdict}`,
    );
  }

  console.log('─'.repeat(65));
  if (totalSamples > 0) {
    console.log(`\nBrier score: ${(brierSum / totalSamples).toFixed(4)}  (random=0.250, perfect=0.000)`);
    console.log(`Samples: ${totalSamples.toLocaleString()} across ${processed} games\n`);
  }
}

main().catch((err) => { console.error('\nBacktest error:', err.message); process.exit(1); });
