/**
 * Synthetische Antworten im Schema der ESPN-Fantasy-API.
 * Sie dienen dazu, Parser und Bewertungsmodell ohne Netzzugriff zu prüfen —
 * sie ersetzen keinen Test gegen die echte API.
 */

export const SEASON = 2026;

const TEAM_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 33, 34,
];

const SLOTS = { QB: [0, 23], RB: [2, 23], WR: [4, 23], TE: [6, 23], K: [17], 'D/ST': [16] };
const DEFAULT_POS_ID = { QB: 1, RB: 2, WR: 3, TE: 4, K: 5, 'D/ST': 16 };

/** Deterministischer Pseudo-Zufall, damit Tests reproduzierbar sind. */
export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function makePlayersResponse({ season = SEASON, seed = 7 } = {}) {
  const rand = rng(seed);
  const players = [];
  let id = 1000;

  const plan = [
    ['QB', 2, 180, 200], ['RB', 5, 90, 210], ['WR', 6, 80, 220],
    ['TE', 3, 50, 140], ['K', 1, 100, 45], ['D/ST', 1, 90, 55],
  ];

  for (const teamId of TEAM_IDS) {
    // Team-Qualität streut die Projektionen, damit Offense-Stärke messbar wird.
    const quality = 0.75 + rand() * 0.5;
    for (const [pos, count, floor, span] of plan) {
      for (let i = 0; i < count; i += 1) {
        const decay = 1 - i * 0.18;
        const projection = Math.max(5, (floor + span * decay * quality) * (0.9 + rand() * 0.2));
        id += 1;
        const injuryStatus = rand() < 0.08
          ? ['QUESTIONABLE', 'OUT', 'INJURY_RESERVE', 'DOUBTFUL'][Math.floor(rand() * 4)]
          : 'ACTIVE';
        players.push({
          id,
          onTeamId: 0,
          player: {
            id,
            fullName: `${pos}${i + 1} Team${teamId}`,
            firstName: `${pos}${i + 1}`,
            lastName: `Team${teamId}`,
            proTeamId: teamId,
            defaultPositionId: DEFAULT_POS_ID[pos],
            eligibleSlots: SLOTS[pos],
            injuryStatus,
            injured: injuryStatus !== 'ACTIVE',
            ownership: {
              averageDraftPosition: Math.max(1, 250 - projection),
              percentOwned: Math.min(100, projection / 3),
            },
            draftRanksByRankType: {
              PPR: { rank: Math.max(1, Math.round(300 - projection)), auctionValue: 1 },
              STANDARD: { rank: Math.max(1, Math.round(300 - projection)), auctionValue: 1 },
            },
            stats: [
              {
                seasonId: season,
                statSourceId: 1,
                statSplitTypeId: 0,
                scoringPeriodId: 0,
                appliedTotal: projection,
                appliedAverage: projection / 17,
              },
              {
                seasonId: season - 1,
                statSourceId: 0,
                statSplitTypeId: 0,
                scoringPeriodId: 0,
                appliedTotal: projection * 0.95,
              },
            ],
          },
        });
      }
    }
  }
  return { players };
}

/** 17 Wochen Spielplan mit fester Bye-Week je Team. */
export function makeScheduleResponse({ season = SEASON } = {}) {
  const proTeams = TEAM_IDS.map((id, index) => ({
    id,
    abbrev: `T${id}`,
    location: 'Stadt',
    name: `Team ${id}`,
    // 8 Bye-Wochen x 4 Teams: pro Woche bleibt eine gerade Zahl an Teams uebrig.
    byeWeek: 5 + (index % 8),
    proGamesByScoringPeriod: {},
  }));
  const byId = new Map(proTeams.map((t) => [t.id, t]));

  for (let week = 1; week <= 17; week += 1) {
    const playing = TEAM_IDS.filter((id) => byId.get(id).byeWeek !== week);
    // Rotierende Paarung: jedes Team trifft über die Saison auf viele Gegner.
    const rotated = [...playing.slice(week % playing.length), ...playing.slice(0, week % playing.length)];
    for (let i = 0; i + 1 < rotated.length; i += 2) {
      const home = rotated[i];
      const away = rotated[i + 1];
      const game = { id: week * 1000 + i, homeProTeamId: home, awayProTeamId: away };
      byId.get(home).proGamesByScoringPeriod[week] = [game];
      byId.get(away).proGamesByScoringPeriod[week] = [game];
    }
  }
  return { seasonId: season, settings: { proTeams } };
}

/** Zugelassene Fantasy-Punkte je Position und Gegner. */
export function makeRatingsResponse({ seed = 11 } = {}) {
  const rand = rng(seed);
  const base = { 0: 18, 2: 22, 4: 30, 6: 9, 16: 7, 17: 8 };
  const positionalRatings = {};
  for (const [slot, avg] of Object.entries(base)) {
    const ratingsByOpponent = {};
    TEAM_IDS.forEach((teamId, index) => {
      ratingsByOpponent[teamId] = {
        average: avg * (0.8 + rand() * 0.4),
        rank: index + 1,
      };
    });
    positionalRatings[slot] = { average: avg, ratingsByOpponent };
  }
  return { positionAgainstOpponent: { positionalRatings } };
}

export function makeSettingsResponse({ teams = 10 } = {}) {
  return {
    scoringPeriodId: 0,
    settings: {
      name: 'Testliga',
      size: teams,
      rosterSettings: {
        lineupSlotCounts: {
          0: 1, 2: 2, 4: 2, 6: 1, 16: 1, 17: 1, 20: 7, 21: 1, 23: 1,
        },
      },
      scoringSettings: { scoringItems: [{ statId: 53, points: 1 }] },
      scheduleSettings: { matchupPeriodCount: 14, playoffTeamCount: 6 },
    },
    teams: Array.from({ length: teams }, (_, i) => ({
      id: i + 1, name: `Manager ${i + 1}`, abbrev: `M${i + 1}`,
    })),
  };
}

export function makeDraftResponse({ picks = 20, teams = 10, playerIds = [] } = {}) {
  return {
    draftDetail: {
      drafted: false,
      inProgress: true,
      picks: playerIds.slice(0, picks).map((playerId, i) => ({
        playerId,
        teamId: (i % teams) + 1,
        overallPickNumber: i + 1,
        roundId: Math.floor(i / teams) + 1,
        roundPickNumber: (i % teams) + 1,
        keeper: false,
      })),
    },
    teams: Array.from({ length: teams }, (_, i) => ({
      id: i + 1, name: `Manager ${i + 1}`,
    })),
  };
}
