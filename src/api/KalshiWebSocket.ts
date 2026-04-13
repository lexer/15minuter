import WebSocket from 'ws';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

// ── Endpoint ──────────────────────────────────────────────────────────────────
const WS_URL  = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const WS_PATH = '/trade-api/ws/v2';

const INITIAL_RECONNECT_MS = 200;     // reconnect fast; exponential backoff after
const MAX_RECONNECT_MS     = 30_000;
// Kalshi sends server pings every 10s. If we receive neither a server ping, a pong
// reply to our keepalive, nor any application message for 30s, the connection is dead.
const WATCHDOG_MS          = 30_000;
// Send client-side ping every 10s — matches Kalshi's own heartbeat interval.
// This ensures we detect dead connections quickly even when no market data is flowing.
const KEEPALIVE_MS         = 10_000;
// If no pong is received within this window after a client ping, the connection is
// silently dead (e.g. TCP half-open). Terminate immediately instead of waiting for
// the full watchdog timeout.
const PONG_TIMEOUT_MS      = 15_000;
// Maximum retries on 401 during WS handshake before falling back to backoff.
// 401 can be caused by transient timestamp skew — a fresh signature often succeeds.
const MAX_AUTH_RETRIES     = 2;

// ── Message types ─────────────────────────────────────────────────────────────

export interface WsTickerMessage {
  market_ticker:   string;
  yes_bid_dollars: number;
  yes_ask_dollars: number;
  price_dollars:   number;
  volume_fp:       string;
  ts:              number;
}

export interface WsFillMessage {
  trade_id:          string;
  order_id:          string;
  market_ticker:     string;
  side:              'yes' | 'no';
  action:            'buy' | 'sell';
  yes_price_dollars: string;
  count_fp:          string;
  post_position_fp:  string;
  fee_cost:          string;
  ts:                number;
}

export interface WsMarketPositionMessage {
  user_id:                   string;
  market_ticker:             string;
  position_fp:               string;
  position_cost_dollars:     string;
  realized_pnl_dollars:      string;
  fees_paid_dollars:         string;
  position_fee_cost_dollars: string;
}

interface WsEnvelope {
  type: string;
  sid?: number;
  msg?: unknown;
}

// ── Typed event declarations ──────────────────────────────────────────────────

export declare interface KalshiWebSocket {
  on(event: 'ticker',          listener: (msg: WsTickerMessage)         => void): this;
  on(event: 'fill',            listener: (msg: WsFillMessage)           => void): this;
  on(event: 'market_position', listener: (msg: WsMarketPositionMessage) => void): this;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class KalshiWebSocket extends EventEmitter {
  private socket:           WebSocket | null = null;
  private reconnectDelay    = INITIAL_RECONNECT_MS;
  private watchdogTimer:    ReturnType<typeof setTimeout>  | null = null;
  private keepaliveTimer:   ReturnType<typeof setInterval> | null = null;
  private pongTimer:        ReturnType<typeof setTimeout>  | null = null;
  private readonly subscribedTickers = new Set<string>();
  private cmdId   = 1;
  private running = false;
  private authRetries = 0;

  constructor(
    private readonly keyId:       string,
    private readonly privateKey:  crypto.KeyObject,
    private readonly wsUrl:       string = WS_URL,
    private readonly watchdogMs:  number = WATCHDOG_MS,
  ) {
    super();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Open the single multiplexed WebSocket connection. */
  async connect(): Promise<void> {
    this.running = true;
    await this.openSocket();
  }

  stop(): void {
    this.running = false;
    this.clearHeartbeat();
    this.socket?.terminate();
    this.socket = null;
  }

  /** Subscribe to real-time bid/ask updates for the given market tickers. */
  subscribeToTickers(tickers: string[]): void {
    const fresh = tickers.filter((t) => !this.subscribedTickers.has(t));
    if (!fresh.length) return;
    fresh.forEach((t) => this.subscribedTickers.add(t));
    this.send({ id: this.cmdId++, cmd: 'subscribe',
      params: { channels: ['ticker'], market_tickers: fresh } });
  }

  /** Adjust subscriptions after market discovery: subscribe new, unsubscribe gone. */
  updateTickerSubscriptions(add: string[], remove: string[]): void {
    const toAdd    = add.filter((t) => !this.subscribedTickers.has(t));
    const toRemove = remove.filter((t) => this.subscribedTickers.has(t));

    toAdd.forEach((t)    => this.subscribedTickers.add(t));
    toRemove.forEach((t) => this.subscribedTickers.delete(t));

    if (toAdd.length) {
      this.send({ id: this.cmdId++, cmd: 'subscribe',
        params: { channels: ['ticker'], market_tickers: toAdd } });
    }
    if (toRemove.length) {
      this.send({ id: this.cmdId++, cmd: 'unsubscribe',
        params: { channels: ['ticker'], market_tickers: toRemove } });
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private clearHeartbeat(): void {
    if (this.watchdogTimer)  { clearTimeout(this.watchdogTimer);   this.watchdogTimer  = null; }
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.pongTimer)      { clearTimeout(this.pongTimer);       this.pongTimer      = null; }
  }

  private resetWatchdog(ws: WebSocket): void {
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      console.error(`[WS] Watchdog timeout — no activity for ${this.watchdogMs / 1000}s, forcing reconnect`);
      ws.terminate();
    }, this.watchdogMs);
  }

  private startHeartbeat(ws: WebSocket): void {
    this.resetWatchdog(ws);

    // Reset watchdog on any inbound server frame (ping or message)
    ws.on('ping', (data) => {
      console.log(`[WS] Server ping received (${data.toString()})`);
      this.resetWatchdog(ws);
    });

    // Reset watchdog on pong replies to our keepalive pings.
    // Cancel the pong timeout — the connection is alive.
    ws.on('pong', () => {
      if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
      this.resetWatchdog(ws);
    });

    // Send client-side ping every 10s — matches Kalshi's server heartbeat interval.
    // Between 15-min windows the server may not send application messages, so proactive
    // pinging is the only way to detect dead connections quickly.
    this.keepaliveTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        // Start a pong timeout: if no pong comes back within PONG_TIMEOUT_MS the
        // TCP connection is silently dead (half-open). Kill it immediately.
        if (!this.pongTimer) {
          this.pongTimer = setTimeout(() => {
            console.error(`[WS] Pong timeout — no pong received within ${PONG_TIMEOUT_MS / 1000}s, connection dead`);
            ws.terminate();
          }, PONG_TIMEOUT_MS);
        }
      }
    }, KEEPALIVE_MS);
  }

  private sign(timestamp: number): string {
    const msg = `${timestamp}GET${WS_PATH}`;
    return crypto.sign('sha256', Buffer.from(msg), {
      key: this.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
  }

  private authHeaders(): Record<string, string> {
    const ts = Date.now();
    return {
      'KALSHI-ACCESS-KEY':       this.keyId,
      'KALSHI-ACCESS-SIGNATURE': this.sign(ts),
      'KALSHI-ACCESS-TIMESTAMP': String(ts),
    };
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.wsUrl, { headers: this.authHeaders() });
      this.socket = ws;

      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      ws.once('open', () => {
        console.log('[WS] Connected');
        this.reconnectDelay = INITIAL_RECONNECT_MS;
        this.authRetries    = 0;
        this.startHeartbeat(ws);

        // Subscribe to fill and market_positions channels immediately
        ws.send(JSON.stringify({ id: this.cmdId++, cmd: 'subscribe',
          params: { channels: ['fill'] } }));
        ws.send(JSON.stringify({ id: this.cmdId++, cmd: 'subscribe',
          params: { channels: ['market_positions'] } }));

        // Re-subscribe to any previously tracked tickers
        if (this.subscribedTickers.size > 0) {
          ws.send(JSON.stringify({ id: this.cmdId++, cmd: 'subscribe',
            params: { channels: ['ticker'], market_tickers: [...this.subscribedTickers] } }));
        }

        done();
      });

      ws.on('message', (data: Buffer) => {
        this.resetWatchdog(ws);
        try {
          const env = JSON.parse(data.toString()) as WsEnvelope;
          if (!env.msg) return;
          if (env.type === 'ticker')               this.emit('ticker',          env.msg as WsTickerMessage);
          else if (env.type === 'fill')            this.emit('fill',            env.msg as WsFillMessage);
          else if (env.type === 'market_position') this.emit('market_position', env.msg as WsMarketPositionMessage);
        } catch { /* ignore malformed frames */ }
      });

      ws.on('close', (code, reason) => {
        this.clearHeartbeat();
        this.socket = null;
        console.log(`[WS] Disconnected (${code} ${reason?.toString() ?? ''})`);
        if (this.running) {
          console.log(`[WS] Reconnecting in ${this.reconnectDelay}ms...`);
          setTimeout(() => { void this.openSocket(); }, this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS);
        }
        done();
      });

      ws.on('error', (err) => {
        const is401 = err.message.includes('401');
        if (is401 && this.authRetries < MAX_AUTH_RETRIES) {
          // 401 during handshake is likely transient timestamp skew.
          // Retry immediately with a fresh signature instead of using backoff.
          this.authRetries++;
          console.warn(`[WS] 401 on handshake — retrying with fresh signature (attempt ${this.authRetries}/${MAX_AUTH_RETRIES})`);
          // The close event will fire after this error; prevent it from scheduling
          // a normal backoff reconnect by replacing the handler for this one cycle.
          ws.removeAllListeners('close');
          ws.on('close', () => {
            this.clearHeartbeat();
            this.socket = null;
            if (this.running) {
              // Small delay to let the timestamp advance, then retry
              setTimeout(() => { void this.openSocket(); }, 500);
            }
            done();
          });
        } else {
          console.error(`[WS] Error: ${err.message}`);
        }
        done();
      });
    });
  }
}
