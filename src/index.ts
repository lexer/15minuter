import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config();

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
  );

  process.on('SIGINT', () => {
    console.log('\n[Main] Received SIGINT — shutting down...');
    agent.stop();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[Main] Received SIGTERM — shutting down...');
    agent.stop();
    process.exit(0);
  });

  agent.start().catch((err) => {
    console.error('[Main] Fatal error:', err);
    process.exit(1);
  });
}

main();
