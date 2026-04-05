import * as dotenv from 'dotenv';
dotenv.config();

import * as path from 'path';
import { KalshiClient } from '../../src/api/KalshiClient';

const KEY_ID = process.env.KALSHI_API_KEY!;
const KEY_PATH = path.resolve(process.cwd(), 'private_key.pem');

describe('KalshiClient (real API)', () => {
  let client: KalshiClient;

  beforeAll(() => {
    client = new KalshiClient(KEY_ID, KEY_PATH);
  });

  it('fetches balance from live API', async () => {
    const balance = await client.getBalance();
    expect(typeof balance.balance).toBe('number');
    expect(balance.balance).toBeGreaterThanOrEqual(0);
  });

  it('fetches open markets', async () => {
    const resp = await client.getMarkets({ status: 'open', limit: 5 });
    expect(Array.isArray(resp.markets)).toBe(true);
    expect(resp.markets.length).toBeGreaterThanOrEqual(0);
  });

  it('fetches open events', async () => {
    const resp = await client.getEvents({ status: 'open', limit: 5 });
    expect(Array.isArray(resp.events)).toBe(true);
  });

  it('fetches positions', async () => {
    const resp = await client.getPositions({ limit: 10 });
    expect(Array.isArray(resp.market_positions)).toBe(true);
  });
});
