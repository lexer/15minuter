/**
 * Backtest the WinProbabilityModel against NBA play-by-play data.
 *
 * On first run fetches from stats.nba.com and saves to data/nba/{season}/.
 * Subsequent runs load from local cache — no API calls needed.
 *
 * Usage:
 *   npm run backtest                          # 2024-25, up to 150 games
 *   npm run backtest -- --season 2023-24 --games 200
 *   npm run backtest -- --fetch-only          # download data without calibration output
 */

import * as fs from 'fs';
import * as path from 'path';
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
const DATA_DIR = path.resolve(process.cwd(), 'data', 'nba');

// Seconds remaining in Q4 to sample at
const SAMPLE_SECONDS = [600, 480, 360, 300, 240, 180, 120, 90, 60, 45, 30, 15];

export interface GameRecord {
  gameId: string;
  season: string;
  homeWon: boolean;
  q4Actions: Q4Action[];
}

export interface Q4Action {
  clock: string;    // "PT02M30.00S"
  scoreHome: number;
  scoreAway: number;
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

function gameDataPath(season: string, gameId: string): string {
  return path.join(DATA_DIR, season, `${gameId}.json`);
}

function loadCachedGame(season: string, gameId: string): GameRecord | null {
  const p = gameDataPath(season, gameId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as GameRecord;
}

function saveGameRecord(record: GameRecord): void {
  const dir = path.join(DATA_DIR, record.season);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(gameDataPath(record.season, record.gameId), JSON.stringify(record), 'utf-8');
}

async function fetchGameIds(season: string, maxGames: number): Promise<string[]> {
  const url = `${STATS_BASE}/leaguegamelog?Counter=0&DateFrom=&DateTo=&Direction=DESC&LeagueID=00&PlayerOrTeam=T&Season=${season}&SeasonType=Regular+Season&Sorter=DATE`;
  const data = await fetchJson(url);
  const rs = data.resultSets?.[0];
  if (!rs) throw new Error('leaguegamelog: unexpected response shape');
  const gameIdIdx = (rs.headers as string[]).indexOf('GAME_ID');
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rs.rowSet as any[][]) {
    const gid = row[gameIdIdx] as string;
    if (!seen.has(gid)) { seen.add(gid); ids.push(gid); }
    if (ids.length >= maxGames) break;
  }
  return ids;
}

async function fetchAndSaveGame(season: string, gameId: string): Promise<GameRecord | null> {
  const url = `${STATS_BASE}/playbyplayv3?GameID=${gameId}&StartPeriod=4&EndPeriod=4`;
  const data = await fetchJson(url);
  const actions: any[] = data.game?.actions ?? [];

  const q4 = actions.filter((a) => a.period === 4 && a.clock && a.scoreHome !== '' && a.scoreAway !== '');
  if (q4.length === 0) return null;

  const last = q4[q4.length - 1];
  const finalHome = parseInt(last.scoreHome, 10);
  const finalAway = parseInt(last.scoreAway, 10);
  if (isNaN(finalHome) || isNaN(finalAway) || finalHome === finalAway) return null; // OT

  const record: GameRecord = {
    gameId,
    season,
    homeWon: finalHome > finalAway,
    q4Actions: q4.map((a) => ({
      clock: a.clock,
      scoreHome: parseInt(a.scoreHome, 10),
      scoreAway: parseInt(a.scoreAway, 10),
    })),
  };

  saveGameRecord(record);
  return record;
}

function actionAtTime(record: GameRecord, targetSec: number): Q4Action | null {
  let best: Q4Action | null = null;
  let bestDiff = Infinity;
  for (const a of record.q4Actions) {
    const diff = Math.abs(WinProbabilityModel.clockToSeconds(a.clock) - targetSec);
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
  const fetchOnly = args.includes('--fetch-only');

  const model = new WinProbabilityModel();
  console.log(`\nBacktest: WinProbabilityModel vs NBA play-by-play (${season}, up to ${maxGames} games)`);
  console.log(`Data cache: ${path.join(DATA_DIR, season)}\n`);

  await sleep(RATE_LIMIT_MS);
  const gameIds = await fetchGameIds(season, maxGames);
  console.log(`Found ${gameIds.length} games\n`);

  const buckets = makeBuckets();
  let totalSamples = 0;
  let brierSum = 0;
  let processed = 0;
  let skipped = 0;
  let fromCache = 0;

  for (let i = 0; i < gameIds.length; i++) {
    const gameId = gameIds[i];
    process.stdout.write(`\r[${i + 1}/${gameIds.length}] ${gameId} — ${processed} ok, ${skipped} skipped, ${fromCache} from cache  `);

    try {
      let record = loadCachedGame(season, gameId);
      if (record) {
        fromCache++;
      } else {
        await sleep(RATE_LIMIT_MS);
        record = await fetchAndSaveGame(season, gameId);
      }

      if (!record) { skipped++; continue; }
      if (fetchOnly) { processed++; continue; }

      for (const targetSec of SAMPLE_SECONDS) {
        const action = actionAtTime(record, targetSec);
        if (!action) continue;

        const margin = action.scoreHome - action.scoreAway;
        const secondsLeft = WinProbabilityModel.secondsRemaining(4, action.clock);
        const homeProb = model.calculate(margin, secondsLeft);
        const awayProb = 1 - homeProb;

        const homeBucket = buckets.find((b) => homeProb >= b.lo && homeProb < b.hi);
        if (homeBucket) { homeBucket.total++; if (record.homeWon) homeBucket.wins++; }

        const awayBucket = buckets.find((b) => awayProb >= b.lo && awayProb < b.hi);
        if (awayBucket) { awayBucket.total++; if (!record.homeWon) awayBucket.wins++; }

        brierSum += (homeProb - (record.homeWon ? 1 : 0)) ** 2;
        brierSum += (awayProb - (!record.homeWon ? 1 : 0)) ** 2;
        totalSamples += 2;
      }
      processed++;
    } catch {
      skipped++;
    }
  }

  const cachedCount = fs.existsSync(path.join(DATA_DIR, season))
    ? fs.readdirSync(path.join(DATA_DIR, season)).length : 0;

  console.log(`\n\nResults: ${processed} games, ${skipped} skipped, ${fromCache} loaded from cache`);
  console.log(`Cached games on disk: ${cachedCount} in data/nba/${season}/\n`);

  if (fetchOnly) return;

  console.log('Calibration — model probability vs empirical win rate:');
  console.log('─'.repeat(65));
  console.log(`${'Bucket'.padEnd(10)} ${'N'.padStart(6)} ${'Model'.padStart(8)} ${'Actual'.padStart(8)} ${'Error'.padStart(8)} Verdict`);
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
