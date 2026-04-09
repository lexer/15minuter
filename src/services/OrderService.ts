import { KalshiClient } from '../api/KalshiClient';
import { KalshiOrderResponse, OrderAction, OrderSide, PlaceOrderRequest } from '../api/types';

export interface Order {
  orderId: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count: number;
  filledCount: number;
  yesPrice: number;
  status: 'resting' | 'canceled' | 'executed';
  placedAt: Date;
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
      time_in_force: 'immediate_or_cancel',
    };
    return this.parseOrder(await this.client.placeOrder(req));
  }

  async sellYes(ticker: string, contracts: number, limitPrice: number): Promise<Order> {
    const req: PlaceOrderRequest = {
      ticker,
      action: 'sell',
      side: 'yes',
      count: contracts,
      type: 'limit',
      yes_price: Math.min(99, Math.max(1, Math.round(limitPrice * 100))),
      time_in_force: 'immediate_or_cancel',
    };
    return this.parseOrder(await this.client.placeOrder(req));
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
      yesPrice: parseFloat(o.yes_price_dollars ?? '0'),
      status: o.status,
      placedAt: new Date(o.created_time ?? Date.now()),
    };
  }
}
