/**
 * board.js — Datenmodell des Draftboards. Kein DOM, kein Netz:
 * alles hier ist eine reine Funktion und damit einzeln pruefbar.
 *
 * Die Datei assets/data/board.json entsteht offline aus drei offenen
 * Quellen; siehe tools/README.md. Die Seite rechnet nur noch die
 * Gewichtung neu, damit die Regler sofort wirken.
 */

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'];
export const FLEX = ['RB', 'WR', 'TE'];

export const DEFAULT_WEIGHTS = { offense: 0.12, sos: 0.15 };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/**
 * Wert eines Draft-Platzes. Muss identisch zu tools/build-data.mjs sein,
 * sonst weichen Board und Datendatei voneinander ab.
 */
export function draftValue(ecr, decay = 65) {
  return Math.exp(-(Math.max(1, ecr) - 1) / decay);
}

/**
 * Rechnet Score, Rang und Tiers mit den aktuellen Gewichten neu.
 * Gibt eine neue Liste zurueck; die Eingabe bleibt unveraendert.
 */
export function rankPlayers(players, weights = DEFAULT_WEIGHTS, teamsInLeague = 12) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  const scored = players.map((p) => {
    const adjust = clamp(1 + w.offense * p.offenseIndex + w.sos * p.sosIndex, 0.7, 1.3);
    return { ...p, adjust, score: Number((100 * draftValue(p.ecr) * adjust).toFixed(1)) };
  });

  scored.sort((a, b) => b.score - a.score || a.ecr - b.ecr);

  const posCount = {};
  scored.forEach((p, i) => {
    p.rank = i + 1;
    p.round = Math.floor(i / teamsInLeague) + 1;
    p.pickInRound = (i % teamsInLeague) + 1;
    posCount[p.pos] = (posCount[p.pos] || 0) + 1;
    p.boardPosRank = posCount[p.pos];
    // Positiv: die Experten setzen ihn spaeter an, als das Board ihn sieht.
    p.value = Number((p.ecr - p.rank).toFixed(1));
  });

  assignTiers(scored, () => 'ALL', 'overallTier');
  assignTiers(scored, (p) => p.pos, 'tier');
  return scored;
}

/**
 * Ein neuer Tier beginnt, wo der Abstand zum naechsten Spieler auffaellt.
 *
 * Gemessen wird der RELATIVE Abstand. Der Score faellt exponentiell: zwischen
 * Platz 1 und 2 liegen absolut viele Punkte, zwischen 200 und 201 fast keine.
 * Absolute Abstaende wuerden vorne jeden Spieler zu einem eigenen Tier machen
 * und hinten alles in einen Topf werfen.
 *
 * `minSize` verhindert Ein-Spieler-Tiers: ein Tier bricht fruehestens auf,
 * wenn er die Mindestgroesse erreicht hat.
 */
export function assignTiers(players, groupOf, field, { minSize = 3 } = {}) {
  const groups = new Map();
  for (const p of players) {
    const g = groupOf(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  for (const list of groups.values()) {
    if (list.length < minSize * 2) { list.forEach((p) => { p[field] = 1; }); continue; }
    const gaps = [];
    for (let i = 1; i < list.length; i += 1) {
      const prev = Math.max(list[i - 1].score, 0.01);
      const cur = Math.max(list[i].score, 0.01);
      gaps.push(Math.log(prev) - Math.log(cur));
    }
    const cut = mean(gaps) + stdev(gaps);
    let tier = 1;
    let since = 1;
    list[0][field] = 1;
    for (let i = 1; i < list.length; i += 1) {
      if (gaps[i - 1] > cut && since >= minSize) { tier += 1; since = 0; }
      list[i][field] = tier;
      since += 1;
    }
  }
}

export const SORTS = {
  score: (a, b) => b.score - a.score,
  ecr: (a, b) => a.ecr - b.ecr,
  value: (a, b) => b.value - a.value,
  sos: (a, b) => b.sosIndex - a.sosIndex,
  offense: (a, b) => b.offenseIndex - a.offenseIndex,
  prior: (a, b) => (b.priorPoints ?? -1) - (a.priorPoints ?? -1),
};

/**
 * Ob ein Spieler zu Positions-, Such- und Gedraftet-Filtern passt.
 * Eigenstaendig exportiert, damit sowohl die score-sortierte Hauptliste als
 * auch die kuratierten Nebenlisten (Breakouts, Versteckte Werte) dieselbe
 * Filterlogik verwenden — dort darf nur nicht zusaetzlich neu sortiert werden,
 * die kuratierte Reihenfolge traegt eigene Bedeutung (z. B. Verletzung zuerst).
 */
export function matchesFilters(p, { pos = 'ALLE', search = '', drafted = null, hideDrafted = false } = {}) {
  if (pos === 'FLEX') {
    if (!FLEX.includes(p.pos)) return false;
  } else if (pos !== 'ALLE' && p.pos !== pos) return false;
  if (hideDrafted && drafted?.has(p.id)) return false;
  const needle = search.trim().toLowerCase();
  if (needle && !p.name.toLowerCase().includes(needle)
    && !p.team.toLowerCase().includes(needle)) return false;
  return true;
}

/** Filtert nach Position, Suchtext und bereits gedrafteten Spielern. */
export function filterPlayers(players, opts = {}) {
  const list = players.filter((p) => matchesFilters(p, opts));
  return [...list].sort(SORTS[opts.sort] || SORTS.score);
}

/**
 * Gruppiert die gefilterte Liste in Tier-Bloecke.
 * Der Positionsfilter bestimmt, welcher Tier gilt: in der Gesamtansicht
 * der Gesamt-Tier, sonst der Tier innerhalb der Position.
 */
export function groupByTier(players, pos = 'ALLE') {
  const field = pos === 'ALLE' || pos === 'FLEX' ? 'overallTier' : 'tier';
  const groups = [];
  let current = null;
  for (const p of players) {
    const tier = p[field];
    if (!current || current.tier !== tier) {
      current = { tier, players: [] };
      groups.push(current);
    }
    current.players.push(p);
  }
  return groups;
}

/** Auswahl fuer die Nebenlisten, aufgeloest aus den IDs der Datendatei. */
export function resolveList(players, ids) {
  const byId = new Map(players.map((p) => [p.id, p]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}
