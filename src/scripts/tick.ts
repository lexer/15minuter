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

  const gameMonitor = new GameMonitor();

  // Log live game scores before the tick
  const games = await gameMonitor.getLiveGames();
  const live = games.filter((g) => g.gameStatus === 2);
  const upcoming = games.filter((g) => g.gameStatus === 1);
  if (live.length > 0) {
    console.log(`[Games] ${live.length} live:`);
    live.forEach((g) =>
      console.log(
        `  ${g.awayTeamTricode}@${g.homeTeamTricode} Q${g.period} ${g.gameClock.replace('PT', '').replace('M', 'm').replace('.00S', 's')} | ${g.awayScore}-${g.homeScore}${g.isQ4OrLater ? ' *** Q4' : ''}`,
      ),
    );
  }
  if (upcoming.length > 0) {
    console.log(`[Games] ${upcoming.length} upcoming: ${upcoming.map((g) => `${g.awayTeamTricode}@${g.homeTeamTricode}`).join(', ')}`);
  }

  const client = new KalshiClient(keyId, path.resolve(process.cwd(), 'private_key.pem'));
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
