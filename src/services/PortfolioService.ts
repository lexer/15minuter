import { KalshiClient } from '../api/KalshiClient';
import { KalshiPosition, KalshiOpenOrder } from '../api/types';

export interface Position {
  ticker: string;
  contracts: number;
  marketExposureDollars: number;
  realizedPnlDollars: number;
}

export interface Portfolio {
  availableBalance: number;
  positions: Position[];
}

export class PortfolioService {
  constructor(private readonly client: KalshiClient) {}

  async getBalance(): Promise<number> {
    const resp = await this.client.getBalance();
    return resp.balance; // in cents
  }

  async getPortfolio(): Promise<Portfolio> {
    const [balanceResp, posResp] = await Promise.all([
      this.client.getBalance(),
      this.client.getPositions({ limit: 100 }),
    ]);
    return {
      availableBalance: balanceResp.balance,
      positions: posResp.market_positions
        .filter((p) => this.parseContracts(p) > 0)
        .map((p) => this.parsePosition(p)),
    };
  }

  async getPosition(ticker: string): Promise<Position | null> {
    const resp = await this.client.getPositions({ ticker, limit: 1 });
    const p = resp.market_positions[0];
    if (!p || this.parseContracts(p) === 0) return null;
    return this.parsePosition(p);
  }

  async getOpenOrders(): Promise<KalshiOpenOrder[]> {
    const resp = await this.client.getOpenOrders({ limit: 100 });
    return resp.orders;
  }

  isBudgetExhausted(currentBalanceCents: number): boolean {
    return currentBalanceCents <= 0;
  }

  private parseContracts(p: KalshiPosition): number {
    if (p.position_fp !== undefined) return parseFloat(p.position_fp);
    return (p.yes_position ?? 0) - (p.no_position ?? 0);
  }

  private parsePosition(p: KalshiPosition): Position {
    return {
      ticker: p.ticker,
      contracts: this.parseContracts(p),
      marketExposureDollars: p.market_exposure_dollars
        ? parseFloat(p.market_exposure_dollars)
        : (p.market_exposure ?? 0) / 100,
      realizedPnlDollars: p.realized_pnl_dollars
        ? parseFloat(p.realized_pnl_dollars)
        : (p.realized_pnl ?? 0) / 100,
    };
  }
}
