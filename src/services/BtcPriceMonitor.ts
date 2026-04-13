/**
 * Connects to the CF Benchmarks BRTI WebSocket feed for real-time BTC price.
 *
 * BRTI (Bitcoin Real-Time Index) is the official settlement price source for
 * Kalshi KXBTC15M markets. It is calculated every second from multiple
 * constituent exchanges (Coinbase, Bitstamp, Kraken, etc.).
 *
 * WebSocket: wss://www.cfbenchmarks.com/ws/v4
 * Subscribe:  { type: 'subscribe', id: 'BRTI', stream: 'value' }
 * Response:   { type: 'value', id: 'BRTI', value: '71580.41', time: <epoch_ms> }
 *
 * Credentials are scraped from the CF Benchmarks BRTI page and refreshed
 * every 15 minutes since they are embedded in the Next.js page build.
 */

import WebSocket from 'ws';
import { BtcMomentumIndicators, MomentumState } from './BtcMomentumIndicators';

const BRTI_WS_URL         = 'wss://www.cfbenchmarks.com/ws/v4';
const BRTI_PAGE_DATA_URL  = 'https://www.cfbenchmarks.com/_next/data/{BUILD_ID}/data/indices/BRTI.json';
const BRTI_PAGE_URL       = 'https://www.cfbenchmarks.com/data/indices/BRTI';

const MAX_RECONNECT_DELAY_MS = 30_000;
const CREDENTIAL_REFRESH_MS  = 15 * 60 * 1_000; // 15 minutes
const PRICE_HISTORY_MAX_MS   = 20 * 60 * 1_000; // keep 20 min of BRTI ticks
// If no BRTI value arrives within 30s of connecting, the subscription silently
// failed (e.g. stale credentials accepted the TCP handshake but not the feed).
// Force a credential refresh + reconnect to recover.
const DATA_WATCHDOG_MS       = 30_000;

export interface BrtiState {
  currentPrice: number;
  lastUpdated:  Date;
  /** Momentum indicators computed from the last 30+ ticks. Null until enough data. */
  momentum:     MomentumState | null;
}

interface BrtiValueMessage {
  type: 'value';
  id: string;
  value: string;
  time: number;
}

interface BrtiCredentials {
  wsApiKeyId:       string;
  wsApiKeyPassword: string;
}

export class BtcPriceMonitor {
  private latestPrice:    number | null        = null;
  private latestTime:     Date | null          = null;
  private latestMomentum: MomentumState | null = null;
  private readonly indicators = new BtcMomentumIndicators();
  /** Rolling buffer of timestamped BRTI prices — last 20 minutes. Cleared on WS reconnect. */
  private readonly priceHistory: Array<{ price: number; ts: number }> = [];
  private ws:               WebSocket | null = null;
  private reconnectTimer:   ReturnType<typeof setTimeout>  | null = null;
  private credRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private dataWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1_000;
  private running = false;
  private credentials: BrtiCredentials | null = null;

  /** Fetch credentials and connect to the BRTI WebSocket. */
  async start(): Promise<void> {
    this.running = true;
    // refreshCredentials() calls reconnect() → connect() internally when creds arrive
    await this.refreshCredentials();
    // Refresh credentials periodically so the WS key stays valid
    this.credRefreshTimer = setInterval(
      () => void this.refreshCredentials(),
      CREDENTIAL_REFRESH_MS,
    );
  }

  /** Disconnect and cancel all timers. */
  stop(): void {
    this.running = false;
    if (this.reconnectTimer)    { clearTimeout(this.reconnectTimer);    this.reconnectTimer    = null; }
    if (this.credRefreshTimer)  { clearInterval(this.credRefreshTimer); this.credRefreshTimer  = null; }
    if (this.dataWatchdogTimer) { clearTimeout(this.dataWatchdogTimer); this.dataWatchdogTimer = null; }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Returns the latest BRTI price received from the WebSocket.
   * Returns null if no price has been received yet, or after a disconnect —
   * callers should not trade until a valid BRTI price is available.
   */
  async getBtcState(): Promise<BrtiState | null> {
    if (this.latestPrice !== null && this.latestTime !== null) {
      return {
        currentPrice: this.latestPrice,
        lastUpdated:  this.latestTime,
        momentum:     this.latestMomentum,
      };
    }
    return null;
  }

  /**
   * Returns BRTI prices recorded at or after sinceMs (epoch ms).
   * Used by MarketService to get per-interval price history for realized-vol estimation.
   * Prices from before the last WS reconnect are not included (cleared on reconnect).
   */
  getIntervalPrices(sinceMs: number): number[] {
    const out: number[] = [];
    for (const entry of this.priceHistory) {
      if (entry.ts >= sinceMs) out.push(entry.price);
    }
    return out;
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /**
   * Scrapes ws credentials from the CF Benchmarks BRTI Next.js page.
   * The page embeds wsApiKeyId + wsApiKeyPassword in its server-side props.
   *
   * @param forceReconnect — if true, reconnect even if credentials haven't changed.
   *   Used by the data watchdog when the connection is alive but delivering no data.
   */
  private async refreshCredentials(forceReconnect = false): Promise<void> {
    try {
      // Step 1: get the current Next.js buildId from the HTML page
      const htmlResp = await fetch(BRTI_PAGE_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!htmlResp.ok) throw new Error(`Page fetch ${htmlResp.status}`);
      const html    = await htmlResp.text();
      const buildId = /"buildId":"([^"]+)"/.exec(html)?.[1];
      if (!buildId) throw new Error('buildId not found in page');

      // Step 2: fetch page props JSON which contains the WS credentials
      const dataUrl  = BRTI_PAGE_DATA_URL.replace('{BUILD_ID}', buildId);
      const dataResp = await fetch(dataUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!dataResp.ok) throw new Error(`Data fetch ${dataResp.status}`);
      const data = await dataResp.json() as {
        pageProps: { wsApiKeyId: string; wsApiKeyPassword: string };
      };

      const { wsApiKeyId, wsApiKeyPassword } = data.pageProps;
      if (!wsApiKeyId || !wsApiKeyPassword) throw new Error('Credentials missing from page props');

      const changed = !this.credentials ||
        this.credentials.wsApiKeyId !== wsApiKeyId ||
        this.credentials.wsApiKeyPassword !== wsApiKeyPassword;

      this.credentials = { wsApiKeyId, wsApiKeyPassword };

      if (changed || forceReconnect) {
        console.log('[BrtiMonitor] Credentials refreshed — reconnecting');
        this.reconnect();
      }
    } catch (err) {
      console.warn('[BrtiMonitor] Failed to refresh credentials:', (err as Error).message);
    }
  }

  private reconnect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearDataWatchdog();
    // Reset momentum and price history — stale data from before disconnection is unreliable
    this.indicators.reset();
    this.latestMomentum = null;
    this.priceHistory.length = 0;
    if (this.running) this.connect();
  }

  private connect(): void {
    if (!this.credentials) {
      console.warn('[BrtiMonitor] No credentials available — cannot connect');
      return;
    }

    const { wsApiKeyId, wsApiKeyPassword } = this.credentials;
    const creds = Buffer.from(`${wsApiKeyId}:${wsApiKeyPassword}`).toString('base64');
    const ws = new WebSocket(BRTI_WS_URL, {
      headers: { Authorization: `Basic ${creds}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelay = 1_000;
      ws.send(JSON.stringify({ type: 'subscribe', id: 'BRTI', stream: 'value' }));
      console.log('[BrtiMonitor] Connected — subscribed to BRTI value stream');
      // Start data watchdog: if no BRTI value arrives within 30s the subscription
      // silently failed (stale credentials accepted TCP but not the data feed).
      // Force a credential refresh + reconnect to recover.
      this.startDataWatchdog();
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as BrtiValueMessage;
        if (msg.type === 'value' && msg.id === 'BRTI' && msg.value) {
          const price          = parseFloat(msg.value);
          this.latestPrice     = price;
          this.latestTime      = new Date(msg.time);
          this.latestMomentum  = this.indicators.update(price);
          // Reset the data watchdog — we got live data, connection is healthy
          this.resetDataWatchdog();
          // Append to rolling history and prune entries older than 20 minutes
          this.priceHistory.push({ price, ts: msg.time });
          const cutoff = msg.time - PRICE_HISTORY_MAX_MS;
          while (this.priceHistory.length > 0 && this.priceHistory[0].ts < cutoff) {
            this.priceHistory.shift();
          }
        }
      } catch { /* ignore malformed frames */ }
    });

    ws.on('close', () => {
      if (!this.running) return;
      this.clearDataWatchdog();
      // Null out cached price so getBtcState() returns null while disconnected.
      // This prevents the agent from trading on stale price data.
      this.latestPrice    = null;
      this.latestTime     = null;
      this.latestMomentum = null;
      // Clear price history on disconnect — gaps in the feed make log-returns unreliable
      this.priceHistory.length = 0;
      this.indicators.reset();
      const delay = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      console.warn(`[BrtiMonitor] Disconnected — reconnecting in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    });

    ws.on('error', (err: Error) => {
      console.warn('[BrtiMonitor] WS error:', err.message);
    });
  }

  // ── Data watchdog ─────────────────────────────────────────────────────────────

  private startDataWatchdog(): void {
    this.clearDataWatchdog();
    this.dataWatchdogTimer = setTimeout(() => {
      this.dataWatchdogTimer = null;
      console.error(
        `[BrtiMonitor] Data watchdog: no BRTI data for ${DATA_WATCHDOG_MS / 1000}s after connect` +
        ' — forcing credential refresh and reconnect',
      );
      void this.refreshCredentials(true);
    }, DATA_WATCHDOG_MS);
  }

  private resetDataWatchdog(): void {
    if (this.dataWatchdogTimer) {
      clearTimeout(this.dataWatchdogTimer);
      this.startDataWatchdog();
    }
  }

  private clearDataWatchdog(): void {
    if (this.dataWatchdogTimer) {
      clearTimeout(this.dataWatchdogTimer);
      this.dataWatchdogTimer = null;
    }
  }
}
