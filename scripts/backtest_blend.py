"""
Backtest market-probability blending on today's analysis log.

For each closed position, simulate exit logic with different blend weights:
  blendedProb = (1 - w) * modelProb + w * marketMid

Exit triggers when: blendedProb < EXIT_GUARD (0.85) for 3 consecutive ticks
where bid is also below EXIT_THRESHOLD (0.80).

Reports per weight: exit tick, exit price (bid at that tick), estimated PnL.
"""

import json, sys
from pathlib import Path

LOG_FILE   = Path(__file__).parent.parent / "analysis_2026-04-06.log"
EXIT_THRESHOLD  = 0.80
EXIT_GUARD      = 0.85
CONFIRM_TICKS   = 3
WEIGHTS = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5]

# Known closed trades to backtest
TRADES = {
    "KXNBAGAME-26APR06PORDEN-POR":  {"entry": 0.94, "contracts": 264, "team": "POR"},
    "KXNBAGAME-26APR06PHISAS-SAS":  {"entry": 0.91, "contracts": 265, "team": "SAS"},
    "KXNBAGAME-26APR06NYKATL-NYK":  {"entry": 0.96, "contracts": 187, "team": "NYK"},
    "KXNBAGAME-26APR06CLEMEM-CLE":  {"entry": 0.96, "contracts": 140, "team": "CLE"},
}

def extract_market(tick, ticker):
    team = ticker.split("-")[-1]
    for game in tick.get("games", []):
        for m in game.get("markets", []):
            if m["team"] == team:
                return m, game
    return None, None

def simulate(ticks_for_ticker, entry_price, contracts, weight):
    """Simulate exit logic with given blend weight. Returns (exit_time, exit_bid, pnl)."""
    low_count = 0
    for ts, market, game in ticks_for_ticker:
        model_prob = market.get("winProbability") or 0.0
        bid  = market.get("bid", 0.0)
        ask  = market.get("ask", 0.0)
        mid  = (bid + ask) / 2.0

        blended = (1 - weight) * model_prob + weight * mid

        if bid <= EXIT_THRESHOLD:
            if blended >= EXIT_GUARD:
                low_count = 0  # guard blocks, reset
                continue
            low_count += 1
            if low_count >= CONFIRM_TICKS:
                pnl = (bid - entry_price) * contracts
                return ts, bid, pnl
        else:
            low_count = 0

    return None, None, None  # held to settlement

def load_ticks():
    ticks = []
    with open(LOG_FILE) as f:
        for line in f:
            try:
                ticks.append(json.loads(line.strip()))
            except:
                pass
    return ticks

def main():
    ticks = load_ticks()
    print(f"Loaded {len(ticks):,} ticks from {LOG_FILE.name}\n")

    for ticker, trade in TRADES.items():
        entry   = trade["entry"]
        contr   = trade["contracts"]
        team    = trade["team"]
        max_pnl = (1.0 - entry) * contr  # if won at settlement

        # Collect ticks for this ticker (only while position would be open — after entry)
        ticker_ticks = []
        in_position = False
        for tick in ticks:
            m, game = extract_market(tick, ticker)
            if m is None:
                continue
            # Crude proxy: treat first tick where bid > 0.85 as position entry point
            if not in_position and m.get("bid", 0) > 0.85:
                in_position = True
            if in_position:
                ticker_ticks.append((tick["timestamp"][11:19], m, game))

        if not ticker_ticks:
            print(f"{team}: no ticks found\n")
            continue

        print(f"{'─'*60}")
        print(f"{team}  entry={entry}  contracts={contr}  max_pnl=${max_pnl:.2f}")
        print(f"{'─'*60}")
        print(f"{'weight':>8}  {'exit_time':>10}  {'exit_bid':>9}  {'pnl':>10}  {'vs_hold':>10}")

        actual_pnl = -102.96 if team == "POR" else max_pnl  # known outcomes

        for w in WEIGHTS:
            exit_ts, exit_bid, pnl = simulate(ticker_ticks, entry, contr, w)
            if exit_ts is None:
                label = "held→settlement"
                pnl_str = f"${max_pnl:.2f}"
                vs = f"${max_pnl - actual_pnl:+.2f}"
            else:
                label = exit_ts
                pnl_str = f"${pnl:.2f}"
                vs = f"${pnl - actual_pnl:+.2f}"
            print(f"  w={w:.1f}    {label:>12}  {str(round(exit_bid,2)) if exit_bid else '-':>9}  {pnl_str:>10}  {vs:>10}")
        print()

if __name__ == "__main__":
    main()
