export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  status: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  open_interest: number;
  close_time: string;
  expiration_time: string;
  result?: string;
  can_close_early: boolean;
  rules_primary: string;
  rules_secondary: string;
  category: string;
  series_ticker: string;
  strike_type?: string;
  floor_strike?: number;
  cap_strike?: number;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  category: string;
  status: string;
  markets: KalshiMarket[];
  mutually_exclusive: boolean;
}

export interface KalshiOrderResponse {
  order: {
    order_id: string;
    user_id: string;
    ticker: string;
    status: string;
    yes_price: number;
    no_price: number;
    side: OrderSide;
    action: OrderAction;
    count: number;
    filled_count: number;
    remaining_count: number;
    place_time: string;
    close_time?: string;
    expiration_time?: string;
    type: string;
  };
}

export interface KalshiPosition {
  ticker: string;
  market_exposure: number;
  fees_paid: number;
  realized_pnl: number;
  resting_orders_count: number;
  total_traded: number;
  volume: number;
  yes_position: number;
  no_position: number;
}

export interface KalshiBalance {
  balance: number;
  payout: number;
  fees: number;
}

export interface KalshiOrderBook {
  orderbook: {
    yes: Array<[number, number]>;
    no: Array<[number, number]>;
  };
}

export interface KalshiTrade {
  trade_id: string;
  ticker: string;
  yes_price: number;
  no_price: number;
  count: number;
  taker_side: string;
  created_time: string;
}

export type OrderSide = 'yes' | 'no';
export type OrderAction = 'buy' | 'sell';
export type OrderType = 'limit' | 'market';

export interface PlaceOrderRequest {
  ticker: string;
  action: OrderAction;
  side: OrderSide;
  count: number;
  type: OrderType;
  yes_price?: number;
  no_price?: number;
  expiration_ts?: number;
  sell_position_floor?: number;
  buy_max_cost?: number;
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor: string;
}

export interface KalshiEventsResponse {
  events: KalshiEvent[];
  cursor: string;
}

export interface KalshiPositionsResponse {
  market_positions: KalshiPosition[];
  cursor: string;
}

export interface KalshiTradesResponse {
  trades: KalshiTrade[];
  cursor: string;
}

export interface KalshiSeriesResponse {
  series: {
    ticker: string;
    frequency: string;
    title: string;
    category: string;
  };
}

export interface KalshiLiveData {
  ticker: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
}
