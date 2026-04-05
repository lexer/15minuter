/**
 * Single-shot strategy tick — runs one full cycle then exits.
 * Invoked by the cron scheduler every 30 seconds.
 */
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

import { KalshiClient } from '../api/KalshiClient';
import { MarketService } from '../services/MarketService';
import { OrderService } from '../services/OrderService';
import { PortfolioService } from '../services/PortfolioService';
import { GameMonitor } from '../services/GameMonitor';
import { TradingStrategy } from '../strategy/TradingStrategy';
import { TradeHistory } from '../storage/TradeHistory';
import { TradingAgent } from '../agent/TradingAgent';

async function main(): Promise<void> {
  const keyId = process.env.KALSHI_API_KEY;
  if (!keyId) throw new Error('KALSHI_API_KEY not set');

  const client = new KalshiClient(keyId, path.resolve(process.cwd(), 'private_key.pem'));
  const gameMonitor = new GameMonitor();
  const agent = new TradingAgent(
    new MarketService(client, gameMonitor),
    new OrderService(client),
    new PortfolioService(client),
    new TradingStrategy(),
    new TradeHistory(),
  );

  await agent.tick();
}

main().catch((err) => {
  console.error('[Tick] Fatal:', err);
  process.exit(1);
});
