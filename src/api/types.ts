export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;                    // returned by API despite not being in official docs
  status: 'initialized' | 'inactive' | 'active' | 'closed' | 'determined' | 'disputed' | 'amended' | 'finalized';
  // Dollar string fields (FixedPointDollars) — primary price format
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  // Legacy integer cent fields — may be present for backward compat
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  volume_fp?: string;               // FixedPointCount string
  open_interest_fp?: string;
  close_time: string;
  latest_expiration_time?: string;
  expected_expiration_time?: string;
  updated_time?: string;
  result?: string;                  // 'yes' | 'no' after settlement
  can_close_early: boolean;
  rules_primary: string;
  rules_secondary: string;
  response_price_units?: string;
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  sub_title?: string;
  mutually_exclusive: boolean;
  markets?: KalshiMarket[];
  last_updated_ts?: string;
}

export interface KalshiOrderResponse {
  order: {
    order_id: string;
    user_id: string;
    client_order_id?: string;
    ticker: string;
    status: 'resting' | 'canceled' | 'executed';
    side: OrderSide;
    action: OrderAction;
    type: string;
    yes_price_dollars: string;       // FixedPointDollars, e.g. "0.9100"
    no_price_dollars: string;
    initial_count_fp: string;        // FixedPointCount, e.g. "203.00"
    fill_count_fp: string;           // contracts filled so far
    remaining_count_fp: string;      // contracts still resting
    taker_fill_cost_dollars?: string;
    maker_fill_cost_dollars?: string;
    taker_fees_dollars?: string;
    maker_fees_dollars?: string;
    created_time: string | null;
    last_update_time: string | null;
    expiration_time: string | null;
    cancel_order_on_pause?: boolean;
  };
}

export interface KalshiPosition {
  ticker: string;
  position_fp?: string;              // net YES contracts as decimal string (primary)
  market_exposure_dollars?: string;
  fees_paid_dollars?: string;
  realized_pnl_dollars?: string;
  total_traded_dollars?: string;
  resting_orders_count?: number;     // deprecated by Kalshi
  last_updated_ts?: string;
}

export interface KalshiBalance {
  balance: number;                   // available cash in cents
  portfolio_value?: number;          // total portfolio value in cents
  updated_ts?: number;               // Unix timestamp
}

export interface KalshiOrderBook {
  orderbook_fp: {                    // NOTE: key is orderbook_fp, not orderbook
    yes_dollars: Array<[string, string]>;  // [price_dollars, count_fp]
    no_dollars: Array<[string, string]>;
  };
}

export interface KalshiTrade {
  trade_id: string;
  ticker: string;
  yes_price_dollars: string;         // FixedPointDollars
  no_price_dollars: string;
  count_fp: string;                  // FixedPointCount
  taker_side: string;
  created_time: string;
}

export interface KalshiFill {
  fill_id: string;
  trade_id: string;
  order_id: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count_fp: string;                  // FixedPointCount
  yes_price_dollars: string;
  no_price_dollars: string;
  is_taker: boolean;
  created_time: string;
  fee_cost?: string;
}

export interface KalshiOpenOrder {
  order_id: string;
  user_id?: string;
  client_order_id?: string;
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  type: string;
  status: 'resting' | 'canceled' | 'executed';
  yes_price_dollars: string;
  no_price_dollars?: string;
  initial_count_fp: string;
  fill_count_fp: string;
  remaining_count_fp: string;
  created_time: string | null;
  last_update_time?: string | null;
  expiration_time?: string | null;
  cancel_order_on_pause?: boolean;
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
  count: number;                     // integer contracts (count_fp string also accepted by API)
  type: OrderType;
  yes_price?: number;                // integer cents (1–99); yes_price_dollars string also accepted
  no_price?: number;
  expiration_ts?: number;
  buy_max_cost?: number;
  time_in_force?: 'fill_or_kill' | 'good_till_canceled' | 'immediate_or_cancel';
  post_only?: boolean;
  reduce_only?: boolean;
  client_order_id?: string;
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
  event_positions?: unknown[];       // present in API response, not used
  cursor: string;
}

export interface KalshiTradesResponse {
  trades: KalshiTrade[];
  cursor: string;
}

export interface KalshiFillsResponse {
  fills: KalshiFill[];
  cursor: string;
}
