import { KalshiClient } from '../api/KalshiClient';
import { OrderAction, OrderSide, PlaceOrderRequest } from '../api/types';

export interface Order {
  orderId: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count: number;
  yesPrice: number;
  status: string;
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
    };
    const resp = await this.client.placeOrder(req);
    return this.parseOrder(resp);
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
    return this.parseOrder(resp);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId);
  }

  private parseOrder(resp: { order: { order_id: string; ticker: string; side: OrderSide; action: OrderAction; count: number; yes_price: number; status: string; place_time: string } }): Order {
    const o = resp.order;
    return {
      orderId: o.order_id,
      ticker: o.ticker,
      side: o.side,
      action: o.action,
      count: o.count,
      yesPrice: o.yes_price / 100,
      status: o.status,
      placedAt: new Date(o.place_time),
    };
  }
}
