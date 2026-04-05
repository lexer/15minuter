import { KalshiClient } from '../api/KalshiClient';

export interface Position {
  ticker: string;
  yesContracts: number;
  noContracts: number;
  marketExposure: number;
  realizedPnl: number;
}

export interface Portfolio {
  availableBalance: number;
  allocatedBudget: number;
  positions: Position[];
}

const INITIAL_BUDGET = 500_00; // $500 in cents

export class PortfolioService {
  private spentCents = 0;

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

    const positions: Position[] = posResp.market_positions.map((p) => ({
      ticker: p.ticker,
      yesContracts: p.yes_position,
      noContracts: p.no_position,
      marketExposure: p.market_exposure,
      realizedPnl: p.realized_pnl,
    }));

    return {
      availableBalance: balanceResp.balance,
      allocatedBudget: INITIAL_BUDGET,
      positions,
    };
  }

  async getPosition(ticker: string): Promise<Position | null> {
    const resp = await this.client.getPositions({ ticker, limit: 1 });
    const p = resp.market_positions[0];
    if (!p) return null;
    return {
      ticker: p.ticker,
      yesContracts: p.yes_position,
      noContracts: p.no_position,
      marketExposure: p.market_exposure,
      realizedPnl: p.realized_pnl,
    };
  }

  isBudgetExhausted(currentBalanceCents: number): boolean {
    return currentBalanceCents <= 0;
  }

  hasEnoughBalance(balanceCents: number, costCents: number): boolean {
    return balanceCents >= costCents;
  }
}
