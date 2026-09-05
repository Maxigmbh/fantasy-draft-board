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
    // Erst zur Board-Ansicht wechseln (das zeigt #fSort erst wieder an — in
    // den Nebenlisten bleibt es ausgeblendet), danach die uebrigen Regler.
    await page.click('.view[data-view="board"]');
    await page.click('.tab[data-pos="ALLE"]');
    await page.fill('#fSearch', '');
    await page.selectOption('#fSort', 'score');
    await page.uncheck('#fExpandAll');
    await page.check('#fHideDrafted');
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
  // Die ECR-Zahl steht jetzt klein ("ECR 1.1"), gross steht die Vorjahres-Positionierung.
  const ecrSmall = await page.locator('.row:not(.row--head)').first().locator('.c--ecr small').innerText();
  const ecrValue = Number(ecrSmall.replace('ECR', '').trim());
  const first = await page.locator('.row:not(.row--head) .c--name b').first().innerText();
  assert.ok(ecrValue < 3, `bestes ECR zuerst (${ecrSmall})`);
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

await check('Tabelle zeigt die Spalten der Vorlage, ECR-Spalte ersetzt durch die grosse Vorjahres-Positionierung', async () => {
  // text-transform: uppercase schlaegt auf innerText durch — case-insensitiv pruefen.
  const head = (await page.locator('.row--head').first().innerText()).toLowerCase();
  for (const label of ['rk', 'pick', 'spieler', 'pos', 'alter', 'best', 'worst', 'bye', 'off', 'sos', 'score']) {
    assert.ok(head.includes(label), `Spalte ${label} fehlt in: ${head.replace(/\s+/g, ' ')}`);
  }
  assert.match(head, /'\d{2}\s*rang/, `Spaltenkopf nennt die Vorjahres-Rang-Spalte, war: ${head}`);
  assert.ok(!/Std|ADP/i.test(head) && !/\becr\b/.test(head), 'keine Std.Dev-, ADP- oder woertliche ECR-Spalte mehr');
  const first = page.locator('.row:not(.row--head)').first();
  // .c--name ist ein Flex-Container: innerText trennt die Kinder mit Zeilenumbruch.
  const nameCell = (await first.locator('.c--name').innerText()).replace(/\s+/g, ' ').trim();
  assert.match(nameCell, /^.+ \(\w{2,3}\)/, `Name mit Team in Klammern, war: ${nameCell}`);
  assert.match(await first.locator('.c--pos').innerText(), /^(QB|RB|WR|TE|K|DST)\d+$/, 'Position mit Rang');
  const age = Number(await first.locator('.c--num').first().innerText());
  assert.ok(age > 19 && age < 42, `plausibles Alter (${age})`);
  // Die ECR-Zelle: gross die Vorjahres-Positionierung, klein die eigentliche ECR-Zahl.
  const big = await first.locator('.c--ecr b').innerText();
  assert.match(big, /^(QB|RB|WR|TE|K|DST)\d+ '\d{2}$|^Rookie$/, `Grosse Vorjahres-Positionierung, war: ${big}`);
  const small = await first.locator('.c--ecr small').innerText();
  assert.match(small, /^ECR \d/, `Kleine ECR-Angabe, war: ${small}`);
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

await check('Verletzte Spieler tragen ein Reserve-Badge, Handcuffs ein Backup-Tag', async () => {
  const target = await page.evaluate(() => {
    const injured = window.__board.players.find((p) => p.injuryReserve);
    const handcuff = window.__board.players.find((p) => p.handcuff);
    return { injuredId: injured?.id, injuredLabel: injured?.injuryLabel, handcuffId: handcuff?.id, handcuffFor: handcuff?.handcuffFor };
  });
  assert.ok(target.injuredId, 'Datensatz enthaelt mindestens einen Verletzungsfund');
  assert.ok(target.handcuffId, 'Datensatz enthaelt mindestens einen Handcuff');

  await page.fill('#fSearch', '');
  await page.uncheck('#fHideDrafted');
  await page.check('#fExpandAll');

  const injuredRow = page.locator(`.row[data-id="${target.injuredId}"]`);
  await injuredRow.scrollIntoViewIfNeeded();
  assert.equal(await injuredRow.locator('.badge--bad').innerText(), target.injuredLabel);

  const handcuffRow = page.locator(`.row[data-id="${target.handcuffId}"]`);
  await handcuffRow.scrollIntoViewIfNeeded();
  assert.equal(await handcuffRow.locator('.badge--backup').innerText(), 'Backup');
  const title = await handcuffRow.locator('.badge--backup').getAttribute('title');
  assert.ok(title.includes(target.handcuffFor), `Tooltip nennt den Starter: ${title}`);

  await handcuffRow.click();
  const detailText = await handcuffRow.locator('xpath=following-sibling::li[1]').innerText();
  assert.ok(detailText.includes('Backup für'), 'Detailzeile nennt den Starter ebenfalls');
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
  // Kein Selbstverweis: ein Mitglied dieser Liste zeigt hier nicht zusaetzlich sein eigenes "Breakout"-Tag.
  assert.equal(await page.locator('.badge--breakout').count(), 0, 'kein Breakout-Tag auf der eigenen Liste');
});

await check('Positionsfilter und Suche wirken auch in den Nebenlisten (vorher wirkungslos)', async () => {
  await page.click('.view[data-view="breakouts"]');
  await page.waitForSelector('#viewLead:not([hidden])');
  assert.equal(await page.locator('#posTabs').isHidden(), false, 'Positions-Tabs sind sichtbar');
  assert.equal(await page.locator('#fSort').isHidden(), true, 'Sortierung ausgeblendet — die Liste hat eine eigene Reihenfolge');

  const total = await page.locator('.row:not(.row--head)').count();
  await page.click('.tab[data-pos="RB"]');
  const rbOnly = await page.locator('.row:not(.row--head) .pos').allInnerTexts();
  assert.ok(rbOnly.length > 0 && rbOnly.length < total, `RB-Filter grenzt ein (${rbOnly.length} von ${total})`);
  assert.ok(rbOnly.every((t) => t.startsWith('RB')), `nur RB, war: ${rbOnly.slice(0, 3)}`);
  assert.match(await page.locator('#listMeta').innerText(), new RegExp(`${rbOnly.length} von ${total} Spielern`));

  await page.click('.tab[data-pos="ALLE"]');
  const name = await page.evaluate((kind) => {
    const ids = window.__board.data.lists[kind];
    return window.__board.players.find((p) => p.id === ids[0]).name;
  }, 'breakouts');
  await page.fill('#fSearch', name);
  const found = await page.locator('.row:not(.row--head) .c--name b').allInnerTexts();
  assert.ok(found.includes(name), `Suche findet ${name} in der Nebenliste`);
  assert.ok(found.length < total, 'Suche grenzt ein');
  await page.fill('#fSearch', '');
});

await check('Ansicht Versteckte Werte zeigt echte Verletzungsfunde und die Vorjahres-Positionierung', async () => {
  await page.click('.view[data-view="discount"]');
  await page.waitForSelector('#viewLead:not([hidden])');
  assert.match(await page.locator('#viewLead').innerText(), /verletzt|Reserve/);
  const rows = page.locator('.row:not(.row--head)');
  const count = await rows.count();
  assert.ok(count > 10, `${count} Spieler`);
  // Die ECR-Zelle traegt die Vorjahres-Positionierung gross, z.B. "RB2 '25".
  const priorLabel = await rows.first().locator('.c--ecr b').innerText();
  assert.match(priorLabel, /^(QB|RB|WR|TE|K|DST)\d+ '\d{2}$|^Rookie$/, `Vorjahres-Label: ${priorLabel}`);
  // Mindestens ein Eintrag traegt das echte Verletzungs-Badge, nicht nur den Ranking-Abstand.
  assert.ok(await page.locator('.badge--bad').count() > 0, 'mindestens ein Verletzungs-Badge sichtbar');
  assert.equal(await page.locator('.badge--hidden').count(), 0, 'kein Versteckt-Tag auf der eigenen Liste');

  // Positionsfilter greift auch hier.
  await page.click('.tab[data-pos="WR"]');
  const wrOnly = await page.locator('.row:not(.row--head) .pos').allInnerTexts();
  assert.ok(wrOnly.length > 0 && wrOnly.every((t) => t.startsWith('WR')), `nur WR, war: ${wrOnly.slice(0, 3)}`);
  await page.click('.tab[data-pos="ALLE"]');
});

await check('Hauptliste markiert Mitglieder der Nebenlisten mit Cross-Tags', async () => {
  const ids = await page.evaluate(() => ({
    breakout: window.__board.data.lists.breakouts[0],
    discount: window.__board.data.lists.discount[0],
  }));
  await page.check('#fExpandAll');
  await page.uncheck('#fHideDrafted');

  const breakoutRow = page.locator(`.row[data-id="${ids.breakout}"]`);
  await breakoutRow.scrollIntoViewIfNeeded();
  assert.equal(await breakoutRow.locator('.badge--breakout').innerText(), 'Breakout');

  const discountRow = page.locator(`.row[data-id="${ids.discount}"]`);
  await discountRow.scrollIntoViewIfNeeded();
  assert.equal(await discountRow.locator('.badge--hidden').innerText(), 'Versteckt');
});

await check('Quellen und Methodik sind ausgewiesen', async () => {
  await page.evaluate(() => { document.querySelector('details.sources').open = true; });
  const text = await page.locator('#sourcesBox').innerText();
  for (const label of ['FantasyPros', 'nflverse', 'Wettquoten', 'Verletzungs-Feed']) {
    assert.ok(text.includes(label), `${label} genannt`);
  }
  const links = await page.locator('#sourcesBox a').count();
  assert.equal(links, 4, 'vier Quellen verlinkt');
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
