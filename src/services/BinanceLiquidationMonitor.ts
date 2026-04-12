/**
 * Connects to the Binance BTCUSDT perpetual futures forced-liquidation stream
 * and detects liquidation cascades.
 *
 * WebSocket: wss://fstream.binance.com/ws/btcusdt@forceOrder
 * No authentication required — Binance exposes this stream publicly.
 *
 * Each message is a forced order (FILLED liquidation):
 *   S="SELL" → long position was liquidated (price falls)
 *   S="BUY"  → short position was liquidated (price rises)
 *
 * A "liquidation cascade" is declared when total USD liquidated across all
 * sides exceeds CASCADE_THRESHOLD_USD within the last ROLLING_WINDOW_MS.
 *
 * During cascades the trading agent should:
 *  - Block new entries (spreads are wide, fills are poor)
 *  - Skip soft-zone exits (let hard stop / emergency exit handle extreme moves)
 */

import WebSocket from 'ws';

const BTCUSDT_LIQ_WS         = 'wss://fstream.binance.com/ws/btcusdt@forceOrder';
const ROLLING_WINDOW_MS      = 10_000;   // 10-second rolling window
const CASCADE_THRESHOLD_USD  = 500_000;  // $500K in 10s → cascade
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface LiquidationState {
  /** Total USD value of all liquidations in the last 10 seconds. */
  recentVolumeUsd:  number;
  /** USD value of long liquidations (SELL-side forced orders). */
  longVolumeUsd:    number;
  /** USD value of short liquidations (BUY-side forced orders). */
  shortVolumeUsd:   number;
  /** True when recentVolumeUsd ≥ CASCADE_THRESHOLD_USD. */
  isCascade:        boolean;
  /** Timestamp of the most recent liquidation event, or null if none. */
  lastEventTime:    Date | null;
}

interface LiqEvent {
  timestampMs: number;
  side:        'long' | 'short';
  volumeUsd:   number;
}

export class BinanceLiquidationMonitor {
  private ws:             WebSocket | null = null;
  private events:         LiqEvent[]       = [];
  private running                          = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay                   = 1_000;

  /** Begin listening for liquidation events. */
  start(): void {
    this.running = true;
    this.connect();
  }

  /** Stop listening and cancel all timers. */
  stop(): void {
    this.running = false;
    if (this.reconnectTimer)   { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.removeAllListeners(); this.ws.close(); this.ws = null; }
  }

  /** Returns the liquidation activity for the most recent 10-second rolling window. */
  getLiquidationState(): LiquidationState {
    this.pruneOldEvents();
    const longVol  = this.events.filter((e) => e.side === 'long').reduce((s, e)  => s + e.volumeUsd, 0);
    const shortVol = this.events.filter((e) => e.side === 'short').reduce((s, e) => s + e.volumeUsd, 0);
    const total    = longVol + shortVol;
    const lastTs   = this.events.length ? this.events[this.events.length - 1].timestampMs : null;
    return {
      recentVolumeUsd:  total,
      longVolumeUsd:    longVol,
      shortVolumeUsd:   shortVol,
      isCascade:        total >= CASCADE_THRESHOLD_USD,
      lastEventTime:    lastTs !== null ? new Date(lastTs) : null,
    };
  }

  /** Convenience shortcut — returns true when in a cascade. */
  isLiquidationCascade(): boolean {
    return this.getLiquidationState().isCascade;
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  private pruneOldEvents(): void {
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    this.events  = this.events.filter((e) => e.timestampMs >= cutoff);
  }

  private connect(): void {
    const ws = new WebSocket(BTCUSDT_LIQ_WS);
    this.ws  = ws;

    ws.on('open', () => {
      this.reconnectDelay = 1_000;
      console.log('[LiqMonitor] Connected to Binance BTCUSDT liquidation feed');
    });

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          e: string;
          o: { S: string; q: string; ap: string; p: string; X: string; T: number };
        };
        if (msg.e !== 'forceOrder' || msg.o.X !== 'FILLED') return;

        const qty       = parseFloat(msg.o.q);
        const price     = parseFloat(msg.o.ap || msg.o.p);
        const event: LiqEvent = {
          timestampMs: msg.o.T,
          side:        msg.o.S === 'SELL' ? 'long' : 'short',
          volumeUsd:   qty * price,
        };
        this.events.push(event);
        this.pruneOldEvents();

        const state = this.getLiquidationState();
        if (state.isCascade) {
          console.log(
            `[LiqMonitor] CASCADE: $${(state.recentVolumeUsd / 1_000_000).toFixed(2)}M liquidated in 10s` +
            ` (long=$${(state.longVolumeUsd / 1_000_000).toFixed(2)}M` +
            ` short=$${(state.shortVolumeUsd / 1_000_000).toFixed(2)}M)`,
          );
        }
      } catch { /* ignore malformed frames */ }
    });

    ws.on('close', () => {
      if (!this.running) return;
      const delay        = this.reconnectDelay;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      console.warn(`[LiqMonitor] Disconnected — reconnecting in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    });

    ws.on('error', (err: Error) => {
      console.warn('[LiqMonitor] WS error:', err.message);
    });
  }
}
