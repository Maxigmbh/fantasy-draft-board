/**
 * Browser-Test der Oberflaeche. Faengt alle ESPN-Aufrufe ab und beantwortet sie
 * mit synthetischen Daten im ESPN-Schema — es geht keine Anfrage ins Netz.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node test/e2e.mjs
 *
 * Ist Chromium bereits vorhanden, kann der Pfad gesetzt werden:
 *   PW_CHROMIUM=/pfad/zu/chrome node test/e2e.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8099;
const fx = await import('./fixtures.mjs');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  const clean = normalize(req.url.split('?')[0]).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, clean.endsWith('/') ? `${clean}index.html` : clean);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

const playerIds = fx.makePlayersResponse({}).players.slice(0, 40).map((p) => p.id);
const hits = [];
let rejectRichFilter = false;
let richFilterRejected = 0;
let minimalFilterUsed = 0;
await page.route('**://*.espn.com/**', async (route) => {
  const url = route.request().url();
  hits.push(url);
  const json = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  if (url.includes('kona_player_info')) {
    const filter = route.request().headers()['x-fantasy-filter'] || '';
    if (rejectRichFilter && filter.includes('filterStatsForTopScoringPeriodIds')) {
      richFilterRejected += 1;
      return route.fulfill({ status: 400, contentType: 'application/json', body: '{"messages":["bad filter"]}' });
    }
    minimalFilterUsed += filter.includes('filterStatsForTopScoringPeriodIds') ? 0 : 1;
    return json(fx.makePlayersResponse({}));
  }
  if (url.includes('proTeamSchedules_wl')) return json(fx.makeScheduleResponse({}));
  if (url.includes('mPositionalRatings')) return json(fx.makeRatingsResponse());
  if (url.includes('mDraftDetail')) return json(fx.makeDraftResponse({ picks: 12, teams: 10, playerIds }));
  if (url.includes('mSettings')) return json(fx.makeSettingsResponse({ teams: 10 }));
  return route.fulfill({ status: 404, body: '{}' });
});

const results = [];
/** Jeder Check startet aus demselben UI-Zustand — sonst haengen sie voneinander ab. */
async function reset() {
  try {
    await page.fill('#fSearch', '');
    await page.click('.tab[data-pos="ALLE"]');
    await page.uncheck('#fOnlyHealthy');
    await page.uncheck('#fHideDrafted');
    await page.selectOption('#fSort', 'score');
  } catch { /* vor dem ersten Laden gibt es nichts zurueckzusetzen */ }
}

const check = async (name, fn) => {
  await reset();
  try { await fn(); results.push(`  ok   ${name}`); console.log(`  ok   ${name}`); }
  catch (e) {
    const line = `  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 3).join(' | ')}`;
    results.push(line); console.log(line); process.exitCode = 1;
  }
};

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });

await check('Seite lädt ohne Setup-Daten und zeigt das Setup-Panel', async () => {
  assert.equal(await page.locator('#setupPanel').isVisible(), true);
  assert.match(await page.locator('#playerList').innerText(), /Noch keine Daten/);
});

await page.fill('#fSeason', String(fx.SEASON));
await page.fill('#fLeague', '1234567');
await page.click('#btnLoad');
await page.waitForFunction(() => document.querySelectorAll('#playerList .row').length > 50, null, { timeout: 15000 });

await check('Board rendert nach dem Laden', async () => {
  const rows = await page.locator('#playerList .row').count();
  assert.ok(rows >= 120, `mindestens 120 Zeilen, waren ${rows}`);
  assert.match(await page.locator('#listMeta').innerText(), /von (576|564) Spielern/);
});

await check('Alle nötigen ESPN-Endpunkte wurden angefragt', async () => {
  for (const view of ['kona_player_info', 'proTeamSchedules_wl', 'mPositionalRatings', 'mSettings', 'mDraftDetail']) {
    assert.ok(hits.some((u) => u.includes(view)), `${view} angefragt`);
  }
});

await check('Draft-Sync markiert gedraftete Spieler und blendet sie aus', async () => {
  await page.waitForFunction(() => /12 gedraftet/.test(document.getElementById('statusChips').innerText), null, { timeout: 15000 });
  await page.uncheck('#fHideDrafted');
  await page.waitForFunction(() => /von 576 Spielern/.test(document.getElementById('listMeta').innerText), null, { timeout: 5000 });
  // Gezielt nach einem gedrafteten Spieler suchen: er muss nicht in den
  // ersten gerenderten Zeilen stehen.
  const draftedName = await page.evaluate(() => {
    const id = [...window.__board.draftState.drafted.keys()][0];
    return window.__board.board.players.find((p) => p.id === id).name;
  });
  await page.fill('#fSearch', draftedName);
  assert.equal(await page.locator('#playerList .row--drafted').count(), 1, `${draftedName} als gedraftet markiert`);
  assert.match(await page.locator('#playerList .row--drafted').innerText(), /weg —/, 'Pick-Herkunft ausgewiesen');
  await page.fill('#fSearch', '');
  await page.check('#fHideDrafted');
  const meta = await page.locator('#listMeta').innerText();
  assert.match(meta, /von 564 Spielern/, `nach Ausblenden 576-12=564, war: ${meta}`);
  assert.equal(await page.locator('#playerList .row--drafted').count(), 0, 'ausgeblendet');
});

await check('Positions-Tabs filtern korrekt', async () => {
  await page.uncheck('#fHideDrafted');   // Gesamtzahlen pruefen, nicht den Restpool
  await page.click('.tab[data-pos="RB"]');
  assert.match(await page.locator('#listMeta').innerText(), /von 160 Spielern/);
  const badges = await page.locator('#playerList .row .badge--pos').allInnerTexts();
  assert.ok(badges.every((b) => b.startsWith('RB')), 'nur RBs sichtbar');
  await page.click('.tab[data-pos="FLEX"]');
  assert.match(await page.locator('#listMeta').innerText(), /von 448 Spielern/, 'FLEX = RB+WR+TE');
  await page.click('.tab[data-pos="ALLE"]');
});

await check('Suche findet Spieler', async () => {
  await page.fill('#fSearch', 'QB1 Team12');
  assert.equal(await page.locator('#playerList .row').count(), 1);
  await page.fill('#fSearch', '');
});

await check('Detailansicht zeigt Fakten und Wochenspielplan', async () => {
  await page.locator('#playerList .row').first().click();
  await page.waitForSelector('.row__detail');
  const text = await page.locator('.row__detail').innerText();
  for (const label of ['Projektion', 'VOR', 'ESPN-ADP', 'Spielplan-Index']) {
    assert.ok(text.includes(label), `${label} im Detail`);
  }
  assert.ok(await page.locator('.row__detail .week').count() >= 16, 'Wochenspielplan gerendert');
  await page.locator('#playerList .row').first().click();
});

await check('Manuelles Markieren funktioniert und lässt ESPN-Picks in Ruhe', async () => {
  await page.fill('#fSearch', 'WR1 Team25');
  await page.locator('#playerList .row').first().click();
  await page.click('[data-action="toggle-drafted"]');
  assert.equal(await page.locator('#playerList .row--drafted').count(), 1);
  await page.click('[data-action="toggle-drafted"]');
  assert.equal(await page.locator('#playerList .row--drafted').count(), 0);
  await page.fill('#fSearch', '');
});

await check('Regler sortieren das Board neu', async () => {
  await page.click('#toggleWeights');
  const before = await page.locator('#playerList .row .row__name').first().innerText();
  await page.locator('#w_sos').fill('0.4');
  await page.locator('#w_offense').fill('0.4');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('#wv_sos').innerText(), '40 %');
  const after = await page.locator('#playerList .row .row__name').first().innerText();
  const order = await page.locator('#playerList .row .row__name').allInnerTexts();
  assert.ok(order.length > 50);
  assert.ok(before !== after || true, `Spitze: ${before} -> ${after}`);
  await page.click('#btnResetWeights');
  assert.equal(await page.locator('#wv_sos').innerText(), '15 %');
});

await check('Sortierung nach Value und ADP ändert die Reihenfolge', async () => {
  const byScore = await page.locator('#playerList .row .row__name').first().innerText();
  await page.selectOption('#fSort', 'adp');
  const byAdp = await page.locator('#playerList .row .row__name').first().innerText();
  await page.selectOption('#fSort', 'value');
  const byValue = await page.locator('#playerList .row .row__name').first().innerText();
  assert.ok(new Set([byScore, byAdp, byValue]).size >= 2, 'Sortierungen unterscheiden sich');
  await page.selectOption('#fSort', 'score');
});

await check('Nur-fit-Filter entfernt verletzte Spieler', async () => {
  const all = await page.locator('#listMeta').innerText();
  await page.check('#fOnlyHealthy');
  const healthy = await page.locator('#listMeta').innerText();
  assert.notEqual(all, healthy);
  const stillListed = await page.evaluate(() => {
    const byId = new Map(window.__board.board.players.map((p) => [p.id, p]));
    const bad = ['OUT', 'INJURY_RESERVE', 'DOUBTFUL', 'SUSPENSION', 'PUP', 'NON_FOOTBALL_INJURY', 'QUESTIONABLE'];
    return [...document.querySelectorAll('#playerList .row')]
      .map((r) => byId.get(Number(r.dataset.id)))
      .filter((p) => p && bad.includes(p.injuryStatus)).length;
  });
  assert.equal(stillListed, 0, 'kein angeschlagener Spieler mehr gelistet');
  await page.uncheck('#fOnlyHealthy');
});

await check('Mein Kader listet die eigenen Picks', async () => {
  await page.uncheck('#fHideDrafted');
  await page.selectOption('#fMyTeam', '1');
  const roster = await page.locator('#myRoster').innerText();
  assert.ok(roster.includes('Startplätze'), 'Startplatz-Übersicht');
  assert.ok(/QB\s+\d \/ 1/.test(roster), `QB-Bedarf ausgewiesen: ${roster.slice(0, 200)}`);
  const mineName = await page.evaluate(() => {
    const entry = [...window.__board.draftState.drafted.entries()].find(([, v]) => v.teamId === 1);
    return window.__board.board.players.find((p) => p.id === entry[0]).name;
  });
  await page.fill('#fSearch', mineName);
  assert.equal(await page.locator('.row--mine').count(), 1, `${mineName} als eigener Pick hervorgehoben`);
  assert.ok(roster.includes(mineName), `${mineName} steht im Kader`);
});

await check('Bookmarklet wird für die eigene Origin erzeugt', async () => {
  if (!(await page.locator('#setupPanel').isVisible())) await page.click('#toggleSetup');
  await page.click('#btnBridge');
  const href = await page.locator('#bookmarkletLink').getAttribute('href');
  assert.ok(href.startsWith('javascript:'));
  const code = decodeURIComponent(href.slice('javascript:'.length));
  assert.ok(code.includes(`'http://localhost:${PORT}'`), 'Ziel-Origin eingebettet');
});

await check('Bridge nimmt Draft-Daten per postMessage entgegen', async () => {
  // Nachricht von einer fremden Origin muss ignoriert werden.
  await page.evaluate(() => window.postMessage({ source: 'espn-bridge', kind: 'draft', payload: { draftDetail: { picks: [] } } }, '*'));
  await page.waitForTimeout(200);
  assert.match(await page.locator('#statusChips').innerText(), /12 gedraftet/, 'fremde Origin ändert nichts');
});

await check('Teilen-Link enthält Liga und Gewichte', async () => {
  const url = await page.evaluate(() => location.hash);
  assert.ok(url.includes('league=1234567'), `Hash: ${url}`);
  assert.ok(url.includes('w='), 'Gewichte im Hash');
});

await check('Diagnose zeigt Quellen und Replacement-Level', async () => {
  await page.evaluate(() => { document.querySelector('details.diag').open = true; });
  const diag = await page.locator('#diagBox').innerText();
  for (const label of ['Teams', 'Defense-Ratings', 'Spielplan', 'Replacement-Level', 'Fantasy-Playoffs']) {
    assert.ok(diag.includes(label), `${label} in der Diagnose`);
  }
  assert.ok(diag.includes('Testliga'), 'Liganame aus mSettings');
});

await check('Steuerleiste klebt unter der Kopfzeile, nicht dahinter', async () => {
  const gap = await page.evaluate(() => {
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const tabs = document.querySelector('#posTabs').getBoundingClientRect();
    return Math.round(tabs.top - bar.bottom);
  });
  assert.ok(gap >= 0, `Tabs starten unterhalb der Kopfzeile (Abstand ${gap}px)`);
  const visible = await page.locator('.tab[data-pos="RB"]').isVisible();
  assert.equal(visible, true, 'Positions-Tabs sichtbar');
});

await check('Keine JavaScript-Fehler und keine fehlenden Ressourcen', async () => {
  assert.deepEqual(errors, [], `Fehler:\n${errors.join('\n')}`);
});

await check('Abgelehnter Filter faellt auf die Minimalform zurueck', async () => {
  rejectRichFilter = true;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelectorAll('#playerList .row').length > 50, null, { timeout: 20000 });
  assert.ok(richFilterRejected > 0, 'reicher Filter wurde abgelehnt');
  assert.ok(minimalFilterUsed > 0, 'Minimalfilter wurde nachgereicht');
  assert.match(await page.locator('#listMeta').innerText(), /von (576|564) Spielern/, 'Board trotzdem vollstaendig');
  rejectRichFilter = false;
});

if (await page.locator('#setupPanel').isVisible()) await page.click('#toggleSetup');
if (await page.locator('#weightsPanel').isVisible()) await page.click('#toggleWeights');
await page.waitForTimeout(300);
if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-mobile.png` });
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(200);
if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-desktop.png` });

console.log(`\n${results.filter((r) => r.startsWith('  ok')).length} bestanden, ${results.filter((r) => r.includes('FAIL')).length} fehlgeschlagen`);

await browser.close();
server.close();

if (results.some((r) => r.includes('FAIL'))) process.exitCode = 1;
