/**
 * Testlauf ohne Netzzugriff: prüft Parser, Bewertungsmodell, Draft-Zustand
 * und den Bookmarklet-Generator gegen synthetische ESPN-Payloads.
 *
 *   node test/run.mjs
 */

import assert from 'node:assert/strict';

// --- Minimale Browser-Umgebung, damit state.js importierbar ist. ------------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.location = {
  origin: 'https://beispiel.github.io',
  pathname: '/fahrstuhlsimulator/fantasy-board/',
  hash: '',
};
globalThis.history = { replaceState(_a, _b, hash) { globalThis.location.hash = hash; } };

const {
  parseSettings, parsePlayers, parseSchedule, parsePositionalRatings, parseDraft,
  positionOf, projectedPoints, healthFactor, POSITIONS,
} = await import('../assets/js/espn.js');
const {
  buildBoard, replacementRanks, scheduleStrength, positionalLeagueAverage, DEFAULT_WEIGHTS,
} = await import('../assets/js/model.js');
const {
  DraftState, buildBookmarklet, buildConsoleSnippet, detectEspnPayload, espnDirectUrls,
} = await import('../assets/js/sync.js');
const { shareUrl, readHash, exportState, importState } = await import('../assets/js/state.js');
const fx = await import('./fixtures.mjs');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const SEASON = fx.SEASON;
const settings = parseSettings(fx.makeSettingsResponse({ teams: 10 }));
const players = parsePlayers(fx.makePlayersResponse({ season: SEASON }), SEASON);
const schedule = parseSchedule(fx.makeScheduleResponse({ season: SEASON }));
const ratings = parsePositionalRatings(fx.makeRatingsResponse());

console.log('\nParser');

test('Liga-Einstellungen werden korrekt gelesen', () => {
  assert.equal(settings.teams, 10);
  assert.equal(settings.ppr, 1);
  assert.deepEqual(settings.starters, { QB: 1, RB: 2, WR: 2, TE: 1, 'D/ST': 1, K: 1, FLEX: 1 });
  assert.deepEqual(settings.playoffWeeks, [15, 16, 17]);
  assert.equal(settings.benchSlots, 7);
});

test('Spielerpool: 32 Teams × 18 Spieler, alle Positionen sauber erkannt', () => {
  assert.equal(players.length, 32 * 18);
  const counts = {};
  for (const p of players) counts[p.pos] = (counts[p.pos] || 0) + 1;
  assert.deepEqual(counts, { QB: 64, RB: 160, WR: 192, TE: 96, K: 32, 'D/ST': 32 });
  assert.ok(players.every((p) => p.projection > 0), 'jede Projektion > 0');
  assert.ok(players.every((p) => p.team && p.team !== 'FA'), 'jedes Team aufgelöst');
  assert.ok(players.every((p) => p.adp > 0), 'ADP vorhanden');
});

test('Position kommt aus eligibleSlots, nicht aus defaultPositionId', () => {
  assert.equal(positionOf({ eligibleSlots: [2, 23], defaultPositionId: 99 }), 'RB');
  assert.equal(positionOf({ eligibleSlots: [4, 23] }), 'WR');
  assert.equal(positionOf({ eligibleSlots: [6, 23] }), 'TE');
  assert.equal(positionOf({ eligibleSlots: [0] }), 'QB');
  assert.equal(positionOf({ eligibleSlots: [16] }), 'D/ST');
  assert.equal(positionOf({ eligibleSlots: [17] }), 'K');
  // Ohne eligibleSlots greift der Fallback.
  assert.equal(positionOf({ defaultPositionId: 3 }), 'WR');
  assert.equal(positionOf({}), null);
});

test('Projektion bevorzugt die Saisonprognose, sonst die Vorsaison', () => {
  const withProj = {
    stats: [
      { seasonId: SEASON, statSourceId: 1, statSplitTypeId: 0, appliedTotal: 250 },
      { seasonId: SEASON - 1, statSourceId: 0, statSplitTypeId: 0, appliedTotal: 100 },
    ],
  };
  assert.equal(projectedPoints(withProj, SEASON), 250);
  const onlyLastYear = {
    stats: [{ seasonId: SEASON - 1, statSourceId: 0, statSplitTypeId: 0, appliedTotal: 111 }],
  };
  assert.equal(projectedPoints(onlyLastYear, SEASON), 111);
  assert.equal(projectedPoints({}, SEASON), 0);
});

test('Spielplan: 32 Teams mit Bye-Week und je 16 Spielen', () => {
  assert.equal(Object.keys(schedule).length, 32);
  for (const team of Object.values(schedule)) {
    assert.ok(team.byeWeek >= 1 && team.byeWeek <= 18, 'Bye-Week gesetzt');
    const weeks = Object.keys(team.opponents).map(Number);
    assert.equal(weeks.length, 16, `${team.abbrev}: 17 Wochen minus Bye`);
    assert.ok(!weeks.includes(team.byeWeek), 'kein Spiel in der Bye-Week');
    assert.ok(weeks.every((w) => team.opponents[w].opponentId !== team.id), 'kein Spiel gegen sich selbst');
  }
});

test('Defense-Ratings werden auf Positionsnamen abgebildet', () => {
  assert.deepEqual(Object.keys(ratings).sort(), [...POSITIONS].sort());
  for (const pos of POSITIONS) {
    assert.equal(Object.keys(ratings[pos]).length, 32, `${pos}: 32 Gegner`);
  }
});

test('Draft-Antwort liefert Picks und Teamnamen', () => {
  const ids = players.slice(0, 30).map((p) => p.id);
  const draft = parseDraft(fx.makeDraftResponse({ picks: 25, teams: 10, playerIds: ids }));
  assert.equal(draft.picks.length, 25);
  assert.equal(draft.inProgress, true);
  assert.equal(draft.picks[0].overall, 1);
  assert.equal(draft.picks[10].round, 2);
  assert.equal(draft.teamNames[3], 'Manager 3');
});

test('Parser überleben leere und kaputte Antworten', () => {
  assert.deepEqual(parsePlayers({}, SEASON), []);
  assert.deepEqual(parsePlayers({ players: [{}, { player: {} }] }, SEASON), []);
  assert.deepEqual(parseSchedule({}), {});
  assert.deepEqual(parsePositionalRatings({}), {});
  assert.deepEqual(parseDraft({}).picks, []);
  assert.equal(parseSettings({}).teams, 10);
});

console.log('\nBewertungsmodell');

const board = buildBoard({
  players, schedule, ratings, teams: 10, starters: settings.starters,
  weights: { ...DEFAULT_WEIGHTS, playoffWeeks: settings.playoffWeeks },
});

test('Replacement-Level folgt Ligagröße und Startaufstellung', () => {
  const ranks = replacementRanks(10, settings.starters);
  assert.deepEqual(ranks, { QB: 13, RB: 34, WR: 34, TE: 14, K: 10, 'D/ST': 11 });
  // 12er-Liga braucht mehr Spieler, bevor das Replacement-Level greift.
  const bigger = replacementRanks(12, settings.starters);
  for (const pos of POSITIONS) assert.ok(bigger[pos] > ranks[pos], `${pos} skaliert mit der Ligagröße`);
});

test('Board ist vollständig, absteigend sortiert und durchnummeriert', () => {
  assert.equal(board.players.length, players.length);
  for (let i = 1; i < board.players.length; i += 1) {
    assert.ok(board.players[i - 1].score >= board.players[i].score, 'Score absteigend');
    assert.equal(board.players[i].rank, i + 1, 'Rang lückenlos');
  }
});

test('Positionsränge sind je Position lückenlos und folgen dem Score', () => {
  for (const pos of POSITIONS) {
    const list = board.players.filter((p) => p.pos === pos);
    list.forEach((p, i) => assert.equal(p.posRank, i + 1, `${pos}-Rang ${i + 1}`));
  }
});

test('Tiers starten bei 1 und wachsen monoton', () => {
  for (const pos of POSITIONS) {
    const list = board.players.filter((p) => p.pos === pos);
    assert.equal(list[0].tier, 1);
    for (let i = 1; i < list.length; i += 1) {
      const step = list[i].tier - list[i - 1].tier;
      assert.ok(step === 0 || step === 1, `${pos}: Tier springt um ${step}`);
    }
    assert.ok(list.at(-1).tier > 1, `${pos}: mehr als ein Tier`);
  }
});

test('Ohne Gewichte entspricht die Reihenfolge exakt dem VOR', () => {
  const neutral = buildBoard({
    players, schedule, ratings, teams: 10, starters: settings.starters,
    weights: { offense: 0, sos: 0, health: 0, market: 0, playoffBoost: 1 },
  });
  const byVor = [...neutral.players].sort((a, b) => b.vor - a.vor || b.projection - a.projection);
  assert.deepEqual(neutral.players.map((p) => p.id), byVor.map((p) => p.id));
});

test('Verletzung senkt den Score gegenüber sonst identischem Spieler', () => {
  const base = {
    id: 1, name: 'Fit', pos: 'RB', teamId: 6, team: 'DAL', eligibleSlots: [2, 23],
    projection: 220, adp: 10, percentOwned: 90, espnRankPpr: 10, espnRankStd: 10,
    injuryStatus: 'ACTIVE', injured: false, onTeamId: 0,
  };
  const pair = buildBoard({
    players: [base, { ...base, id: 2, name: 'Out', injuryStatus: 'OUT', injured: true }],
    schedule, ratings, teams: 10, starters: settings.starters,
    weights: { ...DEFAULT_WEIGHTS, offense: 0, sos: 0 },
  });
  const fit = pair.players.find((p) => p.id === 1);
  const out = pair.players.find((p) => p.id === 2);
  assert.ok(fit.score > out.score, 'fitter Spieler steht höher');
  assert.equal(fit.rank, 1);
  assert.ok(out.healthMult < 0.7, `Abschlag greift (${out.healthMult.toFixed(2)})`);
  assert.equal(healthFactor('INJURY_RESERVE'), 0.20);
  assert.equal(healthFactor(undefined), 1);
  assert.equal(healthFactor('VOELLIG_UNBEKANNT'), 0.85);
});

test('Strength of Schedule bleibt im definierten Wertebereich', () => {
  const leagueAvg = positionalLeagueAverage(ratings);
  let counted = 0;
  for (const p of board.players) {
    const sos = scheduleStrength(p, {
      schedule, ratings, leagueAvg, playoffWeeks: [15, 16, 17], playoffBoost: 2,
    });
    assert.ok(sos, `${p.name}: SoS berechenbar`);
    assert.equal(sos.games, 16, 'alle Spiele der Saison gewertet');
    assert.ok(sos.z >= -1 && sos.z <= 1, `z in [-1,1], war ${sos.z}`);
    assert.ok(Number.isFinite(sos.playoffRaw), 'Playoff-Wochen separat ausgewiesen');
    counted += 1;
  }
  assert.equal(counted, board.players.length);
});

test('Ein leichterer Spielplan hebt den Score, ein schwerer senkt ihn', () => {
  const leagueAvg = positionalLeagueAverage(ratings);
  const withSos = board.players.filter((p) => p.pos === 'WR');
  const easiest = withSos.reduce((a, b) => (a.sosZ > b.sosZ ? a : b));
  const hardest = withSos.reduce((a, b) => (a.sosZ < b.sosZ ? a : b));
  assert.ok(easiest.sosZ > hardest.sosZ, 'Spielpläne unterscheiden sich messbar');
  assert.ok(easiest.adjust > 1 && hardest.adjust < 1, 'Anpassungsfaktor folgt dem Spielplan');
  assert.ok(leagueAvg.WR > 0, 'Ligaschnitt vorhanden');
});

test('Höheres SoS-Gewicht verschiebt das Board messbar', () => {
  const soft = buildBoard({
    players, schedule, ratings, teams: 10, starters: settings.starters,
    weights: { ...DEFAULT_WEIGHTS, sos: 0 },
  });
  const hard = buildBoard({
    players, schedule, ratings, teams: 10, starters: settings.starters,
    weights: { ...DEFAULT_WEIGHTS, sos: 0.4 },
  });
  const moved = soft.players.filter((p, i) => hard.players[i].id !== p.id).length;
  assert.ok(moved > 20, `Reihenfolge ändert sich spürbar (${moved} Positionen)`);
});

test('Marktabgleich zieht das Board Richtung ESPN-ADP', () => {
  const pure = buildBoard({
    players, schedule, ratings, teams: 10, starters: settings.starters,
    weights: { ...DEFAULT_WEIGHTS, market: 0 },
  });
  const market = buildBoard({
    players, schedule, ratings, teams: 10, starters: settings.starters,
    weights: { ...DEFAULT_WEIGHTS, market: 0.6 },
  });
  const spread = (b) => {
    const top = b.players.slice(0, 50).map((p) => p.adp);
    return Math.max(...top) - Math.min(...top);
  };
  assert.ok(spread(market) <= spread(pure), 'Top 50 liegen näher an der ADP');
});

test('Board funktioniert auch ohne Spielplan und ohne Defense-Ratings', () => {
  const bare = buildBoard({ players, teams: 10, starters: settings.starters });
  assert.equal(bare.players.length, players.length);
  assert.ok(bare.players.every((p) => p.sos === null && p.sosZ === 0), 'SoS neutral');
  assert.ok(bare.players.every((p) => Number.isFinite(p.score)), 'Scores bleiben gültig');
  assert.equal(bare.meta.hasRatings, false);
});

test('Offense-Index ist für D/ST neutral und sonst gestreut', () => {
  const dst = board.players.filter((p) => p.pos === 'D/ST');
  assert.ok(dst.every((p) => p.offZ === 0), 'D/ST profitiert nicht von der eigenen Offense');
  const wr = board.players.filter((p) => p.pos === 'WR').map((p) => p.offZ);
  assert.ok(Math.max(...wr) > 0.2 && Math.min(...wr) < -0.2, 'Offense-Index streut über die Teams');
});

console.log('\nDraft-Abgleich');

test('ESPN-Picks werden übernommen, manuelle Markierungen bleiben erhalten', () => {
  const state = new DraftState();
  const ids = players.slice(0, 40).map((p) => p.id);
  state.toggleManual(999999, 0);
  const draft = parseDraft(fx.makeDraftResponse({ picks: 20, teams: 10, playerIds: ids }));
  assert.equal(state.applyEspnDraft(draft), true);
  assert.equal(state.count, 21);
  assert.equal(state.isDrafted(ids[0]), true);
  assert.equal(state.isDrafted(999999), true, 'manuelle Markierung überlebt');
  assert.equal(state.pickOf(ids[0]).source, 'espn');
  assert.equal(state.teamNames[1], 'Manager 1');
});

test('ESPN-Picks lassen sich nicht manuell überschreiben', () => {
  const state = new DraftState();
  const ids = players.slice(0, 10).map((p) => p.id);
  state.applyEspnDraft(parseDraft(fx.makeDraftResponse({ picks: 5, teams: 10, playerIds: ids })));
  assert.equal(state.toggleManual(ids[0]), false, 'Rückgabe signalisiert Ablehnung');
  assert.equal(state.isDrafted(ids[0]), true);
  assert.equal(state.toggleManual(ids[9]), true, 'freier Spieler ist umschaltbar');
  assert.equal(state.isDrafted(ids[9]), true);
  state.toggleManual(ids[9]);
  assert.equal(state.isDrafted(ids[9]), false, 'zweiter Klick nimmt zurück');
});

test('Ein neuer Draft-Stand meldet Änderungen und benachrichtigt Zuhörer', () => {
  const state = new DraftState();
  let calls = 0;
  state.onChange(() => { calls += 1; });
  const ids = players.slice(0, 40).map((p) => p.id);
  state.applyEspnDraft(parseDraft(fx.makeDraftResponse({ picks: 10, teams: 10, playerIds: ids })));
  assert.equal(state.applyEspnDraft(parseDraft(fx.makeDraftResponse({ picks: 10, teams: 10, playerIds: ids }))), false,
    'unveränderter Stand meldet keine Änderung');
  assert.equal(state.applyEspnDraft(parseDraft(fx.makeDraftResponse({ picks: 15, teams: 10, playerIds: ids }))), true);
  assert.equal(state.count, 15);
  assert.equal(calls, 3);
});

console.log('\nTeilen, Sichern und Bridge');

test('Teilen-Link und Hash-Auswertung sind verlustfrei', () => {
  const config = {
    season: 2026, leagueId: '1234567', rankType: 'PPR',
    weights: { offense: 0.2, sos: 0.25, health: 0.5, playoffBoost: 2.5, market: 0.1 },
  };
  const url = shareUrl(config);
  assert.ok(url.startsWith('https://beispiel.github.io/fahrstuhlsimulator/fantasy-board/#'));
  globalThis.location.hash = url.slice(url.indexOf('#'));
  const back = readHash();
  assert.equal(back.leagueId, '1234567');
  assert.equal(back.season, 2026);
  assert.deepEqual(back.weights, config.weights);
  globalThis.location.hash = '';
  assert.deepEqual(readHash(), {});
});

test('Export und Import stellen Konfiguration und Draft-Stand wieder her', () => {
  const state = new DraftState();
  state.toggleManual(4242, 3);
  const config = {
    season: 2026, leagueId: '77', proxy: 'https://geheim.example/?url=',
    rankType: 'PPR', myTeamId: 3, hideDrafted: true, onlyHealthy: false,
    autoSync: true, syncSeconds: 12, weights: { ...DEFAULT_WEIGHTS, sos: 0.31 },
  };
  const json = exportState(config, state);
  assert.ok(!json.includes('geheim.example'), 'Proxy-URL wandert nicht in den Export');
  const restored = importState(json);
  assert.equal(restored.config.leagueId, '77');
  assert.equal(restored.config.weights.sos, 0.31);
  assert.equal(restored.drafted.get(4242).teamId, 3);
  assert.throws(() => importState('{"version":99}'), /Unbekanntes Dateiformat/);
  assert.throws(() => importState('kein json'), /Unbekanntes Dateiformat/);
});

test('Bookmarklet ist gültig, zielgerichtet und kurz genug', () => {
  const href = buildBookmarklet({
    boardUrl: 'https://beispiel.github.io/fahrstuhlsimulator/fantasy-board/#season=2026',
    season: 2026,
    intervalMs: 12000,
  });
  assert.ok(href.startsWith('javascript:'), 'als Bookmarklet nutzbar');
  const code = decodeURIComponent(href.slice('javascript:'.length));
  assert.ok(code.includes("'https://beispiel.github.io'"), 'postMessage nur an die eigene Origin');
  assert.ok(code.includes('view=mDraftDetail'), 'pollt den Draft');
  assert.ok(code.includes('view=kona_player_info'), 'holt den Spielerpool');
  assert.ok(code.includes('view=proTeamSchedules_wl'), 'holt den Spielplan');
  assert.ok(code.includes('view=mPositionalRatings'), 'holt die Defense-Ratings');
  assert.ok(code.includes("credentials:'include'"), 'nutzt die ESPN-Anmeldung im ESPN-Tab');
  assert.ok(code.includes('setInterval(p,12000)'), 'Intervall wird durchgereicht');
  assert.ok(!code.includes('\n'), 'einzeilig');
  assert.ok(href.length < 8000, `Bookmarklet-Länge ${href.length} unter dem Browser-Limit`);
  // Die Bridge darf keine Anmeldedaten weiterreichen.
  assert.ok(!/espn_s2|SWID|document\.cookie/.test(code), 'keine Cookies im Transfer');
});

test('ESPN-Antworten werden am Inhalt erkannt', () => {
  const cases = [
    ['draft', fx.makeDraftResponse({ picks: 3, teams: 10, playerIds: [1, 2, 3] })],
    ['ratings', fx.makeRatingsResponse()],
    ['schedule', fx.makeScheduleResponse({})],
    ['players', fx.makePlayersResponse({})],
    ['settings', fx.makeSettingsResponse({})],
  ];
  for (const [expected, raw] of cases) {
    const got = detectEspnPayload(raw, SEASON);
    assert.ok(got, `${expected}: erkannt`);
    assert.equal(got.kind, expected);
  }
  // Der Spielplan bringt ebenfalls ein settings-Objekt mit — die Reihenfolge
  // der Pruefungen darf ihn nicht als Einstellungen missdeuten.
  assert.equal(detectEspnPayload(fx.makeScheduleResponse({}), SEASON).kind, 'schedule');
  assert.equal(detectEspnPayload({}, SEASON), null);
  assert.equal(detectEspnPayload(null, SEASON), null);
  assert.equal(detectEspnPayload('kein objekt', SEASON), null);
});

test('Erkannte Antworten liefern dieselben Daten wie der direkte Abruf', () => {
  const viaPaste = detectEspnPayload(fx.makePlayersResponse({}), SEASON).value;
  assert.deepEqual(viaPaste.map((p) => p.id), players.map((p) => p.id));
  const draftRaw = fx.makeDraftResponse({ picks: 8, teams: 10, playerIds: players.slice(0, 8).map((p) => p.id) });
  assert.equal(detectEspnPayload(draftRaw, SEASON).value.picks.length, 8);
});

test('Direktadressen zeigen auf die richtigen Views', () => {
  const urls = espnDirectUrls({ season: 2026, leagueId: '1234567' });
  const byKey = Object.fromEntries(urls.map((u) => [u.key, u]));
  assert.ok(byKey.draft.url.includes('/seasons/2026/segments/0/leagues/1234567'));
  assert.ok(byKey.draft.url.includes('view=mDraftDetail'));
  assert.equal(byKey.draft.live, true, 'nur der Draft muss wiederholt werden');
  assert.ok(byKey.schedule.url.includes('view=proTeamSchedules_wl'));
  assert.ok(!byKey.schedule.url.includes('/leagues/'), 'Spielplan ist ligaunabhaengig');
  // Defense-Ratings kommen aus der Vorsaison, weil die laufende noch leer ist.
  assert.ok(byKey.ratings.url.includes('/seasons/2025/'), byKey.ratings.url);
  assert.equal(urls.filter((u) => u.live).length, 1);
});

test('Konsolen-Schnipsel nutzt window.opener und oeffnet kein Fenster', () => {
  const code = buildConsoleSnippet({
    boardUrl: 'https://beispiel.github.io/fantasy-draft-board/#season=2026',
    season: 2026, leagueId: '1234567', intervalMs: 12000,
  });
  assert.ok(code.includes('window.opener'), 'nutzt den Verweis auf das Board');
  assert.ok(!code.includes('window.open('), 'oeffnet kein Pop-up (Safari wuerde blocken)');
  assert.ok(code.includes('"https://beispiel.github.io"'), 'postMessage nur an die eigene Origin');
  assert.ok(code.includes('"1234567"'), 'Liga eingesetzt');
  assert.ok(code.includes('view=mDraftDetail'), 'pollt den Draft');
  assert.ok(code.includes('view=kona_player_info'), 'holt den Spielerpool');
  assert.ok(code.includes("credentials: 'include'"), 'nutzt die ESPN-Anmeldung');
  assert.ok(code.includes('setInterval(poll, 12000)'), 'Intervall eingesetzt');
  assert.ok(code.includes('clearInterval(window.__fbTimer)'), 'mehrfaches Einfuegen verdoppelt nichts');
  assert.ok(!/espn_s2|SWID|document\.cookie/.test(code), 'keine Cookies im Transfer');
});

console.log(`\n${passed} bestanden, ${failures.length} fehlgeschlagen\n`);
if (failures.length) process.exit(1);
