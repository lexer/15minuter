import { EventEmitter } from 'events';
import { BtcPriceMonitor } from '../../src/services/BtcPriceMonitor';

// ── fetch mock (credential scraping) ─────────────────────────────────────────

const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeHtmlResponse(buildId = 'test-build-id'): Response {
  return {
    ok:   true,
    text: async () => `<html><script id="__NEXT_DATA__">{"buildId":"${buildId}"}</script></html>`,
  } as unknown as Response;
}

function makePageDataResponse(keyId = 'testKey', keyPass = 'testPass'): Response {
  return {
    ok:   true,
    json: async () => ({ pageProps: { wsApiKeyId: keyId, wsApiKeyPassword: keyPass } }),
  } as unknown as Response;
}

function setupFetchMocks(buildId = 'test-build', keyId = 'testKey', keyPass = 'testPass'): void {
  mockFetch
    .mockResolvedValueOnce(makeHtmlResponse(buildId))
    .mockResolvedValueOnce(makePageDataResponse(keyId, keyPass));
}

// ── WebSocket mock ────────────────────────────────────────────────────────────

class MockWs extends EventEmitter {
  static instance: MockWs | null = null;
  sent: string[] = [];

  constructor() {
    super();
    MockWs.instance = this;
  }

  send(data: string): void { this.sent.push(data); }
  close(): void { this.emit('close'); }
  removeAllListeners(): this { super.removeAllListeners(); return this; }
}

jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => new MockWs()),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function emitBrtiPrice(price: number, timeMs = Date.now()): void {
  MockWs.instance?.emit(
    'message',
    Buffer.from(JSON.stringify({ type: 'value', id: 'BRTI', value: String(price), time: timeMs })),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BtcPriceMonitor', () => {
  let monitor: BtcPriceMonitor;

  beforeEach(() => {
    MockWs.instance = null;
    mockFetch.mockReset();
    monitor = new BtcPriceMonitor();
  });

  afterEach(() => {
    monitor.stop();
  });

  it('returns null before first price is received', async () => {
    setupFetchMocks();
    await monitor.start();
    const state = await monitor.getBtcState();
    expect(state).toBeNull();
  });

  it('returns BRTI price after receiving a value message', async () => {
    setupFetchMocks();
    await monitor.start();
    emitBrtiPrice(71500);
    const state = await monitor.getBtcState();
    expect(state).not.toBeNull();
    expect(state!.currentPrice).toBeCloseTo(71500);
  });

  it('sends subscribe message on connect', async () => {
    setupFetchMocks();
    await monitor.start();
    MockWs.instance?.emit('open');
    expect(MockWs.instance?.sent).toContainEqual(
      JSON.stringify({ type: 'subscribe', id: 'BRTI', stream: 'value' }),
    );
  });

  it('updates price on subsequent messages', async () => {
    setupFetchMocks();
    await monitor.start();
    emitBrtiPrice(71000);
    emitBrtiPrice(71500);
    const state = await monitor.getBtcState();
    expect(state!.currentPrice).toBeCloseTo(71500);
  });

  it('ignores messages for other ids', async () => {
    setupFetchMocks();
    await monitor.start();
    MockWs.instance?.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'value', id: 'ETHUSD', value: '3000', time: Date.now() })),
    );
    const state = await monitor.getBtcState();
    expect(state).toBeNull();
  });

  it('ignores malformed messages without throwing', async () => {
    setupFetchMocks();
    await monitor.start();
    MockWs.instance?.emit('message', Buffer.from('not-json'));
    const state = await monitor.getBtcState();
    expect(state).toBeNull();
  });

  it('does not connect if credential fetch fails', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));
    const WebSocket = require('ws').default as jest.Mock;
    WebSocket.mockClear();
    await monitor.start();
    expect(WebSocket).not.toHaveBeenCalled();
  });

  it('getIntervalPrices returns prices at or after sinceMs', async () => {
    setupFetchMocks();
    await monitor.start();
    const now = Date.now();
    emitBrtiPrice(71000, now - 1000);  // 1s ago
    emitBrtiPrice(71100, now - 500);   // 0.5s ago
    emitBrtiPrice(71200, now);         // now

    // Ask for prices since 750ms ago → should get the last two
    const prices = monitor.getIntervalPrices(now - 750);
    expect(prices).toHaveLength(2);
    expect(prices[0]).toBeCloseTo(71100);
    expect(prices[1]).toBeCloseTo(71200);
  });

  it('getIntervalPrices returns empty array before any prices', async () => {
    setupFetchMocks();
    await monitor.start();
    expect(monitor.getIntervalPrices(Date.now() - 1000)).toHaveLength(0);
  });

  it('getIntervalPrices clears after reconnect', async () => {
    setupFetchMocks();
    await monitor.start();
    emitBrtiPrice(71000, Date.now() - 500);
    expect(monitor.getIntervalPrices(0)).toHaveLength(1);

    // Trigger reconnect by emitting close
    setupFetchMocks('new-build', 'newKey', 'newPass');
    MockWs.instance?.emit('close');
    await new Promise((r) => setTimeout(r, 10)); // let reconnect fire

    expect(monitor.getIntervalPrices(0)).toHaveLength(0);
  });

  it('stop() prevents reconnection', async () => {
    setupFetchMocks();
    const WebSocket = require('ws').default as jest.Mock;
    WebSocket.mockClear();
    await monitor.start();
    monitor.stop();
    MockWs.instance?.emit('close');
    // Should not create a new WebSocket after stop
    expect(WebSocket).toHaveBeenCalledTimes(1);
  });
});
