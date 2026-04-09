export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  status: string;
  // Integer cent fields (0-100 range) — may be absent in newer API responses
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  // Dollar string fields — present in KXNBAGAME series
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  volume?: number;
  volume_fp?: string;
  open_interest?: number;
  open_interest_fp?: string;
  close_time: string;
  expiration_time: string;
  expected_expiration_time?: string;
  updated_time?: string;
  result?: string;
  can_close_early: boolean;
  rules_primary: string;
  rules_secondary: string;
  category?: string;
  series_ticker?: string;
  strike_type?: string;
  floor_strike?: number;
  cap_strike?: number;
  response_price_units?: string;
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
  position_fp?: string;          // number of contracts as decimal string
  market_exposure_dollars?: string;
  fees_paid_dollars?: string;
  realized_pnl_dollars?: string;
  total_traded_dollars?: string;
  resting_orders_count: number;
  last_updated_ts?: string;
  // Legacy integer fields (may be absent)
  market_exposure?: number;
  fees_paid?: number;
  realized_pnl?: number;
  total_traded?: number;
  volume?: number;
  yes_position?: number;
  no_position?: number;
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

export interface KalshiOpenOrder {
  order_id: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count: number;
  filled_count: number;
  remaining_count: number;
  yes_price: number;
  status: string;
  place_time: string;
  type: string;
}

export interface KalshiOpenOrdersResponse {
  orders: KalshiOpenOrder[];
  cursor: string;
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
