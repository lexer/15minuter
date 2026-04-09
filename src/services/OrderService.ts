import { KalshiClient } from '../api/KalshiClient';
import { OrderAction, OrderSide, PlaceOrderRequest } from '../api/types';

export interface Order {
  orderId: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count: number;
  filledCount: number;
  yesPrice: number;
  status: string;
  placedAt: Date;
}

// Poll for fill up to this long before cancelling the resting remainder
const FILL_TIMEOUT_MS = 3_000;
const FILL_POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OrderService {
  constructor(private readonly client: KalshiClient) {}

  async buyYes(ticker: string, contracts: number, limitPrice: number): Promise<Order> {
    const req: PlaceOrderRequest = {
      ticker,
      action: 'buy',
      side: 'yes',
      count: contracts,
      type: 'limit',
      yes_price: Math.min(99, Math.max(1, Math.round(limitPrice * 100))),
    };
    const resp = await this.client.placeOrder(req);
    return this.waitForFill(resp.order.order_id, this.parseOrder(resp));
  }

  async sellYes(ticker: string, contracts: number, limitPrice: number): Promise<Order> {
    const req: PlaceOrderRequest = {
      ticker,
      action: 'sell',
      side: 'yes',
      count: contracts,
      type: 'limit',
      yes_price: Math.min(99, Math.max(1, Math.round(limitPrice * 100))),
    };
    const resp = await this.client.placeOrder(req);
    return this.waitForFill(resp.order.order_id, this.parseOrder(resp));
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId);
  }

  /**
   * Polls until the order is fully filled or FILL_TIMEOUT_MS elapses.
   * Cancels any resting remainder and returns the order with actual filledCount.
   */
  private async waitForFill(orderId: string, initial: Order): Promise<Order> {
    let order = initial;
    const deadline = Date.now() + FILL_TIMEOUT_MS;

    while (order.filledCount < order.count && Date.now() < deadline) {
      await sleep(FILL_POLL_INTERVAL_MS);
      const resp = await this.client.getOrder(orderId);
      order = this.parseOrder(resp);
    }

    // Cancel resting remainder if partially or completely unfilled
    if (order.filledCount < order.count && order.status !== 'canceled') {
      try {
        await this.client.cancelOrder(orderId);
        // Re-fetch to get final filled count after cancel
        const resp = await this.client.getOrder(orderId);
        order = this.parseOrder(resp);
      } catch {
        // Cancel may fail if order already settled — use last known state
      }
    }

    return order;
  }

  private parseOrder(resp: { order: { order_id: string; ticker: string; side: OrderSide; action: OrderAction; count: number; filled_count: number; yes_price: number; status: string; place_time: string } }): Order {
    const o = resp.order;
    return {
      orderId: o.order_id,
      ticker: o.ticker,
      side: o.side,
      action: o.action,
      count: o.count,
      filledCount: o.filled_count ?? 0,
      yesPrice: o.yes_price / 100,
      status: o.status,
      placedAt: new Date(o.place_time),
    };
  }
}
