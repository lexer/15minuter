import { BtcPriceMonitor } from '../../src/services/BtcPriceMonitor';

// Mock the global fetch used by BtcPriceMonitor
const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeKlineResponse(open: number, closeTime: number): string {
  const openTime = closeTime - 15 * 60 * 1000;
  return JSON.stringify([[openTime, open.toString(), '0', '0', '0', '0', closeTime, '0', '0', '0', '0', '0']]);
}

function makePriceResponse(price: number): string {
  return JSON.stringify({ symbol: 'BTCUSDT', price: price.toString() });
}

describe('BtcPriceMonitor', () => {
  let monitor: BtcPriceMonitor;

  beforeEach(() => {
    monitor = new BtcPriceMonitor();
    mockFetch.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns null when fetch fails', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const state = await monitor.getBtcState();
    expect(state).toBeNull();
  });

  it('returns null when kline response is not ok', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => [] })
      .mockResolvedValueOnce({ ok: true,  status: 200, json: async () => ({ symbol: 'BTCUSDT', price: '80000' }) });
    const state = await monitor.getBtcState();
    expect(state).toBeNull();
  });

  it('parses BTC state correctly', async () => {
    const closeTime = Date.now() + 300_000;
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse(makeKlineResponse(80000, closeTime)) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse(makePriceResponse(80400)) });

    const state = await monitor.getBtcState();
    expect(state).not.toBeNull();
    expect(state!.windowOpenPrice).toBeCloseTo(80000);
    expect(state!.currentPrice).toBeCloseTo(80400);
    expect(state!.priceChangeFraction).toBeCloseTo(0.005, 5); // 0.5% up
  });

  it('returns cached state within TTL without re-fetching', async () => {
    const closeTime = Date.now() + 300_000;
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse(makeKlineResponse(80000, closeTime)) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse(makePriceResponse(80100)) });

    await monitor.getBtcState();
    await monitor.getBtcState(); // second call within TTL

    expect(mockFetch).toHaveBeenCalledTimes(2); // only one set of requests
  });

  it('re-fetches after TTL expires', async () => {
    const closeTime = Date.now() + 300_000;
    mockFetch
      .mockResolvedValue({ ok: true, status: 200, json: async () => JSON.parse(makeKlineResponse(80000, closeTime)) });
    // Override second call for price
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse(makeKlineResponse(80000, closeTime)) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse(makePriceResponse(80100)) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse(makeKlineResponse(80000, closeTime)) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse(makePriceResponse(80200)) });

    await monitor.getBtcState();
    jest.advanceTimersByTime(6_000); // past 5s TTL
    await monitor.getBtcState();

    expect(mockFetch).toHaveBeenCalledTimes(4); // two full fetches
  });

  it('computes negative priceChangeFraction when BTC is down', async () => {
    const closeTime = Date.now() + 300_000;
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse(makeKlineResponse(80000, closeTime)) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => JSON.parse(makePriceResponse(79600)) });

    const state = await monitor.getBtcState();
    expect(state!.priceChangeFraction).toBeCloseTo(-0.005, 5); // -0.5%
  });
});
