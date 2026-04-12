// Polls Binance for BTC/USDT 15-minute candle data to track window open price.

const BINANCE_KLINE_URL =
  'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=1';
const BINANCE_PRICE_URL =
  'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';

export interface BtcMarketState {
  currentPrice: number;        // latest BTC/USDT spot price
  windowOpenPrice: number;     // BTC price at start of current 15-min candle
  priceChangeFraction: number; // (currentPrice - windowOpenPrice) / windowOpenPrice
  windowStartTime: Date;       // when the current 15-min candle opened
  windowCloseTime: Date;       // when the current 15-min candle closes
  lastUpdated: Date;
}

interface BinancePriceTicker {
  symbol: string;
  price: string;
}

export class BtcPriceMonitor {
  private cache: BtcMarketState | null = null;
  private lastFetch = 0;
  private readonly cacheTtlMs = 5_000;

  async getBtcState(): Promise<BtcMarketState | null> {
    const now = Date.now();
    if (this.cache && now - this.lastFetch < this.cacheTtlMs) {
      return this.cache;
    }

    try {
      const [klineResp, priceResp] = await Promise.all([
        fetch(BINANCE_KLINE_URL),
        fetch(BINANCE_PRICE_URL),
      ]);

      if (!klineResp.ok || !priceResp.ok) {
        console.warn(
          `[BtcPriceMonitor] Binance error: kline=${klineResp.status} price=${priceResp.status}`,
        );
        return this.cache;
      }

      const klines = (await klineResp.json()) as Array<Array<string | number>>;
      const priceTicker = (await priceResp.json()) as BinancePriceTicker;

      if (!klines.length) {
        console.warn('[BtcPriceMonitor] Empty klines response');
        return this.cache;
      }

      const kline = klines[0];
      const windowOpenPrice = parseFloat(kline[1] as string);
      const currentPrice = parseFloat(priceTicker.price);
      const priceChangeFraction = (currentPrice - windowOpenPrice) / windowOpenPrice;

      this.cache = {
        currentPrice,
        windowOpenPrice,
        priceChangeFraction,
        windowStartTime: new Date(kline[0] as number),
        windowCloseTime: new Date((kline[6] as number) + 1), // +1ms: candle closeTime is inclusive
        lastUpdated: new Date(),
      };
      this.lastFetch = now;
    } catch (err) {
      console.warn('[BtcPriceMonitor] Failed to fetch BTC data:', err);
    }

    return this.cache;
  }
}
