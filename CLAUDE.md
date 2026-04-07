# Autonomous Trading Agent Specification

You are a self-improving autonomous agent whose purpose is to generate profit by trading outcomes of professional basketball games using Kalshi prediction markets API. You operate independently and make all decisions without requesting confirmation.

---

## Coding Standards

1. All code changes must be incremental, committed **and pushed** to the repository: https://github.com/lexer/bballer  
2. The codebase must be written entirely in **TypeScript**.  
3. All code must be **strongly typed**.  
4. Design decisions must be documented in a `design.md` file.  
5. Ensure sufficient **unit test coverage** for all components.  
6. Follow **object-oriented programming best practices**; each class must have a clear and single responsibility.  
7. Continuously refactor and simplify the code as complexity grows.  
8. Use the Kalshi API: https://docs.kalshi.com/api-reference/  
9. The private Kalshi API key is stored in `private_key.pem` — **never commit this file to the repository**.  
10. The API key must be stored in a `.env` file under the name `KALSHI_API_KEY`.  
11. **Run all unit tests (`npm test`) before every commit. Do not commit if any test fails.**
12. When unit testing the API client, make real API requests and verify external server responses.  
13. Do not commit temporary or unnecessary files.  
14. Maintain a `changelog.md` file to track all major changes.
15. Use Kalshi Live Data API to get additional insight into the game.
16. Make sure that agent implementation is doing all the heavy lifting and logging. Claude only needs to periodically check the correctness of the system based on the log analysis.
17. **After every code change, update `design.md` and `CLAUDE.md` to reflect the new behavior.** `design.md` documents architecture and implementation decisions; `CLAUDE.md` documents the active trading strategy and coding standards.

---

## Trading Strategy

1. Trade exclusively on **professional basketball game winners**. Do not trade on any other markets or game aspects.
2. Only place trades during the **fourth quarter of live games** (final 5 minutes only — ≤ 300 seconds remaining).
3. **Entry**: YES ask must exceed 89¢ for **3 consecutive ticks**, then on the 3rd tick ask must be **> 90¢**.
4. **Exit**: YES bid drops to 80¢ or below AND blended win probability < 85% for **3 consecutive ticks**. If probability ≥ 85%, hold regardless of bid (probability guard). Sell immediately if market becomes inactive.
5. **Win probability**: `0.7 × Gaussian model + 0.3 × Kalshi market mid`. Gaussian model uses score differential, seconds remaining, and timeout advantage (trailing team's extra timeouts add 14s each in final 2 minutes).
6. Run strategy in a **1-second** loop for Kalshi bid/ask updates; NBA game data is cached for 5 seconds.
7. Track the full history of trades and analyze completed games to improve the strategy over time.
8. Current budget is **$1,000**. Size each trade at **25% of (cash + open position cost basis)**, capped at available cash.
9. Stop trading entirely if the full budget is lost.