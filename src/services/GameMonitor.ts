// NBA Live Data via the public NBA stats API

export interface NbaGameState {
  gameId: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  period: number; // 1-4 for regulation, 5+ for OT
  gameClock: string; // e.g. "PT05M23.00S" or "PT00M00.00S"
  gameStatus: 1 | 2 | 3; // 1=not started, 2=live, 3=finished
  isQ4OrLater: boolean;
  homeTeamTricode: string;
  awayTeamTricode: string;
}

interface NbaScoreboardResponse {
  scoreboard: {
    games: NbaRawGame[];
  };
}

interface NbaRawGame {
  gameId: string;
  gameStatus: number;
  period: number;
  gameClock: string;
  homeTeam: { teamTricode: string; teamName: string; score: number };
  awayTeam: { teamTricode: string; teamName: string; score: number };
}

const NBA_SCOREBOARD_URL =
  'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json';

export class GameMonitor {
  private cache: NbaGameState[] = [];
  private lastFetch = 0;
  private readonly cacheTtlMs = 5_000; // NBA CDN updates every ~5-10s

  async getLiveGames(): Promise<NbaGameState[]> {
    const now = Date.now();
    if (now - this.lastFetch < this.cacheTtlMs) {
      return this.cache;
    }

    try {
      const resp = await fetch(NBA_SCOREBOARD_URL, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bballer/1.0)' },
      });
      if (!resp.ok) {
        console.warn(`[GameMonitor] NBA scoreboard returned ${resp.status}`);
        return this.cache;
      }
      const data = (await resp.json()) as NbaScoreboardResponse;
      this.cache = data.scoreboard.games.map(this.parseGame);
      this.lastFetch = now;
    } catch (err) {
      console.warn('[GameMonitor] Failed to fetch NBA scoreboard:', err);
    }

    return this.cache;
  }

  async getGameState(
    homeTricode: string,
    awayTricode: string,
  ): Promise<NbaGameState | null> {
    const games = await this.getLiveGames();
    return (
      games.find(
        (g) =>
          (g.homeTeamTricode === homeTricode && g.awayTeamTricode === awayTricode) ||
          (g.homeTeamTricode === awayTricode && g.awayTeamTricode === homeTricode),
      ) ?? null
    );
  }

  /** Convert ISO 8601 duration e.g. "PT02M16.00S" → "2:16" */
  static formatClock(raw: string): string {
    const m = raw.match(/PT(\d+)M([\d.]+)S/);
    if (!m) return raw;
    const mins = m[1].padStart(2, '0');
    const secs = Math.floor(parseFloat(m[2])).toString().padStart(2, '0');
    return `${mins}:${secs}`;
  }

  private parseGame(g: NbaRawGame): NbaGameState {
    return {
      gameId: g.gameId,
      homeTeam: g.homeTeam.teamName,
      awayTeam: g.awayTeam.teamName,
      homeScore: g.homeTeam.score,
      awayScore: g.awayTeam.score,
      period: g.period,
      gameClock: g.gameClock ?? '',
      gameStatus: g.gameStatus as 1 | 2 | 3,
      isQ4OrLater: g.gameStatus === 2 && g.period >= 4,
      homeTeamTricode: g.homeTeam.teamTricode,
      awayTeamTricode: g.awayTeam.teamTricode,
    };
  }
}
