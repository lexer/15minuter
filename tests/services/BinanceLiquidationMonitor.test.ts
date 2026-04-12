import { EventEmitter } from 'events';
import { BinanceLiquidationMonitor } from '../../src/services/BinanceLiquidationMonitor';

// ── WebSocket mock ─────────────────────────────────────────────────────────────

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

/** Emit a filled liquidation event on the mock WS. */
function emitLiquidation(
  side: 'SELL' | 'BUY',
  qty: number,
  price: number,
  timestampMs = Date.now(),
): void {
  MockWs.instance?.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        e: 'forceOrder',
        E: timestampMs,
        o: { S: side, q: String(qty), ap: String(price), p: String(price), X: 'FILLED', T: timestampMs },
      }),
    ),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BinanceLiquidationMonitor', () => {
  let monitor: BinanceLiquidationMonitor;

  beforeEach(() => {
    MockWs.instance = null;
    monitor = new BinanceLiquidationMonitor();
  });

  afterEach(() => {
    monitor.stop();
  });

  it('starts with zero volume and no cascade', () => {
    monitor.start();
    const state = monitor.getLiquidationState();
    expect(state.recentVolumeUsd).toBe(0);
    expect(state.isCascade).toBe(false);
    expect(state.lastEventTime).toBeNull();
  });

  it('tracks a long liquidation (SELL side)', () => {
    monitor.start();
    emitLiquidation('SELL', 0.5, 80000); // $40,000 long liquidation
    const state = monitor.getLiquidationState();
    expect(state.longVolumeUsd).toBeCloseTo(40_000);
    expect(state.shortVolumeUsd).toBe(0);
    expect(state.recentVolumeUsd).toBeCloseTo(40_000);
  });

  it('tracks a short liquidation (BUY side)', () => {
    monitor.start();
    emitLiquidation('BUY', 1, 80000); // $80,000 short liquidation
    const state = monitor.getLiquidationState();
    expect(state.shortVolumeUsd).toBeCloseTo(80_000);
    expect(state.longVolumeUsd).toBe(0);
  });

  it('detects a cascade when total volume exceeds $500K in 10s', () => {
    monitor.start();
    // 7 BTC at $80,000 = $560,000 > $500,000 threshold
    emitLiquidation('SELL', 7, 80_000);
    expect(monitor.isLiquidationCascade()).toBe(true);
    const state = monitor.getLiquidationState();
    expect(state.isCascade).toBe(true);
  });

  it('does not flag cascade when volume is below $500K', () => {
    monitor.start();
    // 2 BTC at $80,000 = $160,000 < $500,000
    emitLiquidation('SELL', 2, 80_000);
    expect(monitor.isLiquidationCascade()).toBe(false);
  });

  it('prunes events older than 10 seconds', () => {
    monitor.start();
    const oldTs = Date.now() - 15_000; // 15s ago — outside the 10s window
    emitLiquidation('SELL', 10, 80_000, oldTs);
    // These events are older than the rolling window; getLiquidationState() prunes them
    const state = monitor.getLiquidationState();
    expect(state.recentVolumeUsd).toBe(0);
    expect(state.isCascade).toBe(false);
  });

  it('accumulates volume from multiple events', () => {
    monitor.start();
    emitLiquidation('SELL',  1, 80_000); // $80K
    emitLiquidation('BUY',   2, 80_000); // $160K
    emitLiquidation('SELL',  3, 80_000); // $240K
    const state = monitor.getLiquidationState();
    expect(state.recentVolumeUsd).toBeCloseTo(480_000);
    expect(state.longVolumeUsd).toBeCloseTo(320_000);
    expect(state.shortVolumeUsd).toBeCloseTo(160_000);
  });

  it('ignores non-FILLED events', () => {
    monitor.start();
    MockWs.instance?.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          e: 'forceOrder',
          o: { S: 'SELL', q: '10', ap: '80000', p: '80000', X: 'NEW', T: Date.now() },
        }),
      ),
    );
    expect(monitor.getLiquidationState().recentVolumeUsd).toBe(0);
  });

  it('ignores malformed messages without throwing', () => {
    monitor.start();
    MockWs.instance?.emit('message', Buffer.from('not-json'));
    expect(monitor.getLiquidationState().recentVolumeUsd).toBe(0);
  });

  it('stop() prevents reconnection on close', () => {
    const WebSocket = require('ws').default as jest.Mock;
    WebSocket.mockClear();
    monitor.start();
    monitor.stop();
    MockWs.instance?.emit('close');
    expect(WebSocket).toHaveBeenCalledTimes(1);
  });
});
