import { KalshiClient } from '../api/KalshiClient';
import { KalshiOrderResponse, OrderAction, OrderSide, PlaceOrderRequest } from '../api/types';

export interface Order {
  orderId: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count: number;
  filledCount: number;
  remainingCount: number;
  yesPrice: number;
  status: 'resting' | 'canceled' | 'executed';
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
   * Polls until the order is executed/canceled or FILL_TIMEOUT_MS elapses.
   * Cancels any resting remainder and returns the order with actual filledCount.
   */
  private async waitForFill(orderId: string, initial: Order): Promise<Order> {
    let order = initial;
    const deadline = Date.now() + FILL_TIMEOUT_MS;

    while (order.status === 'resting' && Date.now() < deadline) {
      await sleep(FILL_POLL_INTERVAL_MS);
      const resp = await this.client.getOrder(orderId);
      order = this.parseOrder(resp);
    }

    // Cancel resting remainder if not fully executed within timeout
    if (order.status === 'resting') {
      try {
        await this.client.cancelOrder(orderId);
        const resp = await this.client.getOrder(orderId);
        order = this.parseOrder(resp);
      } catch {
        // Cancel may fail if order already settled — use last known state
      }
    }

    return order;
  }

  private parseOrder(resp: KalshiOrderResponse): Order {
    const o = resp.order;
    return {
      orderId: o.order_id,
      ticker: o.ticker,
      side: o.side,
      action: o.action,
      count: parseFloat(o.initial_count_fp ?? '0'),
      filledCount: parseFloat(o.fill_count_fp ?? '0'),
      remainingCount: parseFloat(o.remaining_count_fp ?? '0'),
      yesPrice: parseFloat(o.yes_price_dollars ?? '0'),
      status: o.status,
      placedAt: new Date(o.created_time ?? Date.now()),
    };
  }
}
