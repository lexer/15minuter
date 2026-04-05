import { GameMonitor } from '../../src/services/GameMonitor';

const MOCK_SCOREBOARD = {
  scoreboard: {
    games: [
      {
        gameId: '0022501001',
        gameStatus: 2,
        period: 4,
        gameClock: 'PT03M22.00S',
        homeTeam: { teamTricode: 'LAL', teamName: 'Lakers', score: 105 },
        awayTeam: { teamTricode: 'BOS', teamName: 'Celtics', score: 88 },
      },
      {
        gameId: '0022501002',
        gameStatus: 2,
        period: 2,
        gameClock: 'PT08M10.00S',
        homeTeam: { teamTricode: 'GSW', teamName: 'Warriors', score: 55 },
        awayTeam: { teamTricode: 'HOU', teamName: 'Rockets', score: 52 },
      },
      {
        gameId: '0022501003',
        gameStatus: 3,
        period: 4,
        gameClock: 'PT00M00.00S',
        homeTeam: { teamTricode: 'MIA', teamName: 'Heat', score: 110 },
        awayTeam: { teamTricode: 'NYK', teamName: 'Knicks', score: 105 },
      },
    ],
  },
};

describe('GameMonitor', () => {
  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => MOCK_SCOREBOARD,
    } as Response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('identifies Q4 live game as isQ4OrLater=true', async () => {
    const monitor = new GameMonitor();
    const games = await monitor.getLiveGames();
    const q4 = games.find((g) => g.homeTeamTricode === 'LAL');
    expect(q4?.isQ4OrLater).toBe(true);
    expect(q4?.period).toBe(4);
    expect(q4?.gameStatus).toBe(2);
  });

  it('identifies Q2 live game as isQ4OrLater=false', async () => {
    const monitor = new GameMonitor();
    const games = await monitor.getLiveGames();
    const q2 = games.find((g) => g.homeTeamTricode === 'GSW');
    expect(q2?.isQ4OrLater).toBe(false);
  });

  it('identifies finished game as isQ4OrLater=false (status=3)', async () => {
    const monitor = new GameMonitor();
    const games = await monitor.getLiveGames();
    const finished = games.find((g) => g.homeTeamTricode === 'MIA');
    expect(finished?.isQ4OrLater).toBe(false);
    expect(finished?.gameStatus).toBe(3);
  });

  it('getGameState finds game by team tricodes', async () => {
    const monitor = new GameMonitor();
    const state = await monitor.getGameState('LAL', 'BOS');
    expect(state).not.toBeNull();
    expect(state?.homeScore).toBe(105);
    expect(state?.awayScore).toBe(88);
  });

  it('getGameState works regardless of home/away order', async () => {
    const monitor = new GameMonitor();
    const state = await monitor.getGameState('BOS', 'LAL');
    expect(state).not.toBeNull();
    expect(state?.homeTeamTricode).toBe('LAL');
  });

  it('getGameState returns null for unknown teams', async () => {
    const monitor = new GameMonitor();
    const state = await monitor.getGameState('OKC', 'DEN');
    expect(state).toBeNull();
  });

  it('caches results within TTL', async () => {
    const monitor = new GameMonitor();
    await monitor.getLiveGames();
    await monitor.getLiveGames();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
