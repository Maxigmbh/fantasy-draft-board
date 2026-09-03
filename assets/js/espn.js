/**
 * espn.js — Zugriff auf die (undokumentierte) ESPN Fantasy Football API v3.
 *
 * Alle Requests laufen im Browser des Nutzers, nicht auf einem Server:
 * nur so sind die ESPN-Cookies (espn_s2 / SWID) einer privaten Liga verfügbar.
 *
 * Genutzte Endpunkte:
 *   Liga-Settings   /apis/v3/games/ffl/seasons/{S}/segments/0/leagues/{L}?view=mSettings&view=mTeam
 *   Spielerpool     ...?view=kona_player_info            (+ X-Fantasy-Filter)
 *   Draft-Picks     ...?view=mDraftDetail&view=mTeam
 *   Defense-Rating  ...?view=mPositionalRatings
 *   NFL-Spielplan   /apis/v3/games/ffl/seasons/{S}?view=proTeamSchedules_wl
 */

export const READ_HOST = 'https://lm-api-reads.fantasy.espn.com';
export const LEGACY_HOST = 'https://fantasy.espn.com';

/** Lineup-Slot-IDs von ESPN (identisch mit dem Mapping der Community-Clients). */
export const SLOT = {
  0: 'QB', 1: 'TQB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE', 7: 'OP',
  8: 'DT', 9: 'DE', 10: 'LB', 11: 'DL', 12: 'CB', 13: 'S', 14: 'DB', 15: 'DP',
  16: 'D/ST', 17: 'K', 18: 'P', 19: 'HC', 20: 'BE', 21: 'IR', 23: 'FLEX',
  24: 'ER', 25: 'Rookie',
};

/** Slot-IDs, die in einer ESPN-Standardliga als Startplatz zählen. */
export const STARTER_SLOTS = [0, 2, 4, 6, 16, 17, 23];

/** Fallback, falls eligibleSlots fehlt. */
const DEFAULT_POSITION_ID = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };

export const PRO_TEAM = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN',
  8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA',
  16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI',
  23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR',
  30: 'JAX', 33: 'BAL', 34: 'HOU',
};

/** Die sechs Positionen, die eine ESPN-Standardliga draftet. */
export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST'];

/**
 * injuryStatus-Werte, die ESPN liefert, mit einem Verfügbarkeits-Faktor 0..1.
 * 1.0 = uneingeschränkt einsatzbereit, 0.0 = fällt aus.
 */
export const HEALTH_FACTOR = {
  ACTIVE: 1.0,
  NORMAL: 1.0,
  PROBABLE: 0.98,
  DAY_TO_DAY: 0.93,
  QUESTIONABLE: 0.88,
  DOUBTFUL: 0.70,
  OUT: 0.50,
  SUSPENSION: 0.45,
  PUP: 0.35,
  NON_FOOTBALL_INJURY: 0.35,
  INJURY_RESERVE: 0.20,
  IR: 0.20,
};

export const HEALTH_LABEL = {
  ACTIVE: 'fit', NORMAL: 'fit', PROBABLE: 'wahrscheinlich', DAY_TO_DAY: 'day-to-day',
  QUESTIONABLE: 'fraglich', DOUBTFUL: 'zweifelhaft', OUT: 'fällt aus',
  SUSPENSION: 'gesperrt', PUP: 'PUP-Liste', NON_FOOTBALL_INJURY: 'NFI-Liste',
  INJURY_RESERVE: 'IR', IR: 'IR',
};

export function healthFactor(status) {
  if (!status) return 1.0;
  const key = String(status).toUpperCase();
  return key in HEALTH_FACTOR ? HEALTH_FACTOR[key] : 0.85;
}

export function healthLabel(status) {
  if (!status) return 'fit';
  const key = String(status).toUpperCase();
  return HEALTH_LABEL[key] || key.replaceAll('_', ' ').toLowerCase();
}

/** Fehler mit maschinenlesbarem Grund, damit die UI sinnvoll reagieren kann. */
export class EspnError extends Error {
  constructor(message, { reason = 'unknown', status = 0, url = '' } = {}) {
    super(message);
    this.name = 'EspnError';
    this.reason = reason;
    this.status = status;
    this.url = url;
  }
}

/**
 * Kapselt einen HTTP-GET gegen ESPN.
 *
 * `proxy` ist optional: ist es gesetzt, wird die Ziel-URL angehängt
 * (z. B. https://mein-worker.workers.dev/?url=). Das ist der Ausweg,
 * falls ESPN keine CORS-Header für die eigene Origin sendet.
 */
export class EspnClient {
  constructor({ season, leagueId = '', proxy = '', timeoutMs = 20000 } = {}) {
    this.season = Number(season);
    this.leagueId = String(leagueId || '').trim();
    this.proxy = String(proxy || '').trim();
    this.timeoutMs = timeoutMs;
    /** Protokoll aller Requests für das Diagnose-Panel. */
    this.log = [];
  }

  get hasLeague() {
    return this.leagueId.length > 0;
  }

  _wrap(url) {
    if (!this.proxy) return url;
    return this.proxy.includes('{url}')
      ? this.proxy.replace('{url}', encodeURIComponent(url))
      : this.proxy + encodeURIComponent(url);
  }

  async _get(url, { filter = null, label = '' } = {}) {
    const headers = { Accept: 'application/json' };
    // X-Fantasy-Filter ist ein Custom-Header und löst einen CORS-Preflight aus.
    if (filter) headers['X-Fantasy-Filter'] = JSON.stringify(filter);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = performance.now();
    try {
      const res = await fetch(this._wrap(url), {
        headers,
        // Cookies mitschicken, wenn die Seite selbst auf espn.com läuft (Bridge-Modus).
        credentials: url.includes('espn.com') && location.hostname.endsWith('espn.com')
          ? 'include' : 'omit',
        signal: controller.signal,
      });
      if (!res.ok) {
        const reason = res.status === 401 || res.status === 403 ? 'auth' : 'http';
        throw new EspnError(`HTTP ${res.status} für ${label || url}`, { reason, status: res.status, url });
      }
      const json = await res.json();
      this.log.push({ label, url, ok: true, ms: Math.round(performance.now() - started) });
      return json;
    } catch (err) {
      if (err instanceof EspnError) {
        this.log.push({ label, url, ok: false, error: err.message, reason: err.reason });
        throw err;
      }
      const reason = err.name === 'AbortError' ? 'timeout' : 'network';
      const msg = reason === 'timeout'
        ? `Zeitüberschreitung bei ${label || url}`
        : `Netzwerk-/CORS-Fehler bei ${label || url}`;
      this.log.push({ label, url, ok: false, error: msg, reason });
      throw new EspnError(msg, { reason, url });
    } finally {
      clearTimeout(timer);
    }
  }

  _leagueUrl(views, host = READ_HOST) {
    const q = views.map((v) => `view=${encodeURIComponent(v)}`).join('&');
    return `${host}/apis/v3/games/ffl/seasons/${this.season}/segments/0/leagues/${this.leagueId}?${q}`;
  }

  _seasonUrl(views, season = this.season, host = READ_HOST) {
    const q = views.map((v) => `view=${encodeURIComponent(v)}`).join('&');
    return `${host}/apis/v3/games/ffl/seasons/${season}?${q}`;
  }

  /** Probiert mehrere URLs und gibt das erste Ergebnis zurück, das durchkommt. */
  async _first(candidates, opts = {}) {
    let last = null;
    for (const url of candidates) {
      try {
        return await this._get(url, opts);
      } catch (err) {
        last = err;
      }
    }
    throw last || new EspnError('Keine Quelle erreichbar', { reason: 'unknown' });
  }

  /** Liga-Einstellungen: Teamzahl, Startaufstellung, Scoring, Playoff-Wochen. */
  async fetchSettings() {
    if (!this.hasLeague) return null;
    const raw = await this._first(
      [this._leagueUrl(['mSettings']), this._leagueUrl(['mSettings'], LEGACY_HOST)],
      { label: 'Liga-Einstellungen' },
    );
    return parseSettings(raw);
  }

  /**
   * Spielerpool inkl. Projektion, Draft-Rank, ADP und Verletzungsstatus.
   * `limit` deckt mit 1000 den kompletten draftbaren Pool ab.
   */
  async fetchPlayers({ limit = 1000, rankType = 'PPR' } = {}) {
    // Minimalform des Filters — breit belegt und am wenigsten fehleranfaellig.
    const minimal = {
      players: {
        filterSlotIds: { value: STARTER_SLOTS },
        limit,
        sortDraftRanks: { sortPriority: 100, sortAsc: true, value: rankType },
        sortPercOwned: { sortPriority: 1, sortAsc: false },
      },
    };
    // Reichere Form: fordert zusaetzlich die Saisonprojektion an. ESPN quittiert
    // unbekannte Filterfelder mit 400, deshalb ist sie nur der erste Versuch.
    const rich = {
      players: {
        ...minimal.players,
        filterStatsForTopScoringPeriodIds: {
          value: 2,
          additionalValue: [`00${this.season}`, `10${this.season}`],
        },
      },
    };
    const candidates = [];
    if (this.hasLeague) {
      candidates.push(this._leagueUrl(['kona_player_info']));
      candidates.push(this._leagueUrl(['kona_player_info'], LEGACY_HOST));
    }
    candidates.push(`${READ_HOST}/apis/v3/games/ffl/seasons/${this.season}/players?scoringPeriodId=0&view=kona_player_info`);
    candidates.push(`${LEGACY_HOST}/apis/v3/games/ffl/seasons/${this.season}/players?scoringPeriodId=0&view=kona_player_info`);

    let last = null;
    for (const filter of [rich, minimal]) {
      try {
        const raw = await this._first(candidates, { filter, label: 'Spielerpool' });
        const parsed = parsePlayers(raw, this.season);
        if (parsed.length) return parsed;
        last = new EspnError('Spielerpool war leer', { reason: 'empty' });
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }

  /** NFL-Spielplan der Saison inkl. Bye-Weeks — Grundlage für Strength of Schedule. */
  async fetchSchedule() {
    const raw = await this._first(
      [this._seasonUrl(['proTeamSchedules_wl']), this._seasonUrl(['proTeamSchedules_wl'], this.season, LEGACY_HOST)],
      { label: 'NFL-Spielplan' },
    );
    return parseSchedule(raw);
  }

  /**
   * Fantasy-Punkte, die jede Defense pro Position zulässt.
   * Vor dem ersten Spieltag ist die laufende Saison leer — dann greift
   * automatisch die Vorsaison als Baseline.
   */
  async fetchPositionalRatings(season = this.season) {
    const candidates = [];
    if (this.hasLeague) {
      const q = `view=mPositionalRatings`;
      candidates.push(`${READ_HOST}/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${this.leagueId}?${q}`);
    }
    candidates.push(this._seasonUrl(['mPositionalRatings'], season));
    candidates.push(this._seasonUrl(['mPositionalRatings'], season, LEGACY_HOST));
    const raw = await this._first(candidates, { label: `Defense-Ratings ${season}` });
    return parsePositionalRatings(raw);
  }

  /** Bereits gedraftete Spieler der laufenden Liga. */
  async fetchDraft() {
    if (!this.hasLeague) throw new EspnError('Ohne Liga-ID kein Draft-Abgleich möglich', { reason: 'config' });
    const raw = await this._first(
      [this._leagueUrl(['mDraftDetail', 'mTeam']), this._leagueUrl(['mDraftDetail', 'mTeam'], LEGACY_HOST)],
      { label: 'Draft-Status' },
    );
    return parseDraft(raw);
  }
}

/* ------------------------------------------------------------------ */
/* Parser — bewusst defensiv, weil ESPN die Schemata ohne Ankündigung  */
/* ändert. Fehlende Felder dürfen nie die ganze App kippen.            */
/* ------------------------------------------------------------------ */

export function parseSettings(raw) {
  const s = raw?.settings || {};
  const lineup = s?.rosterSettings?.lineupSlotCounts || {};
  const starters = {};
  for (const [slotId, count] of Object.entries(lineup)) {
    const n = Number(count) || 0;
    if (n > 0 && STARTER_SLOTS.includes(Number(slotId))) starters[SLOT[Number(slotId)]] = n;
  }
  const receptionPoints = (s?.scoringSettings?.scoringItems || [])
    .filter((i) => i.statId === 53)
    .reduce((acc, i) => acc + (Number(i.points) || 0), 0);

  return {
    name: raw?.settings?.name || '',
    teams: Number(s?.size) || raw?.teams?.length || 10,
    starters: Object.keys(starters).length ? starters : null,
    benchSlots: Number(lineup['20']) || 0,
    // 0 = Standard, 0.5 = Half-PPR, 1 = PPR
    ppr: receptionPoints,
    playoffWeeks: derivePlayoffWeeks(s),
    scoringPeriodId: Number(raw?.scoringPeriodId) || 0,
    status: raw?.status || null,
  };
}

function derivePlayoffWeeks(settings) {
  const start = Number(settings?.scheduleSettings?.matchupPeriodCount) || 14;
  const teams = Number(settings?.scheduleSettings?.playoffTeamCount) || 4;
  const rounds = Math.max(1, Math.ceil(Math.log2(Math.max(2, teams))));
  const weeks = [];
  for (let i = 0; i < rounds; i += 1) weeks.push(start + 1 + i);
  return weeks.filter((w) => w >= 14 && w <= 18);
}

/** Primärposition aus eligibleSlots ableiten (zuverlässiger als defaultPositionId). */
export function positionOf(player) {
  const slots = Array.isArray(player?.eligibleSlots) ? player.eligibleSlots : [];
  const priority = [16, 17, 0, 2, 4, 6];
  for (const slot of priority) {
    if (slots.includes(slot)) return SLOT[slot];
  }
  return DEFAULT_POSITION_ID[player?.defaultPositionId] || null;
}

/** Projizierte Saisonpunkte: statSourceId 1 = Projektion, statSplitTypeId 0 = Saison. */
export function projectedPoints(player, season) {
  const stats = Array.isArray(player?.stats) ? player.stats : [];
  const seasonProj = stats.find(
    (s) => Number(s.seasonId) === Number(season) && Number(s.statSourceId) === 1
      && Number(s.statSplitTypeId) === 0,
  );
  if (seasonProj && Number.isFinite(Number(seasonProj.appliedTotal))) {
    return Number(seasonProj.appliedTotal);
  }
  // Fallback: irgendeine Saisonprojektion, sonst die Vorsaison-Ist-Leistung.
  const anyProj = stats.find((s) => Number(s.statSourceId) === 1 && Number(s.statSplitTypeId) === 0);
  if (anyProj && Number.isFinite(Number(anyProj.appliedTotal))) return Number(anyProj.appliedTotal);
  const lastYear = stats.find(
    (s) => Number(s.seasonId) === Number(season) - 1 && Number(s.statSourceId) === 0
      && Number(s.statSplitTypeId) === 0,
  );
  return lastYear && Number.isFinite(Number(lastYear.appliedTotal)) ? Number(lastYear.appliedTotal) : 0;
}

export function parsePlayers(raw, season) {
  const entries = Array.isArray(raw?.players) ? raw.players : [];
  const out = [];
  for (const entry of entries) {
    const p = entry?.player || entry?.playerPoolEntry?.player || entry;
    if (!p || p.id == null) continue;
    const pos = positionOf(p);
    if (!pos || !POSITIONS.includes(pos)) continue;

    const ranks = p.draftRanksByRankType || {};
    const rankPpr = Number(ranks?.PPR?.rank) || 0;
    const rankStd = Number(ranks?.STANDARD?.rank) || 0;

    out.push({
      id: Number(p.id),
      name: p.fullName || `${p.firstName || ''} ${p.lastName || ''}`.trim() || `Spieler ${p.id}`,
      pos,
      teamId: Number(p.proTeamId) || 0,
      team: PRO_TEAM[Number(p.proTeamId)] || 'FA',
      eligibleSlots: Array.isArray(p.eligibleSlots) ? p.eligibleSlots : [],
      injuryStatus: p.injuryStatus || (p.injured ? 'QUESTIONABLE' : 'ACTIVE'),
      injured: Boolean(p.injured),
      projection: projectedPoints(p, season),
      espnRankPpr: rankPpr,
      espnRankStd: rankStd,
      adp: Number(p?.ownership?.averageDraftPosition) || 0,
      percentOwned: Number(p?.ownership?.percentOwned) || 0,
      // Von ESPN gemeldeter Roster-Status; ergänzt später den Live-Draft-Abgleich.
      onTeamId: Number(entry?.onTeamId) || 0,
    });
  }
  return out;
}

export function parseSchedule(raw) {
  const proTeams = raw?.settings?.proTeams || [];
  const byTeam = {};
  for (const team of proTeams) {
    const id = Number(team?.id);
    if (!Number.isFinite(id) || id === 0) continue;
    const games = team?.proGamesByScoringPeriod || {};
    const opponents = {};
    for (const [week, list] of Object.entries(games)) {
      const game = Array.isArray(list) ? list[0] : null;
      if (!game) continue;
      const home = Number(game.homeProTeamId);
      const away = Number(game.awayProTeamId);
      const opp = home === id ? away : home;
      if (Number.isFinite(opp) && opp !== 0) {
        opponents[Number(week)] = { opponentId: opp, home: home === id };
      }
    }
    byTeam[id] = {
      id,
      abbrev: team?.abbrev || PRO_TEAM[id] || String(id),
      name: [team?.location, team?.name].filter(Boolean).join(' ') || PRO_TEAM[id] || String(id),
      byeWeek: Number(team?.byeWeek) || 0,
      opponents,
    };
  }
  return byTeam;
}

/**
 * mPositionalRatings liefert je Position und Gegner den Schnitt an
 * zugelassenen Fantasy-Punkten. Die Positionsschlüssel sind Slot-IDs.
 */
export function parsePositionalRatings(raw) {
  const root = raw?.positionAgainstOpponent?.positionalRatings || {};
  const out = {};
  for (const [slotId, entry] of Object.entries(root)) {
    const pos = SLOT[Number(slotId)];
    if (!pos || !POSITIONS.includes(pos)) continue;
    const byOpp = entry?.ratingsByOpponent || {};
    const table = {};
    for (const [teamId, rating] of Object.entries(byOpp)) {
      const avg = Number(rating?.average);
      if (Number.isFinite(avg)) {
        table[Number(teamId)] = { average: avg, rank: Number(rating?.rank) || 0 };
      }
    }
    if (Object.keys(table).length) out[pos] = table;
  }
  return out;
}

export function parseDraft(raw) {
  const detail = raw?.draftDetail || {};
  const picks = Array.isArray(detail.picks) ? detail.picks : [];
  const teamNames = {};
  for (const team of raw?.teams || []) {
    const id = Number(team?.id);
    if (!Number.isFinite(id)) continue;
    teamNames[id] = team?.name
      || [team?.location, team?.nickname].filter(Boolean).join(' ')
      || team?.abbrev
      || `Team ${id}`;
  }
  return {
    drafted: Boolean(detail.drafted),
    inProgress: Boolean(detail.inProgress),
    teamNames,
    picks: picks
      .filter((pick) => Number(pick?.playerId) > 0)
      .map((pick) => ({
        playerId: Number(pick.playerId),
        teamId: Number(pick.teamId) || 0,
        overall: Number(pick.overallPickNumber) || 0,
        round: Number(pick.roundId) || 0,
        roundPick: Number(pick.roundPickNumber) || 0,
        keeper: Boolean(pick.keeper),
      })),
  };
}
