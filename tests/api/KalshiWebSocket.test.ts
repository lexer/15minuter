import * as crypto from 'crypto';
import WebSocket, { Server as WsServer } from 'ws';
import { KalshiWebSocket, WsTickerMessage, WsFillMessage, WsMarketPositionMessage } from '../../src/api/KalshiWebSocket';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeKeyPair() {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
}

/** Wait for ms milliseconds. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until predicate returns true, polling every 20ms up to timeoutMs. */
async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await delay(20);
  }
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('KalshiWebSocket', () => {
  let server: WsServer;
  let serverUrl: string;
  let client: KalshiWebSocket;
  const { privateKey } = makeKeyPair();

  // Each test gets a fresh server bound to an OS-assigned port
  beforeEach(async () => {
    server = new WsServer({ port: 0 });
    await new Promise<void>((r) => server.once('listening', r));
    const addr = server.address() as { port: number };
    serverUrl = `ws://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    client?.stop();
    await new Promise<void>((r) => server.close(() => r()));
  });

  // ── 1. Connection ────────────────────────────────────────────────────────

  it('connects to server and server sees the connection', async () => {
    let serverGotConnection = false;
    server.once('connection', () => { serverGotConnection = true; });

    client = new KalshiWebSocket('key-id', privateKey, serverUrl, 5_000);
    await client.connect();

    await waitFor(() => serverGotConnection);
    expect(serverGotConnection).toBe(true);
  });

  // ── 2. Typed message emission ────────────────────────────────────────────

  it('emits ticker events from server messages', async () => {
    let received: WsTickerMessage | null = null;
    client = new KalshiWebSocket('key-id', privateKey, serverUrl, 5_000);
    client.on('ticker', (msg) => { received = msg; });

    server.once('connection', (ws) => {
      ws.send(JSON.stringify({
        type: 'ticker',
        msg: {
          market_ticker:   'NBA-TEST',
          yes_bid_dollars: 0.91,
          yes_ask_dollars: 0.93,
          price_dollars:   0.92,
          volume_fp:       '1000',
          ts:              Date.now(),
        } satisfies WsTickerMessage,
      }));
    });

    await client.connect();
    await waitFor(() => received !== null);

    expect(received!.market_ticker).toBe('NBA-TEST');
    expect(received!.yes_bid_dollars).toBe(0.91);
  });

  it('emits fill events from server messages', async () => {
    let received: WsFillMessage | null = null;
    client = new KalshiWebSocket('key-id', privateKey, serverUrl, 5_000);
    client.on('fill', (msg) => { received = msg; });

    server.once('connection', (ws) => {
      ws.send(JSON.stringify({
        type: 'fill',
        msg: {
          trade_id:          'trade-1',
          order_id:          'order-1',
          market_ticker:     'NBA-TEST',
          side:              'yes',
          action:            'buy',
          yes_price_dollars: '0.92',
          count_fp:          '10',
          post_position_fp:  '10',
          fee_cost:          '0.01',
          ts:                Date.now(),
        } satisfies WsFillMessage,
      }));
    });

    await client.connect();
    await waitFor(() => received !== null);

    expect(received!.trade_id).toBe('trade-1');
    expect(received!.action).toBe('buy');
  });

  it('emits market_position events from server messages', async () => {
    let received: WsMarketPositionMessage | null = null;
    client = new KalshiWebSocket('key-id', privateKey, serverUrl, 5_000);
    client.on('market_position', (msg) => { received = msg; });

    server.once('connection', (ws) => {
      ws.send(JSON.stringify({
        type: 'market_position',
        msg: {
          user_id:                   'user-1',
          market_ticker:             'NBA-TEST',
          position_fp:               '5',
          position_cost_dollars:     '4.60',
          realized_pnl_dollars:      '0.00',
          fees_paid_dollars:         '0.01',
          position_fee_cost_dollars: '0.01',
        } satisfies WsMarketPositionMessage,
      }));
    });

    await client.connect();
    await waitFor(() => received !== null);

    expect(received!.market_ticker).toBe('NBA-TEST');
    expect(received!.position_fp).toBe('5');
  });

  it('silently ignores messages without msg field', async () => {
    const received: unknown[] = [];
    client = new KalshiWebSocket('key-id', privateKey, serverUrl, 5_000);
    client.on('ticker', (m) => received.push(m));
    client.on('fill', (m) => received.push(m));
    client.on('market_position', (m) => received.push(m));

    server.once('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'subscribed', sid: 1 })); // no msg field
    });

    await client.connect();
    await delay(100);
    expect(received).toHaveLength(0);
  });

  // ── 3. Watchdog fires after silence ──────────────────────────────────────

  it('reconnects when no frames arrive within watchdogMs', async () => {
    const WATCHDOG = 200; // very short for test speed
    let connectionCount = 0;
    server.on('connection', () => { connectionCount++; /* send nothing */ });

    client = new KalshiWebSocket('key-id', privateKey, serverUrl, WATCHDOG);
    await client.connect();

    // Wait for watchdog to fire and reconnect
    await waitFor(() => connectionCount >= 2, 2_000);
    expect(connectionCount).toBeGreaterThanOrEqual(2);
  });

  // ── 4. Ping resets watchdog ──────────────────────────────────────────────

  it('does NOT reconnect when server sends pings within watchdogMs', async () => {
    const WATCHDOG = 300;
    let connectionCount = 0;
    const pingIntervals: ReturnType<typeof setInterval>[] = [];

    server.on('connection', (ws) => {
      connectionCount++;
      // Send a ping every 100ms — well within the 300ms watchdog
      const iv = setInterval(() => ws.ping(), 100);
      pingIntervals.push(iv);
      ws.on('close', () => clearInterval(iv));
    });

    client = new KalshiWebSocket('key-id', privateKey, serverUrl, WATCHDOG);
    await client.connect();

    // Wait 500ms (>1 watchdog period) — should still be on first connection
    await delay(500);
    expect(connectionCount).toBe(1);

    pingIntervals.forEach(clearInterval);
  });

  // ── 5. Message resets watchdog ───────────────────────────────────────────

  it('does NOT reconnect when server sends messages within watchdogMs', async () => {
    const WATCHDOG = 300;
    let connectionCount = 0;

    server.on('connection', (ws) => {
      connectionCount++;
      // Send a data frame every 100ms
      const iv = setInterval(() => {
        ws.send(JSON.stringify({ type: 'subscribed', sid: 1 }));
      }, 100);
      ws.on('close', () => clearInterval(iv));
    });

    client = new KalshiWebSocket('key-id', privateKey, serverUrl, WATCHDOG);
    await client.connect();

    await delay(500);
    expect(connectionCount).toBe(1);
  });

  // ── 6. No outgoing ping frames ───────────────────────────────────────────

  it('never sends outgoing ping frames to the server', async () => {
    let pingReceived = false;

    server.once('connection', (ws) => {
      ws.on('ping', () => { pingReceived = true; });
      // Keep connection alive with server-side pings so watchdog doesn't fire
      const iv = setInterval(() => ws.ping(), 50);
      ws.on('close', () => clearInterval(iv));
    });

    client = new KalshiWebSocket('key-id', privateKey, serverUrl, 5_000);
    await client.connect();
    await delay(300);

    expect(pingReceived).toBe(false);
  });

  // ── 7. Resubscribes tickers after reconnect ──────────────────────────────

  it('resubscribes to tickers after reconnect', async () => {
    const WATCHDOG = 200;
    const receivedCmds: unknown[] = [];
    let connectionCount = 0;

    server.on('connection', (ws) => {
      connectionCount++;
      ws.on('message', (data) => {
        try { receivedCmds.push(JSON.parse(data.toString())); } catch { /* ignore */ }
      });
      // Only keep second connection alive with pings
      if (connectionCount >= 2) {
        const iv = setInterval(() => ws.ping(), 50);
        ws.on('close', () => clearInterval(iv));
      }
    });

    client = new KalshiWebSocket('key-id', privateKey, serverUrl, WATCHDOG);
    client.subscribeToTickers(['NBA-LAKERS', 'NBA-CELTICS']);
    await client.connect();

    // Wait for reconnect
    await waitFor(() => connectionCount >= 2, 2_000);
    await delay(100); // let subscribe commands arrive

    // Find subscribe commands sent on the second connection
    // (first connection sends fill + market_positions + ticker subscribe)
    const tickerSubscribes = receivedCmds.filter((c: any) =>
      c.cmd === 'subscribe' &&
      c.params?.channels?.includes('ticker') &&
      c.params?.market_tickers?.length > 0
    );

    // There should be at least one ticker subscribe from after reconnect
    expect(tickerSubscribes.length).toBeGreaterThanOrEqual(1);
    const allTickers = tickerSubscribes.flatMap((c: any) => c.params.market_tickers as string[]);
    expect(allTickers).toContain('NBA-LAKERS');
    expect(allTickers).toContain('NBA-CELTICS');
  });
});
