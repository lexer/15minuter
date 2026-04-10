import WebSocket from 'ws';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

// ── Endpoint ──────────────────────────────────────────────────────────────────
const WS_URL  = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const WS_PATH = '/trade-api/ws/v2';

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS     = 30_000;

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
  private socket:          WebSocket | null = null;
  private reconnectDelay   = INITIAL_RECONNECT_MS;
  private readonly subscribedTickers = new Set<string>();
  private cmdId   = 1;
  private running = false;

  constructor(
    private readonly keyId:      string,
    private readonly privateKey: crypto.KeyObject,
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
      const ws = new WebSocket(WS_URL, { headers: this.authHeaders() });
      this.socket = ws;

      let resolved = false;
      const done = () => { if (!resolved) { resolved = true; resolve(); } };

      ws.once('open', () => {
        console.log('[WS] Connected');
        this.reconnectDelay = INITIAL_RECONNECT_MS;

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
        try {
          const env = JSON.parse(data.toString()) as WsEnvelope;
          if (!env.msg) return;
          if (env.type === 'ticker')               this.emit('ticker',          env.msg as WsTickerMessage);
          else if (env.type === 'fill')            this.emit('fill',            env.msg as WsFillMessage);
          else if (env.type === 'market_position') this.emit('market_position', env.msg as WsMarketPositionMessage);
        } catch { /* ignore malformed frames */ }
      });

      ws.on('close', (code, reason) => {
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
        console.error(`[WS] Error: ${err.message}`);
        done();
      });
    });
  }
}
