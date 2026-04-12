import { MarketService, TRADING_WINDOW_MIN_SECONDS, TRADING_WINDOW_MAX_SECONDS } from '../../src/services/MarketService';
import { BtcPriceMonitor, BrtiState } from '../../src/services/BtcPriceMonitor';
import { KalshiClient } from '../../src/api/KalshiClient';

function makeClient(markets: object[]): jest.Mocked<Pick<KalshiClient, 'getMarkets'>> {
  return { getMarkets: jest.fn().mockResolvedValue({ markets, cursor: '' }) } as never;
}

function makeMonitor(state: BrtiState | null = null): jest.Mocked<Pick<BtcPriceMonitor, 'getBtcState' | 'getIntervalPrices'>> {
  return {
    getBtcState:       jest.fn().mockResolvedValue(state),
    getIntervalPrices: jest.fn().mockReturnValue([]),
  } as never;
}

/** Build a raw Kalshi market with the threshold in the floor_strike field.
 *  Pass threshold=0 to omit floor_strike (simulates markets without it). */
function makeRawMarket(ticker: string, secondsFromNow: number, threshold = 80000): object {
  return {
    ticker,
    event_ticker:        'KXBTC15M',
    title:               `BTC 15-min ${ticker}`,
    status:              'active',
    yes_bid_dollars:     '0.92',
    yes_ask_dollars:     '0.94',
    no_bid_dollars:      '0.06',
    no_ask_dollars:      '0.08',
    last_price_dollars:  '0.93',
    volume_fp:           '100',
    close_time:          new Date(Date.now() + secondsFromNow * 1000).toISOString(),
    can_close_early:     false,
    ...(threshold > 0 ? { floor_strike: threshold } : {}),
    rules_primary:       '',
    rules_secondary:     '',
  };
}

// Real KXBTC15M-style ticker with threshold 80000
const TICKER_80K = `KXBTC15M-26APR11-T80000`;

const BRTI_STATE: BrtiState = {
  currentPrice: 80400,
  lastUpdated:  new Date(),
  momentum:     null,
};

describe('MarketService', () => {
  describe('trading window classification', () => {
    it('marks market as in window when secondsLeft is between min and max', async () => {
      const svc = new MarketService(makeClient([makeRawMarket(TICKER_80K, 30)]) as never, makeMonitor(BRTI_STATE) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      expect(m.isInTradingWindow).toBe(true);
      expect(m.secondsLeft).toBeGreaterThanOrEqual(TRADING_WINDOW_MIN_SECONDS);
      expect(m.secondsLeft).toBeLessThanOrEqual(TRADING_WINDOW_MAX_SECONDS);
    });

    it('marks market outside window when secondsLeft > max', async () => {
      const svc = new MarketService(makeClient([makeRawMarket(TICKER_80K, TRADING_WINDOW_MAX_SECONDS + 60)]) as never, makeMonitor(BRTI_STATE) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      expect(m.isInTradingWindow).toBe(false);
    });

    it('marks market outside window when secondsLeft < min', async () => {
      const svc = new MarketService(makeClient([makeRawMarket(TICKER_80K, 2)]) as never, makeMonitor(BRTI_STATE) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      expect(m.isInTradingWindow).toBe(false);
    });
  });

  describe('threshold parsing', () => {
    it('parses threshold from ticker', async () => {
      const svc = new MarketService(makeClient([makeRawMarket(TICKER_80K, 120)]) as never, makeMonitor(BRTI_STATE) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      expect(m.threshold).toBe(80000);
    });

    it('returns threshold 0 when floor_strike is absent', async () => {
      const svc = new MarketService(makeClient([makeRawMarket('UNKNOWN', 120, 0)]) as never, makeMonitor(BRTI_STATE) as never);
      const markets = await svc.getAllLiveBtcMarkets();
      // Markets with 0 threshold still parse (they just use market mid for prob)
      expect(markets[0].threshold).toBe(0);
    });
  });

  describe('win probability', () => {
    it('computes blended probability when BRTI state is available', async () => {
      // BRTI $80400, threshold $80000 → +0.5% up with 120s left → high model prob
      const svc = new MarketService(makeClient([makeRawMarket(TICKER_80K, 120)]) as never, makeMonitor(BRTI_STATE) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      expect(m.winProbability).toBeGreaterThan(0.9);
    });

    it('falls back to market mid when BRTI state unavailable', async () => {
      const svc = new MarketService(makeClient([makeRawMarket(TICKER_80K, 120)]) as never, makeMonitor(null) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      // Mid of 0.92 + 0.94 = 0.93
      expect(m.winProbability).toBeCloseTo(0.93, 2);
    });
  });

  describe('settlement samples', () => {
    it('starts with empty settlement samples', async () => {
      const svc = new MarketService(makeClient([makeRawMarket(TICKER_80K, 120)]) as never, makeMonitor(BRTI_STATE) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      expect(m.settlementSamples).toHaveLength(0);
    });

    it('accumulates samples when secondsLeft <= 60', async () => {
      const monitor = makeMonitor(BRTI_STATE);
      const svc = new MarketService(makeClient([makeRawMarket(TICKER_80K, 120)]) as never, monitor as never);
      await svc.getAllLiveBtcMarkets();

      // Simulate secondsLeft dropping into settlement window
      const market = svc.getCachedMarkets()[0];
      // Manually adjust closeTime to put market in settlement window
      (svc as never as { cache: Map<string, unknown> }).cache.set(market.ticker, {
        ...market,
        closeTime: new Date(Date.now() + 45_000), // 45s left — in settlement window
      });

      await svc.refreshBtcStates();
      const updated = svc.getCachedMarkets()[0];
      expect(updated.settlementSamples).toHaveLength(1);
      expect(updated.settlementSamples[0]).toBeCloseTo(BRTI_STATE.currentPrice);
    });
  });

  describe('cache management', () => {
    it('caches markets and returns them via getCachedMarkets', async () => {
      const svc = new MarketService(makeClient([makeRawMarket(TICKER_80K, 120)]) as never, makeMonitor(BRTI_STATE) as never);
      await svc.getAllLiveBtcMarkets();
      expect(svc.getCachedMarkets()).toHaveLength(1);
    });

    it('getCachedTradingWindowMarkets filters to in-window markets only', async () => {
      const inTicker  = `KXBTC15M-26APR11-T80000`;
      const outTicker = `KXBTC15M-26APR11-T81000`;
      const svc = new MarketService(makeClient([
        makeRawMarket(inTicker,  30),
        makeRawMarket(outTicker, TRADING_WINDOW_MAX_SECONDS + 60),
      ]) as never, makeMonitor(BRTI_STATE) as never);
      await svc.getAllLiveBtcMarkets();
      const wm = svc.getCachedTradingWindowMarkets();
      expect(wm).toHaveLength(1);
      expect(wm[0].ticker).toBe(inTicker);
    });

    it('discoverMarkets removes tickers that disappear', async () => {
      const client = makeClient([makeRawMarket(TICKER_80K, 120)]);
      const svc    = new MarketService(client as never, makeMonitor(BRTI_STATE) as never);
      await svc.getAllLiveBtcMarkets();

      (client.getMarkets as jest.Mock).mockResolvedValue({ markets: [], cursor: '' });
      const { removedTickers } = await svc.discoverMarkets();
      expect(removedTickers).toContain(TICKER_80K);
    });

    it('discoverMarkets reports new tickers', async () => {
      const client = makeClient([]);
      const svc    = new MarketService(client as never, makeMonitor(BRTI_STATE) as never);
      await svc.getAllLiveBtcMarkets();

      (client.getMarkets as jest.Mock).mockResolvedValue({ markets: [makeRawMarket(TICKER_80K, 120)], cursor: '' });
      const { newTickers } = await svc.discoverMarkets();
      expect(newTickers).toContain(TICKER_80K);
    });
  });

  describe('applyTickerUpdate', () => {
    it('updates bid/ask from WS ticker message', async () => {
      const svc = new MarketService(makeClient([makeRawMarket(TICKER_80K, 120)]) as never, makeMonitor(BRTI_STATE) as never);
      await svc.getAllLiveBtcMarkets();

      const updated = svc.applyTickerUpdate({
        type: 'ticker', market_ticker: TICKER_80K, yes_bid_dollars: '0.96', yes_ask_dollars: '0.97',
      } as never);
      expect(updated).not.toBeNull();
      expect(updated!.yesBid).toBeCloseTo(0.96);
      expect(updated!.yesAsk).toBeCloseTo(0.97);
    });

    it('returns null for unknown ticker', () => {
      const svc = new MarketService(makeClient([]) as never, makeMonitor() as never);
      expect(svc.applyTickerUpdate({ type: 'ticker', market_ticker: 'UNKNOWN' } as never)).toBeNull();
    });
  });
});
