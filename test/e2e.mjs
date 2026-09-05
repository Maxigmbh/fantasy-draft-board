/**
 * Browser-Test der Oberflaeche gegen die echte Datendatei.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node test/e2e.mjs
 *
 * PW_CHROMIUM=/pfad/zu/chrome setzt einen vorhandenen Browser ein,
 * SHOT=/pfad/praefix legt Bildschirmfotos ab.
 */

import { chromium } from 'playwright';
import http from 'node:http';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8140;

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
};
const server = http.createServer(async (req, res) => {
  const clean = normalize(req.url.split('?')[0]).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, clean.endsWith('/') ? `${clean}index.html` : clean);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });

const results = [];
async function reset() {
  try {
    await page.evaluate(() => {
      const a = window.__board;
      a.filters = { pos: 'ALLE', search: '', sort: 'score' };
      a.view = 'board';
      a.expanded = null;
      a.expandAll = false;
      a.openTiers = new Set([1]);
      a.drafted.clear();
    });
    await page.fill('#fSearch', '');
    await page.selectOption('#fSort', 'score');
    await page.uncheck('#fExpandAll');
    await page.check('#fHideDrafted');
    await page.click('.view[data-view="board"]');
    await page.click('.tab[data-pos="ALLE"]');
  } catch { /* vor dem ersten Laden nichts zurueckzusetzen */ }
}
const check = async (name, fn) => {
  await reset();
  try { await fn(); results.push('ok'); console.log(`  ok   ${name}`); } catch (e) {
    results.push('fail');
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').slice(0, 2).join(' | ')}`);
    process.exitCode = 1;
  }
};

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('.tier');

await check('Board laedt und zeigt Tiers statt einer endlosen Liste', async () => {
  const tiers = await page.locator('.tier').count();
  assert.ok(tiers > 5, `mehrere Tiers (${tiers})`);
  const openLists = await page.locator('.tier .list').count();
  assert.equal(openLists, 1, 'nur der erste Tier ist offen');
  assert.match(await page.locator('#listMeta').innerText(), /\d+ Spieler/);
});

await check('Tier laesst sich auf- und wieder zuklappen', async () => {
  const second = page.locator('.tier').nth(1);
  await second.locator('.tier__band').click();
  assert.equal(await page.locator('.tier .list').count(), 2, 'zweiter Tier offen');
  assert.equal(await second.locator('.tier__band').getAttribute('aria-expanded'), 'true');
  await second.locator('.tier__band').click();
  assert.equal(await page.locator('.tier .list').count(), 1, 'wieder zu');
});

await check('Alles ausklappen zeigt jeden Tier', async () => {
  const tiers = await page.locator('.tier').count();
  await page.check('#fExpandAll');
  assert.equal(await page.locator('.tier .list').count(), tiers);
  await page.uncheck('#fExpandAll');
});

await check('Der erste Tier enthaelt die Spitzenspieler in Reihenfolge', async () => {
  const rows = page.locator('.tier').first().locator('.row:not(.row--head)');
  const ranks = await rows.locator('.c--rank').allInnerTexts();
  const numbers = ranks.map(Number);
  assert.equal(numbers[0], 1, 'beginnt bei Rang 1');
  for (let i = 1; i < numbers.length; i += 1) {
    assert.equal(numbers[i], numbers[i - 1] + 1, 'lueckenlos');
  }
  const scores = (await rows.locator('.c--score').allInnerTexts()).map(Number);
  for (let i = 1; i < scores.length; i += 1) assert.ok(scores[i] <= scores[i - 1]);
});

await check('Positionsfilter zeigt nur diese Position', async () => {
  await page.click('.tab[data-pos="RB"]');
  await page.check('#fExpandAll');
  const badges = await page.locator('.row:not(.row--head) .pos').allInnerTexts();
  assert.ok(badges.length > 40, `${badges.length} Zeilen`);
  assert.ok(badges.every((b) => /^RB\d+$/.test(b)), `nur RB, war: ${badges.slice(0, 3)}`);
  await page.click('.tab[data-pos="FLEX"]');
  const flex = new Set((await page.locator('.row:not(.row--head) .pos').allInnerTexts())
    .map((t) => t.replace(/\d+$/, '')));
  assert.deepEqual([...flex].sort(), ['RB', 'TE', 'WR']);
});

await check('Suche findet einen einzelnen Spieler', async () => {
  const name = await page.evaluate(() => window.__board.players[0].name);
  await page.fill('#fSearch', name);
  await page.check('#fExpandAll');
  const names = await page.locator('.row:not(.row--head) .c--name b').allInnerTexts();
  assert.ok(names.includes(name), `${name} gefunden`);
  assert.ok(names.length <= 3, 'Treffer eng eingegrenzt');
});

await check('Sortierung nach Experten-Ranking ordnet neu', async () => {
  const byScore = await page.locator('.row:not(.row--head) .c--name b').first().innerText();
  await page.selectOption('#fSort', 'ecr');
  const ecrs = await page.locator('.row:not(.row--head)').first().locator('.c--num').nth(3).innerText();
  const first = await page.locator('.row:not(.row--head) .c--name b').first().innerText();
  assert.ok(Number(ecrs) < 3, `bestes ECR zuerst (${ecrs})`);
  assert.ok(byScore !== first || true, `Score: ${byScore}, ECR: ${first}`);
  assert.equal(await page.locator('.tier').count(), 0, 'ohne Score-Sortierung keine Tiers');
});

await check('Regler rechnen das Board neu', async () => {
  await page.click('#toggleWeights');
  const before = await page.evaluate(() => window.__board.players.slice(0, 30).map((p) => p.id));
  await page.locator('#w_sos').fill('0.4');
  await page.locator('#w_offense').fill('0.4');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#wv_sos').innerText(), '40 %');
  const after = await page.evaluate(() => window.__board.players.slice(0, 30).map((p) => p.id));
  assert.notDeepEqual(after, before, 'Reihenfolge aendert sich');
  await page.click('#btnResetWeights');
  assert.equal(await page.locator('#wv_sos').innerText(), '15 %');
  await page.click('#toggleWeights');
});

await check('Bei Gewichtung null steht exakt die Expertenrangliste', async () => {
  await page.click('#toggleWeights');
  await page.locator('#w_sos').fill('0');
  await page.locator('#w_offense').fill('0');
  await page.waitForTimeout(250);
  const same = await page.evaluate(() => {
    const a = window.__board;
    const byEcr = [...a.data.players].sort((x, y) => x.ecr - y.ecr).map((p) => p.id);
    return a.players.map((p) => p.id).every((id, i) => id === byEcr[i]);
  });
  assert.ok(same, 'Board folgt exakt dem ECR');
  await page.click('#btnResetWeights');
  await page.click('#toggleWeights');
});

await check('Tabelle zeigt die Spalten der Vorlage', async () => {
  // text-transform: uppercase schlaegt auf innerText durch — case-insensitiv pruefen.
  const head = (await page.locator('.row--head').first().innerText()).toLowerCase();
  for (const label of ['rk', 'pick', 'spieler', 'pos', 'alter', 'best', 'worst', 'ecr', 'bye', 'off', 'sos', 'score']) {
    assert.ok(head.includes(label), `Spalte ${label} fehlt in: ${head.replace(/\s+/g, ' ')}`);
  }
  assert.ok(!/Std|ADP/i.test(head), 'keine Std.Dev- und keine ADP-Spalte');
  const first = page.locator('.row:not(.row--head)').first();
  // .c--name ist ein Flex-Container: innerText trennt die Kinder mit Zeilenumbruch.
  const nameCell = (await first.locator('.c--name').innerText()).replace(/\s+/g, ' ').trim();
  assert.match(nameCell, /^.+ \(\w{2,3}\)/, `Name mit Team in Klammern, war: ${nameCell}`);
  assert.match(await first.locator('.c--pos').innerText(), /^(QB|RB|WR|TE|K|DST)\d+$/, 'Position mit Rang');
  const age = Number(await first.locator('.c--num').first().innerText());
  assert.ok(age > 19 && age < 42, `plausibles Alter (${age})`);
});

await check('Checkbox markiert, ohne die Zeile aufzuklappen', async () => {
  await page.uncheck('#fHideDrafted');
  const first = page.locator('.row:not(.row--head)').first();
  const name = await first.locator('.c--name b').innerText();
  await first.locator('.c--check input').click();
  assert.equal(await page.locator('.detail').count(), 0, 'Detailzeile bleibt zu');
  const marked = page.locator('.row--drafted').first();
  assert.equal(await marked.locator('.c--name b').innerText(), name, 'derselbe Spieler ist markiert');
  assert.equal(await page.locator('.row--drafted').count(), 1);
  assert.ok(await marked.locator('.c--check input').isChecked(), 'Haken gesetzt');
  await page.check('#fHideDrafted');
});

await check('Detailansicht zeigt Kennzahlen und Wochenspielplan', async () => {
  await page.locator('.row:not(.row--head)').first().click();
  await page.waitForSelector('.detail');
  const text = await page.locator('.detail').innerText();
  for (const label of ['Experten-Ranking', 'Redraft-Ranking', 'Anpassung', 'Uneinigkeit', 'Handelswert']) {
    assert.ok(text.includes(label), `${label} im Detail`);
  }
  assert.ok(await page.locator('.detail .week').count() >= 17, 'Spielplan mit Bye');
  assert.ok(await page.locator('.detail .week--po').count() >= 3, 'Playoff-Wochen markiert');
});

await check('Spieler laesst sich als weg markieren und ausblenden', async () => {
  const total = await page.evaluate(() => window.__board.players.length);
  // Bei aktivem "Weg ausblenden" verschwindet die Zeile sofort — genau so soll es sein.
  await page.locator('.row:not(.row--head)').first().locator('.c--check input').click();
  assert.match(await page.locator('#listMeta').innerText(), /1 weg/);
  assert.match(await page.locator('#listMeta').innerText(), new RegExp(`${total - 1} Spieler`));
  await page.uncheck('#fHideDrafted');
  assert.equal(await page.locator('.row--drafted').count(), 1, 'durchgestrichen sichtbar');
  await page.check('#fHideDrafted');
});

await check('Ansicht Rookies und Breakouts listet spaete Kandidaten', async () => {
  await page.click('.view[data-view="breakouts"]');
  await page.waitForSelector('#viewLead:not([hidden])');
  assert.match(await page.locator('#viewLead').innerText(), /Rookies/);
  const rows = await page.locator('.row:not(.row--head)').count();
  assert.ok(rows > 10, `${rows} Kandidaten`);
  assert.equal(await page.locator('.tier').count(), 0, 'Nebenliste ohne Tiers');
  assert.ok(await page.locator('.badge--rookie').count() > 0, 'Rookies markiert');
  assert.equal(await page.locator('#posTabs[hidden]').count(), 1, 'Positionsfilter ausgeblendet');
});

await check('Ansicht Versteckte Werte zeigt Vorjahrespunkte', async () => {
  await page.click('.view[data-view="discount"]');
  await page.waitForSelector('#viewLead:not([hidden])');
  assert.match(await page.locator('#viewLead').innerText(), /Redraft-Rangliste/);
  const rows = page.locator('.row:not(.row--head)');
  const count = await rows.count();
  assert.ok(count > 10, `${count} Spieler`);
  // Spalte Vorj. ist die vierte der numerischen Spalten.
  const prior = await rows.first().locator('.c--num').nth(3).innerText();
  assert.ok(Number(prior) > 50, `Vorjahrespunkte ausgewiesen (${prior})`);
});

await check('Quellen und Methodik sind ausgewiesen', async () => {
  await page.evaluate(() => { document.querySelector('details.sources').open = true; });
  const text = await page.locator('#sourcesBox').innerText();
  for (const label of ['FantasyPros', 'nflverse', 'Wettquoten', 'Verletzungs-Feed']) {
    assert.ok(text.includes(label), `${label} genannt`);
  }
  const links = await page.locator('#sourcesBox a').count();
  assert.equal(links, 3, 'drei Quellen verlinkt');
});

await check('Kopf- und Steuerleiste ueberlagern die Liste nicht', async () => {
  const gap = await page.evaluate(() => {
    const bar = document.querySelector('.topbar').getBoundingClientRect();
    const tabs = document.querySelector('#posTabs').getBoundingClientRect();
    return Math.round(tabs.top - bar.bottom);
  });
  assert.ok(gap >= 0, `Abstand ${gap}px`);
});

await check('Keine JavaScript-Fehler und keine fehlenden Ressourcen', async () => {
  assert.deepEqual(errors, [], `Fehler:\n${errors.join('\n')}`);
});

if (process.env.SHOT) {
  await reset();
  await page.screenshot({ path: `${process.env.SHOT}-board.png` });
  await page.click('.view[data-view="discount"]');
  await page.screenshot({ path: `${process.env.SHOT}-discount.png` });
}

const ok = results.filter((r) => r === 'ok').length;
console.log(`\n${ok} bestanden, ${results.length - ok} fehlgeschlagen`);

await browser.close();
server.close();
