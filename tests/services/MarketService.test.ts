import { MarketService, TRADING_WINDOW_MIN_SECONDS, TRADING_WINDOW_MAX_SECONDS } from '../../src/services/MarketService';
import { BtcPriceMonitor, BtcMarketState } from '../../src/services/BtcPriceMonitor';
import { KalshiClient } from '../../src/api/KalshiClient';

function makeClient(markets: object[]): jest.Mocked<Pick<KalshiClient, 'getMarkets'>> {
  return { getMarkets: jest.fn().mockResolvedValue({ markets, cursor: '' }) } as never;
}

function makeMonitor(state: BtcMarketState | null = null): jest.Mocked<Pick<BtcPriceMonitor, 'getBtcState'>> {
  return { getBtcState: jest.fn().mockResolvedValue(state) } as never;
}

function makeRawMarket(ticker: string, secondsFromNow: number): object {
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
    rules_primary:       '',
    rules_secondary:     '',
  };
}

const BTC_STATE: BtcMarketState = {
  currentPrice:        80400,
  windowOpenPrice:     80000,
  priceChangeFraction: 0.005,
  windowStartTime:     new Date(Date.now() - 600_000),
  windowCloseTime:     new Date(Date.now() + 300_000),
  lastUpdated:         new Date(),
};

describe('MarketService', () => {
  describe('trading window classification', () => {
    it('marks market as in window when secondsLeft is between min and max', async () => {
      const svc = new MarketService(makeClient([makeRawMarket('T1', 120)]) as never, makeMonitor(BTC_STATE) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      expect(m.isInTradingWindow).toBe(true);
      expect(m.secondsLeft).toBeGreaterThanOrEqual(TRADING_WINDOW_MIN_SECONDS);
      expect(m.secondsLeft).toBeLessThanOrEqual(TRADING_WINDOW_MAX_SECONDS);
    });

    it('marks market outside window when secondsLeft > max', async () => {
      const svc = new MarketService(makeClient([makeRawMarket('T2', TRADING_WINDOW_MAX_SECONDS + 60)]) as never, makeMonitor(BTC_STATE) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      expect(m.isInTradingWindow).toBe(false);
    });

    it('marks market outside window when secondsLeft < min', async () => {
      const svc = new MarketService(makeClient([makeRawMarket('T3', TRADING_WINDOW_MIN_SECONDS - 10)]) as never, makeMonitor(BTC_STATE) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      expect(m.isInTradingWindow).toBe(false);
    });
  });

  describe('win probability', () => {
    it('computes blended probability when BTC state is available', async () => {
      const svc = new MarketService(makeClient([makeRawMarket('T4', 120)]) as never, makeMonitor(BTC_STATE) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      // BTC up 0.5% at 120s left → high model prob → blended prob should be > 0.9
      expect(m.winProbability).toBeGreaterThan(0.9);
    });

    it('falls back to market mid when BTC state unavailable', async () => {
      const svc = new MarketService(makeClient([makeRawMarket('T5', 120)]) as never, makeMonitor(null) as never);
      const [m] = await svc.getAllLiveBtcMarkets();
      // Mid of 0.92 + 0.94 = 0.93
      expect(m.winProbability).toBeCloseTo(0.93, 2);
    });
  });

  describe('cache management', () => {
    it('caches markets and returns them via getCachedMarkets', async () => {
      const svc = new MarketService(makeClient([makeRawMarket('T6', 120)]) as never, makeMonitor(BTC_STATE) as never);
      await svc.getAllLiveBtcMarkets();
      expect(svc.getCachedMarkets()).toHaveLength(1);
    });

    it('getCachedTradingWindowMarkets filters to in-window markets only', async () => {
      const svc = new MarketService(makeClient([
        makeRawMarket('IN',  150),
        makeRawMarket('OUT', TRADING_WINDOW_MAX_SECONDS + 60),
      ]) as never, makeMonitor(BTC_STATE) as never);
      await svc.getAllLiveBtcMarkets();
      const wm = svc.getCachedTradingWindowMarkets();
      expect(wm).toHaveLength(1);
      expect(wm[0].ticker).toBe('IN');
    });

    it('discoverMarkets removes tickers that disappear', async () => {
      const client = makeClient([makeRawMarket('A', 120)]);
      const svc    = new MarketService(client as never, makeMonitor(BTC_STATE) as never);
      await svc.getAllLiveBtcMarkets();

      (client.getMarkets as jest.Mock).mockResolvedValue({ markets: [], cursor: '' });
      const { removedTickers } = await svc.discoverMarkets();
      expect(removedTickers).toContain('A');
    });

    it('discoverMarkets reports new tickers', async () => {
      const client = makeClient([]);
      const svc    = new MarketService(client as never, makeMonitor(BTC_STATE) as never);
      await svc.getAllLiveBtcMarkets();

      (client.getMarkets as jest.Mock).mockResolvedValue({ markets: [makeRawMarket('NEW', 120)], cursor: '' });
      const { newTickers } = await svc.discoverMarkets();
      expect(newTickers).toContain('NEW');
    });
  });

  describe('applyTickerUpdate', () => {
    it('updates bid/ask from WS ticker message', async () => {
      const svc = new MarketService(makeClient([makeRawMarket('WS', 120)]) as never, makeMonitor(BTC_STATE) as never);
      await svc.getAllLiveBtcMarkets();

      const updated = svc.applyTickerUpdate({
        type: 'ticker', market_ticker: 'WS', yes_bid_dollars: '0.96', yes_ask_dollars: '0.97',
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
