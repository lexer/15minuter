import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  KalshiMarketsResponse,
  KalshiEventsResponse,
  KalshiOrderResponse,
  KalshiPositionsResponse,
  KalshiBalance,
  KalshiOrderBook,
  KalshiTradesResponse,
  PlaceOrderRequest,
  KalshiMarket,
} from './types';

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const API_PATH_PREFIX = '/trade-api/v2';

export class KalshiClient {
  private readonly keyId: string;
  private readonly privateKey: crypto.KeyObject;

  constructor(keyId: string, privateKeyPath: string) {
    this.keyId = keyId;
    const keyPem = fs.readFileSync(path.resolve(privateKeyPath), 'utf-8');
    this.privateKey = crypto.createPrivateKey(keyPem);
  }

  private sign(timestamp: number, method: string, path: string): string {
    const message = `${timestamp}${method.toUpperCase()}${path}`;
    const signature = crypto.sign('sha256', Buffer.from(message), {
      key: this.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    return signature.toString('base64');
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<T> {
    const timestamp = Date.now();
    // Kalshi requires signing the full path including version prefix, without query string
    const endpointPath = endpoint.split('?')[0];
    const signature = this.sign(timestamp, method, `${API_PATH_PREFIX}${endpointPath}`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'KALSHI-ACCESS-KEY': this.keyId,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'KALSHI-ACCESS-TIMESTAMP': timestamp.toString(),
    };

    const options: RequestInit = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    };

    const response = await fetch(`${BASE_URL}${endpoint}`, options);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Kalshi API error ${response.status} on ${method} ${endpoint}: ${text}`,
      );
    }

    return response.json() as Promise<T>;
  }

  async getBalance(): Promise<KalshiBalance> {
    return this.request<KalshiBalance>('GET', '/portfolio/balance');
  }

  async getMarkets(params?: {
    event_ticker?: string;
    series_ticker?: string;
    status?: string;
    limit?: number;
    cursor?: string;
    min_close_ts?: number;
    max_close_ts?: number;
  }): Promise<KalshiMarketsResponse> {
    const qs = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) qs.set(k, String(v));
      });
    }
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.request<KalshiMarketsResponse>('GET', `/markets${query}`);
  }

  async getMarket(ticker: string): Promise<{ market: KalshiMarket }> {
    return this.request<{ market: KalshiMarket }>('GET', `/markets/${ticker}`);
  }

  async getEvents(params?: {
    series_ticker?: string;
    status?: string;
    limit?: number;
    cursor?: string;
    with_nested_markets?: boolean;
  }): Promise<KalshiEventsResponse> {
    const qs = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) qs.set(k, String(v));
      });
    }
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.request<KalshiEventsResponse>('GET', `/events${query}`);
  }

  async getOrderBook(ticker: string): Promise<KalshiOrderBook> {
    return this.request<KalshiOrderBook>(
      'GET',
      `/markets/${ticker}/orderbook`,
    );
  }

  async getMarketTrades(ticker: string, limit = 20): Promise<KalshiTradesResponse> {
    return this.request<KalshiTradesResponse>(
      'GET',
      `/markets/${ticker}/trades?limit=${limit}`,
    );
  }

  async placeOrder(order: PlaceOrderRequest): Promise<KalshiOrderResponse> {
    return this.request<KalshiOrderResponse>('POST', '/portfolio/orders', order);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/portfolio/orders/${orderId}`);
  }

  async getPositions(params?: {
    ticker?: string;
    event_ticker?: string;
    limit?: number;
    cursor?: string;
  }): Promise<KalshiPositionsResponse> {
    const qs = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) qs.set(k, String(v));
      });
    }
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.request<KalshiPositionsResponse>(
      'GET',
      `/portfolio/positions${query}`,
    );
  }

  async getFilledOrders(params?: {
    ticker?: string;
    limit?: number;
    cursor?: string;
    min_ts?: number;
    max_ts?: number;
  }): Promise<KalshiTradesResponse> {
    const qs = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) qs.set(k, String(v));
      });
    }
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.request<KalshiTradesResponse>(
      'GET',
      `/portfolio/fills${query}`,
    );
  }
}
