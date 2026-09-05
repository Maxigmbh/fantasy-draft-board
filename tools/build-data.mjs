/**
 * build-data.mjs — Erzeugt assets/data/board.json aus offenen Quellen.
 *
 *   1. DynastyProcess  github.com/dynastyprocess/data
 *      FantasyPros Expert Consensus Rankings (taeglicher Scrape):
 *      Dynasty-Gesamtliste, Redraft-Gesamtliste, Rookie-Liste,
 *      Positions-Ranglisten fuer K und DST, Spieler-Stammdaten, Handelswerte.
 *   2. nflverse/nfldata  github.com/nflverse/nfldata
 *      Kompletter NFL-Spielplan der Saison inklusive Wettquoten.
 *   3. hvpkod/NFL-Data  github.com/hvpkod/NFL-Data
 *      Fantasy-Punkte der Vorsaison je Spieler.
 *   4. nflverse/nflverse-data (Release-Assets, kein Git-Clone)
 *      Aktueller Rosterstatus (Reserve-Liste = verletzt/gesperrt) und
 *      Tiefenaufstellung der Running Backs. Wird von diesem Skript selbst
 *      heruntergeladen, siehe fetchRelease().
 *
 * Aufruf:
 *   git clone --depth 1 https://github.com/dynastyprocess/data   <dir>/dp-data
 *   git clone --depth 1 https://github.com/nflverse/nfldata      <dir>/nfldata
 *   git clone --depth 1 https://github.com/hvpkod/NFL-Data       <dir>/nfl-stats
 *   node tools/build-data.mjs <dir>
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(process.argv[2] || join(ROOT, '..', 'data-sources'));
const SEASON = Number(process.argv[3]) || 2026;
const PRIOR = SEASON - 1;

export const LEAGUE = { teams: 12, scoring: 'PPR' };

/** Startplaetze einer 12er-PPR-Liga, inklusive anteiligem FLEX und Bank. */
const REPLACEMENT = { QB: 1.3, RB: 2.7, WR: 3.2, TE: 1.3, K: 1.0, DST: 1.0 };

/** Fantasy-Playoffs zaehlen im Spielplan mehrfach. */
const PLAYOFF_WEEKS = [15, 16, 17];
const PLAYOFF_WEIGHT = 2.0;

const WEIGHTS = { offense: 0.12, sos: 0.15 };

/** Teamkuerzel angleichen: die Quellen schreiben drei Teams unterschiedlich. */
const TEAM_ALIAS = { JAC: 'JAX', LAR: 'LA', LA: 'LA', JAX: 'JAX' };
const teamCode = (t) => TEAM_ALIAS[t] || t;

/**
 * K und DST erscheinen in FantasyPros' positionsuebergreifender "Overall"-
 * Rangliste nur teilweise und in einer Reihenfolge, die von der eigenen
 * Positions-Rangliste erheblich abweicht (siehe tools/README.md). Fuer beide
 * Positionen gilt deshalb ausschliesslich die dedizierte Positions-Rangliste;
 * ihr 1..N-Rang wird linear auf eine Draft-typische Spaetrunden-Lage
 * abgebildet. ANCHOR ist die angenommene Gesamtposition des besten Spielers,
 * SPACING der Abstand je weiterem Rang.
 */
const KDST_SCALE = {
  K: { anchor: 145, spacing: 5 },
  DST: { anchor: 135, spacing: 6 },
};

/** injuryReserve-Codes gemaess nflreadr-Datenwoerterbuch (Reserve-Liste). */
const INJURY_ABBR = {
  R01: 'IR', R04: 'PUP', R05: 'NFI', R48: 'IR (Rückkehr möglich)',
};

/* ------------------------------------------------------------------ */

/** CSV-Parser, der Anfuehrungszeichen und eingebettete Kommas beherrscht. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() || [];
  return rows
    .filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/**
 * Zahl aus einem CSV-Feld. Leere Felder muessen null ergeben, nicht 0:
 * `Number('')` ist in JavaScript 0, und ein fehlender Wert wuerde sonst als
 * echte Null in die Rechnung eingehen. Die Quellen schreiben fehlende Werte
 * teils als leeres Feld, teils als "NA".
 */
const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === '' || s.toUpperCase() === 'NA') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const stdev = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Namensschluessel fuer den Abgleich zwischen den Quellen. */
export function nameKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/['’.]/g, '')
    .replace(/-/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/* ------------------------------------------------------------------ */
/* Team-Ratings aus den Wettquoten                                     */
/* ------------------------------------------------------------------ */

/**
 * Zerlegt die Quoten in erwartete Punkte je Team und Spiel und schaetzt
 * daraus fuer jedes Team eine Offense- und eine Defense-Staerke.
 *
 * Die Buchmacher stellen nur fuer die naechsten Wochen Linien; das Modell
 * uebertraegt die Staerken auf den kompletten Spielplan.
 */
export function fitTeamRatings(observations, { ridge = 3, iterations = 300 } = {}) {
  const all = observations.map((o) => o.points);
  const mu = mean(all);
  const home = observations.filter((o) => o.home).map((o) => o.points);
  const away = observations.filter((o) => !o.home).map((o) => o.points);
  const hfa = mean(home) - mean(away);

  const offense = new Map();
  const defense = new Map();
  for (const o of observations) { offense.set(o.team, 0); defense.set(o.team, 0); }

  for (let it = 0; it < iterations; it += 1) {
    const numO = new Map(); const denO = new Map();
    for (const o of observations) {
      const resid = o.points - mu - (defense.get(o.opponent) || 0) - hfa * (o.home - 0.5);
      numO.set(o.team, (numO.get(o.team) || 0) + resid);
      denO.set(o.team, (denO.get(o.team) || 0) + 1);
    }
    // Ridge: Teams mit wenigen Spielen werden Richtung Ligamittel gezogen.
    for (const [t, n] of denO) offense.set(t, numO.get(t) / (n + ridge));

    const numD = new Map(); const denD = new Map();
    for (const o of observations) {
      const resid = o.points - mu - (offense.get(o.team) || 0) - hfa * (o.home - 0.5);
      numD.set(o.opponent, (numD.get(o.opponent) || 0) + resid);
      denD.set(o.opponent, (denD.get(o.opponent) || 0) + 1);
    }
    for (const [t, n] of denD) defense.set(t, numD.get(t) / (n + ridge));
  }
  return { mu, hfa, offense, defense };
}

/** Erwartete Punkte eines Teams in einem bestimmten Spiel. */
export function expectedPoints(ratings, team, opponent, isHome) {
  return ratings.mu
    + (ratings.offense.get(team) || 0)
    + (ratings.defense.get(opponent) || 0)
    + ratings.hfa * (isHome - 0.5);
}

/**
 * Wert eines Draft-Platzes. Der Abstand zwischen Platz 1 und 10 wiegt weit
 * schwerer als der zwischen 100 und 110 — die Kurve bildet das ab.
 * Halbwertszeit rund 45 Plaetze.
 */
export function draftValue(ecr, decay = 65) {
  return Math.exp(-(Math.max(1, ecr) - 1) / decay);
}

/* ------------------------------------------------------------------ */
/* Rang -> Punkte                                                       */
/* ------------------------------------------------------------------ */

/**
 * Uebersetzt einen Positionsrang in erwartete Fantasy-Punkte.
 * Grundlage ist, was der Spieler auf diesem Rang in der Vorsaison
 * tatsaechlich erzielt hat — geglaettet, damit Ausreisser nicht durchschlagen.
 */
export function buildPointsCurve(seasonPoints, { window = 2 } = {}) {
  const sorted = [...seasonPoints].sort((a, b) => b - a);
  return sorted.map((_, i) => {
    const from = Math.max(0, i - window);
    const to = Math.min(sorted.length, i + window + 1);
    return mean(sorted.slice(from, to));
  });
}

export function pointsForRank(curve, rank) {
  if (!curve.length) return 0;
  const i = clamp(Math.round(rank) - 1, 0, curve.length - 1);
  return curve[i];
}

/* ------------------------------------------------------------------ */

function loadCsv(...parts) {
  const path = join(SRC, ...parts);
  if (!existsSync(path)) throw new Error(`Quelle fehlt: ${path}`);
  return parseCsv(readFileSync(path, 'utf8'));
}

/**
 * Laedt eine nflverse-Release-Datei bei Bedarf herunter und cached sie lokal.
 * Anders als die drei Git-Quellen sind Rosterstatus und Tiefenaufstellung
 * keine Repository-Dateien, sondern GitHub-Release-Assets — deshalb der
 * direkte Download statt eines weiteren `git clone`.
 *
 * Netzzugriff ist optional: schlaegt er fehl, liefert die Funktion `null`
 * und die Pipeline laeuft ohne Rosterstatus und Handcuff-Erkennung weiter.
 */
async function fetchRelease(tag, file) {
  const dir = join(SRC, 'nflverse-releases');
  const dest = join(dir, file);
  if (existsSync(dest)) return readFileSync(dest, 'utf8');
  try {
    const url = `https://github.com/nflverse/nflverse-data/releases/download/${tag}/${file}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, text);
    return text;
  } catch (err) {
    console.warn(`Hinweis: ${file} nicht verfuegbar (${err.message}). `
      + 'Rosterstatus und Handcuff-Erkennung bleiben ohne diese Datei aus.');
    return null;
  }
}

async function main() {
  /* ---- 1. Expertenrankings ---- */
  const ecr = loadCsv('dp-data', 'files', 'db_fpecr_latest.csv');
  const pageOf = (type) => ecr.filter((r) => r.page_type === type);
  const dynasty = pageOf('dynasty-overall');
  const redraft = pageOf('redraft-overall');
  const rookies = pageOf('dynasty-rk');
  if (!dynasty.length) throw new Error('Keine Dynasty-Rangliste in der Quelle gefunden');
  const scrapeDate = dynasty[0].scrape_date;

  const redraftByName = new Map(redraft.map((r) => [nameKey(r.player), num(r.ecr)]));
  const rookieNames = new Set(rookies.map((r) => nameKey(r.player)));

  /* ---- 1b. Stammdaten: Alter und Draft-Jahrgang ---- */
  // Der Schluessel `id` der Rangliste ist die FantasyPros-ID; ueber sie ist die
  // Zuordnung eindeutig. Der Name dient nur als Rueckfall.
  const idRows = loadCsv('dp-data', 'files', 'db_playerids.csv');
  const bioById = new Map();
  const bioByName = new Map();
  for (const r of idRows) {
    const bio = {
      age: num(r.age),
      birthdate: r.birthdate || null,
      draftYear: num(r.draft_year),
      draftRound: num(r.draft_round),
      draftPick: num(r.draft_ovr),
      gsisId: r.gsis_id || null,
    };
    if (r.fantasypros_id) bioById.set(r.fantasypros_id, bio);
    if (r.name && !bioByName.has(nameKey(r.name))) bioByName.set(nameKey(r.name), bio);
  }

  /* ---- 1c. Marktwert als Gegenstueck zur ADP ---- */
  // FantasyPros stellt seine ADP nicht offen bereit. Der Dynasty-Handelswert
  // von DynastyProcess ist das naechstbeste Marktsignal: er entsteht aus
  // tatsaechlichen Tauschgeschaeften, nicht aus Expertenmeinungen.
  const valueRows = loadCsv('dp-data', 'files', 'values-players.csv');
  const marketByName = new Map();
  for (const r of valueRows) {
    const value = num(r.value_1qb);
    if (value !== null) marketByName.set(nameKey(r.player), value);
  }

  /* ---- 1d. Rosterstatus: wer ist gerade verletzt oder gesperrt? ---- */
  // status='RES' ist die Reserve-Liste (IR, PUP, NFI, Suspendiert). Das ist
  // der einzige tatsaechliche Verletzungssignal in offenen Quellen — es
  // beschreibt den Stand zum Zeitpunkt des Datenabrufs, nicht den Draft-Tag.
  const rosterText = await fetchRelease('rosters', `roster_${SEASON}.csv`);
  const statusByGsis = new Map();
  if (rosterText) {
    const rosterRows = parseCsv(rosterText);
    // Bei mehreren Wochen je Spieler zaehlt die zuletzt gemeldete.
    const latestWeek = new Map();
    for (const r of rosterRows) {
      if (!r.gsis_id) continue;
      const week = num(r.week) ?? 0;
      if (!latestWeek.has(r.gsis_id) || week >= latestWeek.get(r.gsis_id)) {
        latestWeek.set(r.gsis_id, week);
        statusByGsis.set(r.gsis_id, { status: r.status, abbr: r.status_description_abbr });
      }
    }
  }

  /* ---- 1e. Tiefenaufstellung Running Back fuer Handcuff-Erkennung ---- */
  const depthText = await fetchRelease('depth_charts', `depth_charts_${SEASON}.csv`);
  const rbDepthByGsis = new Map();
  if (depthText) {
    const depthRows = parseCsv(depthText);
    const latestDt = depthRows.reduce((max, r) => (r.dt > max ? r.dt : max), '');
    for (const r of depthRows) {
      if (r.dt !== latestDt || r.pos_name !== 'Running Back' || !r.gsis_id) continue;
      rbDepthByGsis.set(r.gsis_id, { team: teamCode(r.team), posRank: num(r.pos_rank) });
    }
  }

  /* ---- 2. Spielplan und Team-Ratings ---- */
  const games = loadCsv('nfldata', 'data', 'games.csv')
    .filter((g) => Number(g.season) === SEASON && g.game_type === 'REG');
  if (!games.length) throw new Error(`Kein Spielplan fuer ${SEASON}`);

  const observations = [];
  for (const g of games) {
    const total = num(g.total_line);
    const spread = num(g.spread_line);
    if (total === null || spread === null) continue;
    observations.push({
      team: g.home_team, opponent: g.away_team, home: 1, points: total / 2 + spread / 2,
    });
    observations.push({
      team: g.away_team, opponent: g.home_team, home: 0, points: total / 2 - spread / 2,
    });
  }
  const ratings = fitTeamRatings(observations);

  const schedule = new Map();
  const weeks = new Map();
  for (const g of games) {
    const week = Number(g.week);
    for (const [team, opponent, isHome] of [
      [g.home_team, g.away_team, 1], [g.away_team, g.home_team, 0],
    ]) {
      if (!schedule.has(team)) schedule.set(team, []);
      schedule.get(team).push({
        week,
        opp: opponent,
        home: Boolean(isHome),
        implied: Number(expectedPoints(ratings, team, opponent, isHome).toFixed(2)),
      });
      if (!weeks.has(team)) weeks.set(team, new Set());
      weeks.get(team).add(week);
    }
  }

  const maxWeek = Math.max(...games.map((g) => Number(g.week)));
  const teams = {};
  const impliedAll = [];
  for (const [team, list] of schedule) {
    list.sort((a, b) => a.week - b.week);
    const played = weeks.get(team);
    let bye = 0;
    for (let w = 1; w <= maxWeek; w += 1) if (!played.has(w)) { bye = w; break; }
    const seasonAvg = mean(list.map((g) => g.implied));
    const playoff = list.filter((g) => PLAYOFF_WEEKS.includes(g.week));
    impliedAll.push(seasonAvg);
    teams[team] = {
      abbrev: team,
      bye,
      offense: Number((ratings.offense.get(team) || 0).toFixed(2)),
      defense: Number((ratings.defense.get(team) || 0).toFixed(2)),
      impliedSeason: Number(seasonAvg.toFixed(2)),
      impliedPlayoffs: playoff.length ? Number(mean(playoff.map((g) => g.implied)).toFixed(2)) : null,
      schedule: list,
    };
  }

  // Spielplan-Index: ausschliesslich die Durchlaessigkeit der Gegner-Defenses.
  // Die eigene Offense darf hier nicht einfliessen — sie steht schon im
  // Offense-Index, sonst zaehlt dieselbe Teamstaerke zweimal.
  const sosRaw = {};
  for (const [team, info] of Object.entries(teams)) {
    let weighted = 0; let weightSum = 0;
    for (const g of info.schedule) {
      const w = PLAYOFF_WEEKS.includes(g.week) ? PLAYOFF_WEIGHT : 1;
      weighted += (ratings.defense.get(g.opp) || 0) * w; weightSum += w;
    }
    sosRaw[team] = weightSum ? weighted / weightSum : 0;
  }
  const sosMean = mean(Object.values(sosRaw));
  const sosSd = stdev(Object.values(sosRaw)) || 1;
  const offMean = mean([...ratings.offense.values()]);
  const offSd = stdev([...ratings.offense.values()]) || 1;
  for (const [team, info] of Object.entries(teams)) {
    info.sosIndex = Number(clamp((sosRaw[team] - sosMean) / sosSd / 2, -1, 1).toFixed(3));
    info.offenseIndex = Number(clamp(((ratings.offense.get(team) || 0) - offMean) / offSd / 2, -1, 1).toFixed(3));
  }

  /* ---- 3. Vorsaison-Produktion, zwei Jahre zurueck ---- */
  // "Letztes Jahr oder in den letzten beiden Jahren Starter" (Nutzerwunsch)
  // heisst: ein Spieler zaehlt als frueherer Starter, wenn er in PRIOR ODER
  // in PRIOR_2 unter den Top 30 seiner Position lag.
  function loadSeasonRanks(season) {
    const map = new Map();
    for (const pos of ['QB', 'RB', 'WR', 'TE', 'K']) {
      let rowsForPos;
      try {
        rowsForPos = loadCsv('nfl-stats', 'NFL-data-Players', String(season), `${pos}_season.csv`);
      } catch { continue; }
      const scored = rowsForPos
        .map((r) => ({ name: r.PlayerName, points: num(r.TotalPoints) ?? 0, team: r.Team }))
        .filter((p) => p.name)
        .sort((a, b) => b.points - a.points);
      scored.forEach((p, i) => {
        map.set(`${nameKey(p.name)}|${pos}`, { points: p.points, posRank: i + 1, team: p.team });
      });
    }
    return map;
  }
  const prior = loadSeasonRanks(PRIOR);
  const prior2 = loadSeasonRanks(PRIOR - 1);

  /* ---- 4. Punktekurven je Position ---- */
  const curves = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K']) {
    const pts = [...prior.entries()]
      .filter(([key]) => key.endsWith(`|${pos}`))
      .map(([, v]) => v.points);
    curves[pos] = buildPointsCurve(pts);
  }
  // Defenses liefert die Quelle nicht; flache Kurve auf Kicker-Niveau.
  curves.DST = curves.K.length ? curves.K.map((v) => v * 0.85) : [];

  /* ---- 5. Spieler zusammenfuehren ---- */
  // K und DST kommen ausschliesslich aus ihrer eigenen Positions-Rangliste,
  // linear auf eine Spaetrunden-Lage abgebildet (siehe KDST_SCALE oben und
  // tools/README.md fuer die Begruendung). Best/Worst/SD werden mit derselben
  // Skala transformiert, damit sie zur neuen ECR passen.
  function buildKdstRows(pos, sourceRows) {
    const { anchor, spacing } = KDST_SCALE[pos];
    const scale = (rank) => (rank === null ? null : anchor + (rank - 1) * spacing);
    return [...sourceRows]
      .filter((r) => num(r.ecr) !== null)
      .sort((a, b) => num(a.ecr) - num(b.ecr))
      .map((r, i) => ({
        ...r,
        pos,
        ecr: String(anchor + i * spacing),
        best: scale(num(r.best)) === null ? '' : String(scale(num(r.best))),
        worst: scale(num(r.worst)) === null ? '' : String(scale(num(r.worst))),
        sd: num(r.sd) === null ? '' : String(num(r.sd) * spacing),
      }));
  }

  const skillRows = dynasty.filter((r) => r.pos !== 'K' && r.pos !== 'DST');
  const kRows = buildKdstRows('K', pageOf('dynasty-k'));
  const dstRows = buildKdstRows('DST', pageOf('dynasty-dst'));

  const players = [...skillRows, ...kRows, ...dstRows]
    .map((r) => {
      const ecrValue = num(r.ecr);
      if (ecrValue === null) return null;
      const pos = r.pos === 'DST' ? 'DST' : r.pos;
      const team = teamCode(r.team);
      const key = nameKey(r.player);
      const priorEntry = prior.get(`${key}|${pos}`) || null;
      const prior2Entry = prior2.get(`${key}|${pos}`) || null;
      // Team-Defenses sind keine Personen: kein Alter, kein Draft-Jahrgang,
      // kein Rosterstatus. Der Namensabgleich wuerde sonst zufaellig Spieler
      // treffen (ein "Denver Broncos" ist keine reale Person mit Geburtsdatum).
      const bio = pos === 'DST' ? {} : (bioById.get(r.id) || bioByName.get(key) || {});
      const rosterEntry = bio.gsisId ? statusByGsis.get(bio.gsisId) : null;
      const injuryLabel = rosterEntry ? INJURY_ABBR[rosterEntry.abbr] || null : null;
      const depthEntry = pos === 'RB' && bio.gsisId ? rbDepthByGsis.get(bio.gsisId) : null;
      return {
        age: bio.age ?? null,
        draftYear: bio.draftYear ?? null,
        draftPick: bio.draftPick ?? null,
        market: marketByName.get(key) ?? null,
        id: `${key.replace(/ /g, '-')}-${pos}`.toLowerCase(),
        name: r.player,
        pos,
        team,
        bye: num(r.bye) ?? teams[team]?.bye ?? 0,
        ecr: ecrValue,
        sd: num(r.sd) ?? 0,
        best: num(r.best) ?? null,
        worst: num(r.worst) ?? null,
        rankDelta: num(r.rank_delta),
        owned: num(r.player_owned_avg),
        ecrRedraft: redraftByName.get(key) ?? null,
        rookie: rookieNames.has(key) || bio.draftYear === SEASON,
        priorPoints: priorEntry ? Number(priorEntry.points.toFixed(1)) : null,
        priorPosRank: priorEntry ? priorEntry.posRank : null,
        prior2Points: prior2Entry ? Number(prior2Entry.points.toFixed(1)) : null,
        prior2PosRank: prior2Entry ? prior2Entry.posRank : null,
        // Rosterstatus zum Zeitpunkt des Datenabrufs (siehe meta.rosterStatusDate).
        rosterStatus: rosterEntry?.status ?? null,
        injuryReserve: injuryLabel !== null,
        injuryLabel,
        // Nur fuer RB belegt: Platz in der aktuellen Tiefenaufstellung.
        depthRank: depthEntry ? depthEntry.posRank : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ecr - b.ecr);

  // Positionsrang aus der Dynasty-Reihenfolge ableiten.
  const posCount = {};
  for (const p of players) {
    posCount[p.pos] = (posCount[p.pos] || 0) + 1;
    p.posRank = posCount[p.pos];
    p.proj = Number(pointsForRank(curves[p.pos] || [], p.posRank).toFixed(1));
  }

  /* ---- 6. Bewertung ---- */
  const replacement = {};
  for (const [pos, factor] of Object.entries(REPLACEMENT)) {
    const rank = Math.max(1, Math.round(LEAGUE.teams * factor));
    replacement[pos] = Number(pointsForRank(curves[pos] || [], rank).toFixed(1));
  }
  for (const p of players) p.vor = Number((p.proj - (replacement[p.pos] ?? 0)).toFixed(1));

  // Die Expertenrangliste ist die Basis, nicht die Punktekurve: sie buendelt
  // mehr als hundert Meinungen. Offense und Spielplan verschieben sie, sie
  // ersetzen sie nicht. VOR und Projektion bleiben als Einordnung erhalten.
  for (const p of players) {
    const info = teams[p.team];
    p.offenseIndex = info && p.pos !== 'DST' ? info.offenseIndex : 0;
    p.sosIndex = info && p.pos !== 'DST' ? info.sosIndex : 0;
    p.impliedSeason = info ? info.impliedSeason : null;
    p.impliedPlayoffs = info ? info.impliedPlayoffs : null;
    const base = draftValue(p.ecr);
    const adjust = clamp(1 + WEIGHTS.offense * p.offenseIndex + WEIGHTS.sos * p.sosIndex, 0.7, 1.3);
    p.adjust = Number(adjust.toFixed(3));
    p.score = Number((100 * base * adjust).toFixed(1));
  }

  players.sort((a, b) => b.score - a.score || a.ecr - b.ecr);
  players.forEach((p, i) => {
    p.rank = i + 1;
    p.round = Math.floor(i / LEAGUE.teams) + 1;
    p.pickInRound = (i % LEAGUE.teams) + 1;
    // Positiv: der Markt laesst ihn spaeter fallen, als das Board ihn sieht.
    p.value = p.ecr !== null ? Number((p.ecr - (i + 1)).toFixed(1)) : null;
  });

  const posRanks = {};
  for (const p of players) {
    posRanks[p.pos] = (posRanks[p.pos] || 0) + 1;
    p.boardPosRank = posRanks[p.pos];
    p.handcuff = false;
    p.handcuffFor = null;
  }

  /**
   * Handcuff: der Running Back auf Tiefenplatz 2 hinter einem Starter, der
   * selbst startbar ist (Board-Rang bis 90) — faellt der Starter aus, uebernimmt
   * dieser Spieler die Rolle. Erst ab Board-Rang 150 markiert, sonst waere der
   * Spieler ohnehin schon aus eigenem Recht gefragt und keine Spaetrunden-Wette.
   */
  const rbByTeam = new Map();
  for (const p of players) {
    if (p.pos !== 'RB' || p.depthRank === null) continue;
    if (!rbByTeam.has(p.team)) rbByTeam.set(p.team, []);
    rbByTeam.get(p.team).push(p);
  }
  const HANDCUFF_STARTER_MAX_RANK = 90;
  const HANDCUFF_MIN_OWN_RANK = 150;
  const handcuffs = [];
  for (const list of rbByTeam.values()) {
    const starter = list.find((p) => p.depthRank === 1);
    const backup = list.find((p) => p.depthRank === 2);
    if (!starter || !backup) continue;
    if (starter.rank <= HANDCUFF_STARTER_MAX_RANK && backup.rank > HANDCUFF_MIN_OWN_RANK) {
      backup.handcuff = true;
      backup.handcuffFor = starter.name;
      handcuffs.push(backup.id);
    }
  }

  // Marktrang aus dem Handelswert. Positive Abweichung heisst: der Markt
  // handelt ihn spaeter, als die Experten ihn einordnen — ein Schnaeppchen.
  const withMarket = players.filter((p) => p.market !== null)
    .sort((a, b) => b.market - a.market);
  withMarket.forEach((p, i) => { p.marketRank = i + 1; });
  const ecrOrder = [...players].sort((a, b) => a.ecr - b.ecr);
  ecrOrder.forEach((p, i) => { p.ecrRank = i + 1; });
  for (const p of players) {
    p.marketDelta = p.marketRank ? p.marketRank - p.ecrRank : null;
  }

  assignTiers(players, (p) => p.pos);
  assignTiers(players, () => 'ALL', 'overallTier');

  /* ---- 7. Sonderlisten ---- */
  const breakouts = players
    .filter((p) => (p.rookie || (p.priorPosRank === null && p.pos !== 'DST') || (p.priorPosRank ?? 999) > 30)
      && p.rank > LEAGUE.teams * 4)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 40)
    .map((p) => p.id);

  // Redraft-Positionsrang je Spieler — dient als sekundaeres, schwaecheres
  // Signal (siehe unten) und bleibt fuer die Detailansicht erhalten.
  const redraftPosRank = new Map();
  const redraftCounter = {};
  for (const r of [...redraft].sort((a, b) => (num(a.ecr) ?? 1e9) - (num(b.ecr) ?? 1e9))) {
    const pos = r.pos === 'DST' ? 'DST' : r.pos;
    redraftCounter[pos] = (redraftCounter[pos] || 0) + 1;
    redraftPosRank.set(nameKey(r.player), { pos, rank: redraftCounter[pos] });
  }
  for (const p of players) {
    const entry = redraftPosRank.get(nameKey(p.name));
    if (entry && entry.pos === p.pos) p.redraftPosRank = entry.rank;
  }

  /**
   * Versteckte Werte: letzte Saison unter den Top 30 der Position, jetzt
   * aber ohne Team oder von der eigenen Liga ausgeschlossen sind sie nicht
   * brauchbar — deshalb der harte Filter auf ein aktuelles Team und einen
   * aktiven Rosterstatus.
   *
   * Primaeres Kriterium ist ein echtes Signal: der Rosterstatus zeigt den
   * Spieler auf der Reserve-Liste (verletzt, PUP, NFI) — er faellt aktuell
   * aus und startet die Saison verspaetet. Das ersetzt die reine Annahme aus
   * der Vorversion, ein Ranking-Absturz in der Redraft-Liste bedeute
   * automatisch eine Verletzung: er kann ebenso gut einen Rollenverlust ohne
   * Verletzung bedeuten. Nur wenn kein Rosterstatus vorliegt (Datei nicht
   * geladen oder kein gsis-Treffer), greift dieser Redraft-Vergleich ersatzweise.
   */
  const hasCurrentTeam = (p) => p.team !== 'FA';
  const isRosterable = (p) => p.rosterStatus !== 'RET' && p.rosterStatus !== 'CUT';
  const wasStarter = (p) => (p.priorPosRank !== null && p.priorPosRank <= 30)
    || (p.prior2PosRank !== null && p.prior2PosRank <= 30);
  const isSkillPos = (p) => p.pos !== 'K' && p.pos !== 'DST';

  const injured = players.filter((p) => isSkillPos(p) && wasStarter(p) && p.injuryReserve
    && hasCurrentTeam(p) && isRosterable(p));

  const fallback = players
    .map((p) => {
      if (!isSkillPos(p) || !wasStarter(p) || p.injuryReserve) return null;
      if (!hasCurrentTeam(p) || !isRosterable(p)) return null;
      if (p.rosterStatus !== null && p.rosterStatus !== 'ACT') return null; // Status bekannt, aber kein Verletzungscode
      if (p.priorPosRank === null || p.redraftPosRank === undefined) return null;
      const gap = p.redraftPosRank - p.priorPosRank;
      return gap >= 8 ? { p, gap } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.gap - a.gap)
    .map((x) => { x.p.discountGap = x.gap; return x.p; });

  const discount = [...injured, ...fallback].slice(0, 40).map((p) => p.id);

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      season: SEASON,
      priorSeason: PRIOR,
      scrapeDate,
      rankingBasis: 'dynasty',
      league: LEAGUE,
      weights: WEIGHTS,
      playoffWeeks: PLAYOFF_WEEKS,
      replacement,
      lineGames: observations.length / 2,
      kdstScale: KDST_SCALE,
      hasRosterStatus: statusByGsis.size > 0,
      hasDepthCharts: rbDepthByGsis.size > 0,
      injuredCount: players.filter((p) => p.injuryReserve).length,
      handcuffCount: handcuffs.length,
      sources: [
        { name: 'FantasyPros ECR via DynastyProcess', url: 'https://github.com/dynastyprocess/data', date: scrapeDate },
        { name: 'NFL-Spielplan und Quoten via nflverse', url: 'https://github.com/nflverse/nfldata', date: null },
        { name: `Fantasy-Punkte ${PRIOR} via hvpkod`, url: 'https://github.com/hvpkod/NFL-Data', date: null },
        {
          name: 'Rosterstatus und Tiefenaufstellung via nflverse-data',
          url: 'https://github.com/nflverse/nflverse-data',
          date: null,
        },
      ],
    },
    teams,
    players,
    lists: { breakouts, discount, handcuffs },
  };

  const target = join(ROOT, 'assets', 'data', 'board.json');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(out));
  return { out, target };
}

/** Tiers entstehen dort, wo der Abstand zum naechsten Spieler ungewoehnlich gross ist. */
export function assignTiers(players, groupOf, field = 'tier') {
  const groups = new Map();
  for (const p of players) {
    const g = groupOf(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  for (const list of groups.values()) {
    if (list.length < 3) { list.forEach((p) => { p[field] = 1; }); continue; }
    const gaps = [];
    for (let i = 1; i < list.length; i += 1) gaps.push(list[i - 1].score - list[i].score);
    const cut = mean(gaps) + stdev(gaps);
    let tier = 1;
    list[0][field] = 1;
    for (let i = 1; i < list.length; i += 1) {
      if (gaps[i - 1] > cut && gaps[i - 1] > 0.3) tier += 1;
      list[i][field] = tier;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { out, target } = await main();
  console.log(`${out.players.length} Spieler → ${target}`);
  console.log(`Quelle vom ${out.meta.scrapeDate}, ${out.meta.lineGames} Spiele mit Quoten`);
}

export { main };
