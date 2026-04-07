import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

// ── Single-instance lock via PID file ────────────────────────────────────────
const PID_FILE = path.resolve(process.cwd(), 'agent.pid');

function acquireLock(): void {
  if (fs.existsSync(PID_FILE)) {
    const existingPid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    if (!isNaN(existingPid)) {
      try {
        process.kill(existingPid, 0); // throws if process does not exist
        console.error(`[Main] Agent already running (PID ${existingPid}). Exiting.`);
        process.exit(1);
      } catch {
        // Stale PID file — previous process is gone, safe to overwrite
      }
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
}

function releaseLock(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ }
}

acquireLock();
// ─────────────────────────────────────────────────────────────────────────────

// Redirect stdout to a PST-dated agent log; stderr to a dedicated errors.log
const pstDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const logPath = path.resolve(process.cwd(), `agent_${pstDate}.log`);
const errorLogPath = path.resolve(process.cwd(), 'errors.log');

const logStream = fs.createWriteStream(logPath, { flags: 'a' });
const errorStream = fs.createWriteStream(errorLogPath, { flags: 'a' });

process.stdout.write = logStream.write.bind(logStream);
process.stderr.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${chunk}`;
  errorStream.write(line);
  logStream.write(line);  // also mirror to agent log for context
  return true;
};

function closeStreams(): void {
  logStream.end();
  errorStream.end();
}

function cleanup(): void {
  releaseLock();
  closeStreams();
}

process.on('exit', cleanup);

import { KalshiClient } from './api/KalshiClient';
import { MarketService } from './services/MarketService';
import { OrderService } from './services/OrderService';
import { PortfolioService } from './services/PortfolioService';
import { GameMonitor } from './services/GameMonitor';
import { TradingStrategy } from './strategy/TradingStrategy';
import { TradeHistory } from './storage/TradeHistory';
import { TradingAgent } from './agent/TradingAgent';

function main(): void {
  const keyId = process.env.KALSHI_API_KEY;
  if (!keyId) {
    throw new Error('KALSHI_API_KEY not set in .env');
  }

  const privateKeyPath = path.resolve(process.cwd(), 'private_key.pem');

  const client = new KalshiClient(keyId, privateKeyPath);
  const gameMonitor = new GameMonitor();
  const marketService = new MarketService(client, gameMonitor);
  const orderService = new OrderService(client);
  const portfolioService = new PortfolioService(client);
  const strategy = new TradingStrategy();
  const history = new TradeHistory();

  const agent = new TradingAgent(
    marketService,
    orderService,
    portfolioService,
    strategy,
    history,
    gameMonitor,
  );

  const shutdown = (signal: string) => {
    console.log(`\n[Main] Received ${signal} — shutting down...`);
    agent.stop();
    cleanup();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  agent.start().catch((err) => {
    console.error('[Main] Fatal error:', err);
    cleanup();
    process.exit(1);
  });
}

main();
