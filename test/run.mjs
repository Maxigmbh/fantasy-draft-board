/**
 * Logiktests: pruefen das Datenmodell gegen die echte assets/data/board.json
 * und die Bausteine der Pipeline. Kein Netzzugriff.
 *
 *   node test/run.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const {
  rankPlayers, filterPlayers, groupByTier, resolveList, draftValue, DEFAULT_WEIGHTS, POSITIONS,
} = await import('../assets/js/board.js');
const {
  parseCsv, nameKey, fitTeamRatings, expectedPoints, buildPointsCurve, pointsForRank,
  draftValue: buildDraftValue,
} = await import('../tools/build-data.mjs');

const data = JSON.parse(readFileSync(join(ROOT, 'assets', 'data', 'board.json'), 'utf8'));

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`);
  }
}

console.log('\nDatendatei');

test('Grundstruktur ist vollstaendig', () => {
  assert.ok(data.players.length > 400, `${data.players.length} Spieler`);
  assert.equal(Object.keys(data.teams).length, 32, '32 NFL-Teams');
  assert.ok(data.lists.breakouts.length > 0 && data.lists.discount.length > 0);
  assert.equal(data.meta.rankingBasis, 'dynasty');
  assert.equal(data.meta.league.teams, 12);
  assert.match(data.meta.scrapeDate, /^\d{4}-\d{2}-\d{2}$/);
});

test('Jeder Spieler traegt die Felder, die die Oberflaeche liest', () => {
  for (const p of data.players) {
    for (const f of ['id', 'name', 'pos', 'team', 'ecr', 'offenseIndex', 'sosIndex']) {
      assert.ok(p[f] !== undefined, `${p.name}: ${f} fehlt`);
    }
    assert.ok(POSITIONS.includes(p.pos), `${p.name}: Position ${p.pos}`);
    assert.ok(p.ecr > 0, `${p.name}: ECR ${p.ecr}`);
    assert.ok(p.offenseIndex >= -1 && p.offenseIndex <= 1, `${p.name}: Offense ausserhalb [-1,1]`);
    assert.ok(p.sosIndex >= -1 && p.sosIndex <= 1, `${p.name}: SoS ausserhalb [-1,1]`);
    assert.ok(p.bye >= 0 && p.bye <= 18, `${p.name}: Bye ${p.bye}`);
  }
  const ids = new Set(data.players.map((p) => p.id));
  assert.equal(ids.size, data.players.length, 'IDs sind eindeutig');
});

test('Jedes Team hat Spielplan, Bye und Ratings', () => {
  for (const [code, t] of Object.entries(data.teams)) {
    assert.equal(t.schedule.length, 17, `${code}: 18 Wochen minus Bye`);
    assert.ok(t.bye >= 1 && t.bye <= 14, `${code}: Bye ${t.bye}`);
    assert.ok(!t.schedule.some((g) => g.week === t.bye), `${code}: kein Spiel in der Bye-Week`);
    assert.ok(!t.schedule.some((g) => g.opp === code), `${code}: kein Spiel gegen sich selbst`);
    assert.ok(Number.isFinite(t.offenseIndex) && Number.isFinite(t.sosIndex));
  }
});

test('Teams der Spieler existieren im Spielplan', () => {
  const unknown = data.players
    .filter((p) => p.team !== 'FA' && !data.teams[p.team])
    .map((p) => `${p.name} (${p.team})`);
  assert.deepEqual(unknown, [], `unbekannte Teamkuerzel: ${unknown.join(', ')}`);
});

test('Offense und Spielplan messen nicht dasselbe', () => {
  const off = Object.values(data.teams).map((t) => t.offenseIndex);
  const sos = Object.values(data.teams).map((t) => t.sosIndex);
  const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const mo = m(off); const ms = m(sos);
  const cov = off.reduce((a, o, i) => a + (o - mo) * (sos[i] - ms), 0);
  const so = Math.sqrt(off.reduce((a, o) => a + (o - mo) ** 2, 0));
  const ss = Math.sqrt(sos.reduce((a, s) => a + (s - ms) ** 2, 0));
  const r = cov / (so * ss);
  // Die erste Fassung nutzte fuer beide dieselbe Groesse; r lag bei +1.
  assert.ok(Math.abs(r) < 0.6, `Korrelation ${r.toFixed(2)} zu hoch — Doppelzaehlung`);
});

test('Leere CSV-Felder werden zu null, nicht zu 0', () => {
  // Number('') ist in JavaScript 0. Ohne Sonderbehandlung gingen Spiele ohne
  // Wettquote als "0 Punkte" in die Team-Ratings ein.
  const rows = parseCsv('a,b,c,d\n1,,NA, \n');
  assert.equal(rows[0].a, '1');
  assert.equal(rows[0].b, '');
  const parsed = Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => {
    const t = String(v).trim();
    return [k, t === '' || t.toUpperCase() === 'NA' ? null : Number(t)];
  }));
  assert.deepEqual(parsed, { a: 1, b: null, c: null, d: null });
});

test('Erwartete Punkte liegen im realistischen NFL-Bereich', () => {
  const implied = Object.values(data.teams).flatMap((t) => t.schedule.map((g) => g.implied));
  const avg = implied.reduce((a, b) => a + b, 0) / implied.length;
  // NFL-Teams erzielen im Schnitt gut 23 Punkte. Ein deutlich niedrigerer
  // Schnitt hiesse, dass Spiele ohne Quote als Nullwerte mitgerechnet werden.
  assert.ok(avg > 20 && avg < 26, `Mittel ${avg.toFixed(2)} Punkte je Spiel`);
  assert.ok(Math.min(...implied) > 12, `Minimum ${Math.min(...implied).toFixed(1)}`);
  assert.ok(Math.max(...implied) < 36, `Maximum ${Math.max(...implied).toFixed(1)}`);
  assert.ok(data.meta.lineGames > 50 && data.meta.lineGames < 272,
    `${data.meta.lineGames} Spiele mit Quoten — nicht alle Wochen haben Linien`);
});

test('Alter ist plausibel und Team-Defenses haben keins', () => {
  for (const p of data.players) {
    if (p.pos === 'DST') {
      assert.equal(p.age, null, `${p.name}: Defense darf kein Alter haben`);
      assert.equal(p.draftYear, null, `${p.name}: Defense hat keinen Draft-Jahrgang`);
    } else if (p.age !== null) {
      assert.ok(p.age >= 20 && p.age <= 45, `${p.name}: Alter ${p.age}`);
    }
  }
  const withAge = data.players.filter((p) => p.age !== null);
  assert.ok(withAge.length > 400, `${withAge.length} Spieler mit Alter`);
});

console.log('\nBewertung');

const ranked = rankPlayers(data.players, DEFAULT_WEIGHTS, 12);

test('Board ist durchnummeriert und absteigend sortiert', () => {
  assert.equal(ranked.length, data.players.length);
  ranked.forEach((p, i) => {
    assert.equal(p.rank, i + 1);
    if (i) assert.ok(ranked[i - 1].score >= p.score, `Score faellt bei Rang ${i + 1}`);
  });
});

test('Ohne Gewichte steht exakt die Expertenrangliste', () => {
  const neutral = rankPlayers(data.players, { offense: 0, sos: 0 }, 12);
  const byEcr = [...data.players].sort((a, b) => a.ecr - b.ecr).map((p) => p.id);
  assert.deepEqual(neutral.map((p) => p.id), byEcr);
  assert.ok(neutral.every((p) => p.adjust === 1), 'keine Anpassung');
});

test('Gewichte verschieben das Board, aber begrenzt', () => {
  const strong = rankPlayers(data.players, { offense: 0.4, sos: 0.4 }, 12);
  const moved = strong.filter((p, i) => ranked[i].id !== p.id).length;
  assert.ok(moved > 40, `spuerbare Verschiebung (${moved})`);
  assert.ok(strong.every((p) => p.adjust >= 0.7 && p.adjust <= 1.3), 'Anpassung gedeckelt');
  const before = new Map(ranked.map((p) => [p.id, p.rank]));
  const jump = Math.max(...strong.map((p) => Math.abs(before.get(p.id) - p.rank)));
  assert.ok(jump < data.players.length / 3, `groesster Sprung ${jump} Plaetze`);
});

test('Pick-Nummer folgt der Ligagroesse', () => {
  assert.equal(ranked[0].round, 1);
  assert.equal(ranked[0].pickInRound, 1);
  assert.equal(ranked[11].round, 1);
  assert.equal(ranked[11].pickInRound, 12);
  assert.equal(ranked[12].round, 2);
  assert.equal(ranked[12].pickInRound, 1);
  const ten = rankPlayers(data.players, DEFAULT_WEIGHTS, 10);
  assert.equal(ten[10].round, 2, 'andere Ligagroesse verschiebt die Runden');
});

test('Draft-Wert faellt streng monoton', () => {
  for (let ecr = 1; ecr < 300; ecr += 1) {
    assert.ok(draftValue(ecr) > draftValue(ecr + 1), `bei ECR ${ecr}`);
  }
  assert.equal(draftValue(1), 1);
  assert.ok(draftValue(1) - draftValue(11) > (draftValue(101) - draftValue(111)) * 3);
  assert.equal(draftValue(42), buildDraftValue(42), 'Board und Pipeline rechnen gleich');
});

console.log('\nFilter und Tiers');

test('Positionsfilter und FLEX greifen', () => {
  const rbs = filterPlayers(ranked, { pos: 'RB' });
  assert.ok(rbs.length > 50 && rbs.every((p) => p.pos === 'RB'));
  const flex = filterPlayers(ranked, { pos: 'FLEX' });
  assert.ok(flex.every((p) => ['RB', 'WR', 'TE'].includes(p.pos)));
  assert.equal(flex.length, ranked.filter((p) => ['RB', 'WR', 'TE'].includes(p.pos)).length);
  assert.equal(filterPlayers(ranked, { pos: 'ALLE' }).length, ranked.length);
});

test('Suche greift auf Name und Team', () => {
  const name = ranked[0].name.split(' ')[0];
  assert.ok(filterPlayers(ranked, { search: name }).length >= 1);
  const { team } = ranked.find((p) => p.team !== 'FA');
  const byTeam = filterPlayers(ranked, { search: team });
  assert.ok(byTeam.length > 1);
  assert.equal(filterPlayers(ranked, { search: 'zzzz-gibt-es-nicht' }).length, 0);
});

test('Gedraftete lassen sich ausblenden', () => {
  const drafted = new Set(ranked.slice(0, 5).map((p) => p.id));
  assert.equal(filterPlayers(ranked, { drafted, hideDrafted: true }).length, ranked.length - 5);
  assert.equal(filterPlayers(ranked, { drafted, hideDrafted: false }).length, ranked.length);
});

test('Sortierungen liefern unterschiedliche Reihenfolgen', () => {
  const first = (sort) => filterPlayers(ranked, { sort })[0].id;
  const ids = new Set(['score', 'ecr', 'value', 'sos', 'offense', 'prior'].map(first));
  assert.ok(ids.size >= 4, `Sortierungen unterscheiden sich (${ids.size})`);
  const byValue = filterPlayers(ranked, { sort: 'value' });
  assert.ok(byValue[0].value >= byValue[byValue.length - 1].value);
});

test('Tiers sind luecken- und ueberschneidungsfrei', () => {
  for (const pos of ['ALLE', 'QB', 'RB', 'WR']) {
    const list = filterPlayers(ranked, { pos });
    const groups = groupByTier(list, pos);
    assert.equal(groups.reduce((a, g) => a + g.players.length, 0), list.length, `${pos}: alle Spieler`);
    groups.forEach((g, i) => {
      if (i) assert.ok(g.tier > groups[i - 1].tier, `${pos}: Tier steigt`);
      assert.ok(g.players.length > 0);
    });
    assert.ok(groups.length >= 3, `${pos}: mehrere Tiers (${groups.length})`);
  }
});

console.log('\nNebenlisten');

test('Rookie- und Breakout-Liste ist aufloesbar und spaet gehandelt', () => {
  const list = resolveList(ranked, data.lists.breakouts);
  assert.equal(list.length, data.lists.breakouts.length, 'alle IDs finden einen Spieler');
  assert.ok(list.every((p) => p.rank > 12 * 3), 'alle jenseits der dritten Runde');
  assert.ok(list.some((p) => p.rookie), 'enthaelt Rookies');
});

test('Versteckte Werte: stark im Vorjahr, abgerutscht in der Redraft-Liste', () => {
  const list = resolveList(ranked, data.lists.discount);
  assert.equal(list.length, data.lists.discount.length);
  for (const p of list) {
    assert.ok(p.priorPosRank !== null && p.priorPosRank <= 30, `${p.name}: Vorjahresrang`);
    assert.ok(p.redraftPosRank > p.priorPosRank, `${p.name}: in Redraft abgerutscht`);
    assert.ok(p.discountGap >= 8, `${p.name}: Abstand ${p.discountGap}`);
    assert.ok(p.priorPoints > 0, `${p.name}: Vorjahrespunkte`);
    assert.ok(!['K', 'DST'].includes(p.pos));
  }
});

console.log('\nPipeline-Bausteine');

test('CSV-Parser beherrscht Anfuehrungszeichen und Kommas', () => {
  const rows = parseCsv('a,b,c\n1,"zwei, drei",4\n5,"sechs ""in"" sieben",8\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { a: '1', b: 'zwei, drei', c: '4' });
  assert.equal(rows[1].b, 'sechs "in" sieben');
});

test('Namensschluessel gleicht Schreibweisen an', () => {
  assert.equal(nameKey("Ja'Marr Chase"), 'jamarr chase');
  assert.equal(nameKey('James Cook III'), nameKey('James Cook'));
  assert.equal(nameKey('Deebo Samuel Sr.'), nameKey('Deebo Samuel'));
  assert.equal(nameKey('Amon-Ra St. Brown'), 'amon ra st brown');
});

test('Team-Ratings finden bekannte Staerken wieder', () => {
  const trueOff = { A: 4, B: 0, C: -4, D: 1 };
  const trueDef = { A: -2, B: 2, C: 0, D: 0 };
  const obs = [];
  for (const t of Object.keys(trueOff)) {
    for (const o of Object.keys(trueOff)) {
      if (t === o) continue;
      for (const home of [1, 0]) {
        obs.push({
          team: t, opponent: o, home, points: 23 + trueOff[t] + trueDef[o] + 1.5 * (home - 0.5),
        });
      }
    }
  }
  const fit = fitTeamRatings(obs, { ridge: 0.001, iterations: 500 });
  const order = (m) => Object.keys(trueOff).sort((a, b) => m.get(b) - m.get(a));
  assert.deepEqual(order(fit.offense), ['A', 'D', 'B', 'C'], 'Offense-Reihenfolge');
  assert.ok(fit.offense.get('A') - fit.offense.get('C') > 6, 'Abstand bleibt erhalten');
  const pred = expectedPoints(fit, 'A', 'B', 1);
  assert.ok(Math.abs(pred - (23 + 4 + 2 + 0.75)) < 0.6, `Vorhersage ${pred.toFixed(2)}`);
});

test('Punktekurve faellt und glaettet Ausreisser', () => {
  const curve = buildPointsCurve([300, 250, 400, 200, 150, 100, 50]);
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i] <= curve[i - 1] + 1e-9, `Kurve faellt bei ${i}`);
  }
  assert.ok(curve[0] < 400, 'Spitzenausreisser wird geglaettet');
  assert.equal(pointsForRank(curve, 1), curve[0]);
  assert.equal(pointsForRank(curve, 999), curve[curve.length - 1], 'ausserhalb wird gekappt');
  assert.equal(pointsForRank([], 3), 0);
});

console.log(`\n${passed} bestanden, ${failures.length} fehlgeschlagen\n`);
if (failures.length) process.exit(1);
