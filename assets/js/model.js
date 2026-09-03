/**
 * model.js — Das eigene Bewertungsmodell.
 *
 * Idee: ESPN liefert die Talent-Basis (Projektion), das Modell gewichtet sie
 * anschließend mit den drei Kriterien, die für dieses Board zählen:
 *
 *   1. Offense-Stärke  – wie viel Fantasy-Volumen die eigene Offense erzeugt
 *   2. Strength of Schedule – wie schwach die Defenses sind, gegen die der
 *      Spieler dieses Jahr tatsächlich antritt (Playoff-Wochen extra gewichtet)
 *   3. Gesundheit – aktueller Verletzungsstatus
 *
 * Formel:  Score = 100 · Basis · (1 + wOff·offZ + wSoS·sosZ) · Gesundheitsfaktor
 *
 * Die Basis ist "Value over Replacement" (VOR), nicht die rohe Projektion:
 * nur so sind QB, RB, WR, TE, K und D/ST überhaupt vergleichbar.
 */

import { POSITIONS, healthFactor } from './espn.js';

export const DEFAULT_WEIGHTS = {
  offense: 0.12,        // Einfluss der eigenen Offense
  sos: 0.15,            // Einfluss des Spielplans
  health: 0.80,         // wie hart der Verletzungsstatus durchschlägt
  playoffBoost: 2.0,    // Gewicht der Fantasy-Playoff-Wochen im SoS
  market: 0.0,          // Angleichung an ESPN-ADP (0 = rein eigenes Modell)
};

export const DEFAULT_STARTERS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, 'D/ST': 1, K: 1 };

/** Anteil, mit dem der FLEX-Platz auf die Positionen umgelegt wird. */
const FLEX_SHARE = { RB: 0.45, WR: 0.45, TE: 0.10 };

/** Zusätzliche Bank-Spieler je Team und Position (Draft-Realität). */
const BENCH_SHARE = { QB: 0.3, RB: 0.9, WR: 0.9, TE: 0.25, K: 0, 'D/ST': 0.1 };

/** Positionen, für die die eigene Offense-Stärke relevant ist. */
const OFFENSE_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K']);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/**
 * Wie viele Spieler einer Position sind in dieser Liga "Starter-Ware"?
 * Der nächstbeste dahinter ist das Replacement-Level.
 */
export function replacementRanks(teams, starters) {
  const s = { ...DEFAULT_STARTERS, ...(starters || {}) };
  const flex = Number(s.FLEX) || 0;
  const ranks = {};
  for (const pos of POSITIONS) {
    const base = Number(s[pos]) || 0;
    const fromFlex = (FLEX_SHARE[pos] || 0) * flex;
    const bench = BENCH_SHARE[pos] || 0;
    ranks[pos] = Math.max(1, Math.round(teams * (base + fromFlex + bench)));
  }
  return ranks;
}

/** Projektion des Replacement-Spielers je Position. */
export function replacementPoints(players, ranks) {
  const out = {};
  for (const pos of POSITIONS) {
    const pool = players
      .filter((p) => p.pos === pos)
      .map((p) => p.projection)
      .sort((a, b) => b - a);
    if (!pool.length) { out[pos] = 0; continue; }
    const idx = clamp(ranks[pos] - 1, 0, pool.length - 1);
    out[pos] = pool[idx];
  }
  return out;
}

/**
 * Offense-Stärke je NFL-Team: Summe der projizierten Punkte der
 * realistischen Fantasy-Starter (QB1, RB1-2, WR1-3, TE1).
 */
export function teamOffenseStrength(players) {
  const DEPTH = { QB: 1, RB: 2, WR: 3, TE: 1 };
  const byTeam = new Map();
  for (const p of players) {
    if (!DEPTH[p.pos] || !p.teamId) continue;
    if (!byTeam.has(p.teamId)) byTeam.set(p.teamId, {});
    const bucket = byTeam.get(p.teamId);
    (bucket[p.pos] ||= []).push(p.projection);
  }
  const totals = {};
  for (const [teamId, bucket] of byTeam) {
    let sum = 0;
    for (const [pos, depth] of Object.entries(DEPTH)) {
      const list = (bucket[pos] || []).sort((a, b) => b - a).slice(0, depth);
      sum += list.reduce((a, b) => a + b, 0);
    }
    totals[teamId] = sum;
  }
  const values = Object.values(totals);
  const m = mean(values);
  const sd = stdev(values) || 1;
  const z = {};
  for (const [teamId, total] of Object.entries(totals)) {
    // z-Wert auf [-1, 1] stauchen: 2 Standardabweichungen = Maximalausschlag.
    z[Number(teamId)] = clamp((total - m) / sd / 2, -1, 1);
  }
  return { totals, z };
}

/**
 * Strength of Schedule für einen Spieler: gewichteter Schnitt der Fantasy-Punkte,
 * die seine Gegner dieses Jahr an seiner Position zulassen — relativ zum Liga-
 * schnitt. Positiv = leichter Spielplan.
 */
export function scheduleStrength(player, { schedule, ratings, leagueAvg, playoffWeeks, playoffBoost }) {
  const team = schedule?.[player.teamId];
  const table = ratings?.[player.pos];
  const avg = leagueAvg?.[player.pos];
  if (!team || !table || !avg) return null;

  const playoffSet = new Set(playoffWeeks || []);
  let weighted = 0;
  let weightSum = 0;
  let playoffSum = 0;
  let playoffCount = 0;
  let games = 0;

  for (const [weekStr, game] of Object.entries(team.opponents)) {
    const week = Number(weekStr);
    if (week < 1 || week > 17) continue;
    const rating = table[game.opponentId];
    if (!rating) continue;
    const delta = rating.average - avg;
    const weight = playoffSet.has(week) ? playoffBoost : 1;
    weighted += delta * weight;
    weightSum += weight;
    games += 1;
    if (playoffSet.has(week)) { playoffSum += delta; playoffCount += 1; }
  }
  if (!weightSum || !games) return null;

  const raw = weighted / weightSum;
  return {
    raw,
    games,
    // ±15 % Abweichung vom Ligaschnitt entspricht dem vollen Ausschlag.
    z: clamp(raw / (0.15 * avg || 1), -1, 1),
    playoffRaw: playoffCount ? playoffSum / playoffCount : null,
  };
}

/** Ligaschnitt der zugelassenen Punkte je Position. */
export function positionalLeagueAverage(ratings) {
  const avg = {};
  for (const [pos, table] of Object.entries(ratings || {})) {
    const values = Object.values(table).map((r) => r.average).filter(Number.isFinite);
    if (values.length) avg[pos] = mean(values);
  }
  return avg;
}

/**
 * Baut das komplette Board.
 * Rückgabe ist nach Score sortiert und enthält alle Zwischenwerte,
 * damit die UI jede Zahl erklären kann.
 */
export function buildBoard({
  players = [],
  schedule = {},
  ratings = {},
  teams = 10,
  starters = null,
  weights = {},
} = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const playoffWeeks = weights.playoffWeeks?.length ? weights.playoffWeeks : [15, 16, 17];

  const ranks = replacementRanks(teams, starters);
  const repl = replacementPoints(players, ranks);
  const offense = teamOffenseStrength(players);
  const leagueAvg = positionalLeagueAverage(ratings);

  const withVor = players.map((p) => ({ ...p, vor: p.projection - (repl[p.pos] ?? 0) }));
  const vorMax = Math.max(...withVor.map((p) => p.vor), 0);
  const vorMin = Math.min(...withVor.map((p) => p.vor), 0);
  // Sockel unterhalb des schwächsten Spielers: die Basis bleibt dadurch für
  // jeden Spieler streng monoton in VOR und nie exakt null — sonst würden
  // Offense, Spielplan und Gesundheit am Ende des Boards wirkungslos.
  const vorBase = vorMin - 0.15 * Math.max(vorMax - vorMin, 1);

  const maxAdp = Math.max(1, ...withVor.map((p) => p.adp || 0));

  const scored = withVor.map((p) => {
    const base = (p.vor - vorBase) / (vorMax - vorBase);

    const offZ = OFFENSE_POSITIONS.has(p.pos) ? (offense.z[p.teamId] ?? 0) : 0;
    const sos = scheduleStrength(p, {
      schedule, ratings, leagueAvg, playoffWeeks, playoffBoost: w.playoffBoost,
    });
    const sosZ = sos ? sos.z : 0;

    const adjust = clamp(1 + w.offense * offZ + w.sos * sosZ, 0.6, 1.4);
    const health = healthFactor(p.injuryStatus);
    const healthMult = clamp(1 - w.health * (1 - health), 0.2, 1);

    let score = 100 * base * adjust * healthMult;

    // Optionaler Marktabgleich: zieht den Score Richtung ESPN-ADP.
    if (w.market > 0 && p.adp > 0) {
      const marketScore = 100 * (1 - (p.adp - 1) / maxAdp);
      score = score * (1 - w.market) + marketScore * w.market;
    }

    return {
      ...p,
      byeWeek: schedule?.[p.teamId]?.byeWeek || 0,
      base,
      offZ,
      sos,
      sosZ,
      adjust,
      health,
      healthMult,
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score || b.projection - a.projection);
  scored.forEach((p, i) => { p.rank = i + 1; });

  const posCounter = {};
  for (const p of scored) {
    posCounter[p.pos] = (posCounter[p.pos] || 0) + 1;
    p.posRank = posCounter[p.pos];
    p.tier = 0;
    // Positiv = Spieler fällt im ESPN-Markt weiter als im eigenen Board → Value.
    p.adpDelta = p.adp > 0 ? Math.round(p.adp - p.rank) : null;
  }

  assignTiers(scored);

  return {
    players: scored,
    meta: {
      replacementRanks: ranks,
      replacementPoints: repl,
      offense,
      leagueAvg,
      playoffWeeks,
      weights: w,
      teams,
      starters: { ...DEFAULT_STARTERS, ...(starters || {}) },
      hasRatings: Object.keys(ratings || {}).length > 0,
      hasSchedule: Object.keys(schedule || {}).length > 0,
    },
  };
}

/**
 * Tiers je Position: ein neuer Tier beginnt dort, wo der Score-Abstand
 * zum nächsten Spieler deutlich über dem typischen Abstand liegt.
 */
export function assignTiers(scored) {
  for (const pos of POSITIONS) {
    const list = scored.filter((p) => p.pos === pos);
    if (list.length < 3) { list.forEach((p) => { p.tier = 1; }); continue; }
    const gaps = [];
    for (let i = 1; i < list.length; i += 1) gaps.push(list[i - 1].score - list[i].score);
    const cut = mean(gaps) + stdev(gaps);
    let tier = 1;
    list[0].tier = 1;
    for (let i = 1; i < list.length; i += 1) {
      if (gaps[i - 1] > cut && gaps[i - 1] > 0.4) tier += 1;
      list[i].tier = tier;
    }
  }
}
