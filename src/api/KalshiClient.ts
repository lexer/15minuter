import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  KalshiMarketsResponse,
  KalshiEventsResponse,
  KalshiOrderResponse,
  KalshiOpenOrdersResponse,
  KalshiPositionsResponse,
  KalshiBalance,
  KalshiOrderBook,
  KalshiTradesResponse,
  KalshiFillsResponse,
  PlaceOrderRequest,
  KalshiMarket,
} from './types';

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const API_PATH_PREFIX = '/trade-api/v2';

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 500; // doubles each attempt: 500ms, 1000ms, 2000ms

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    let lastError: Error = new Error('No attempts made');

    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt - 1));
      }

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

      if (response.ok) {
        return response.json() as Promise<T>;
      }

      const text = await response.text();
      lastError = new Error(`Kalshi API error ${response.status} on ${method} ${endpoint}: ${text}`);

      // Don't retry client errors except 429 (rate limit)
      if (response.status !== 429 && response.status < 500) {
        throw lastError;
      }
    }

    throw lastError;
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

  async getOrder(orderId: string): Promise<KalshiOrderResponse> {
    return this.request<KalshiOrderResponse>('GET', `/portfolio/orders/${orderId}`);
  }

  async getOpenOrders(params?: { ticker?: string; limit?: number }): Promise<KalshiOpenOrdersResponse> {
    const qs = new URLSearchParams({ status: 'resting' });
    if (params?.ticker) qs.set('ticker', params.ticker);
    if (params?.limit) qs.set('limit', String(params.limit));
    return this.request<KalshiOpenOrdersResponse>('GET', `/portfolio/orders?${qs.toString()}`);
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
  }): Promise<KalshiFillsResponse> {
    const qs = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined) qs.set(k, String(v));
      });
    }
    const query = qs.toString() ? `?${qs.toString()}` : '';
    return this.request<KalshiFillsResponse>(
      'GET',
      `/portfolio/fills${query}`,
    );
  }
}
