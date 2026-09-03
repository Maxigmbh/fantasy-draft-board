/**
 * main.js — Verdrahtung: Konfiguration, Datenbeschaffung, Board-Neuberechnung,
 * Draft-Sync und Rendering.
 */

import { EspnClient, POSITIONS, healthFactor } from './espn.js';
import { buildBoard, DEFAULT_WEIGHTS, DEFAULT_STARTERS, positionalLeagueAverage } from './model.js';
import { loadConfig, saveConfig, writeHash, shareUrl, exportState, importState } from './state.js';
import { DraftState, DraftPoller, BridgeReceiver, buildBookmarklet } from './sync.js';
import {
  renderTabs, renderSliders, renderChips, renderPlayers, renderRoster, renderDiag,
  formatWeight, SLIDER_DEFS, toast, notice,
} from './ui.js';

const $ = (id) => document.getElementById(id);
const LIST_STEP = 120;

const app = {
  config: loadConfig(),
  client: null,
  draftState: new DraftState(),
  poller: null,
  bridge: null,
  bridgeConnected: false,
  raw: { players: [], schedule: {}, ratings: {}, settings: null, ratingsSeason: null },
  board: null,
  filters: { pos: 'ALLE', search: '', sort: 'score' },
  expandedId: null,
  limit: LIST_STEP,
  loading: false,
};

/* ------------------------------------------------------------------ */
/* Board berechnen und zeichnen                                        */
/* ------------------------------------------------------------------ */

function rebuild() {
  if (!app.raw.players.length) { render(); return; }
  const settings = app.raw.settings;
  app.board = buildBoard({
    players: app.raw.players,
    schedule: app.raw.schedule,
    ratings: app.raw.ratings,
    teams: settings?.teams || 10,
    starters: settings?.starters || DEFAULT_STARTERS,
    weights: {
      ...app.config.weights,
      playoffWeeks: settings?.playoffWeeks?.length ? settings.playoffWeeks : [15, 16, 17],
    },
  });
  render();
}

let rebuildTimer = null;
function rebuildSoon() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 120);
}

function visiblePlayers() {
  if (!app.board) return [];
  const { pos, search, sort } = app.filters;
  const needle = search.trim().toLowerCase();

  let list = app.board.players.filter((p) => {
    if (pos === 'FLEX') { if (!['RB', 'WR', 'TE'].includes(p.pos)) return false; }
    else if (pos !== 'ALLE' && p.pos !== pos) return false;
    if (app.config.hideDrafted && app.draftState.isDrafted(p.id)) return false;
    if (app.config.onlyHealthy && healthFactor(p.injuryStatus) < 0.93) return false;
    if (needle && !p.name.toLowerCase().includes(needle) && !p.team.toLowerCase().includes(needle)) return false;
    return true;
  });

  const cmp = {
    score: (a, b) => b.score - a.score,
    adp: (a, b) => (a.adp || 9999) - (b.adp || 9999),
    value: (a, b) => (b.adpDelta ?? -9999) - (a.adpDelta ?? -9999),
    projection: (a, b) => b.projection - a.projection,
    sos: (a, b) => b.sosZ - a.sosZ,
  }[sort];
  list = [...list].sort(cmp);
  return list;
}

function render() {
  renderStatus();
  if (!app.board) {
    $('playerList').innerHTML = '<li class="hint" style="padding:24px;text-align:center">Noch keine Daten geladen — oben unter „Setup“ die Liga verbinden.</li>';
    $('listMeta').textContent = '';
    $('btnMore').hidden = true;
    return;
  }

  const list = visiblePlayers();
  const shown = list.slice(0, app.limit);
  renderPlayers($('playerList'), shown, {
    draftState: app.draftState,
    myTeamId: Number(app.config.myTeamId) || 0,
    expandedId: app.expandedId,
    schedule: app.raw.schedule,
    ratings: app.raw.ratings,
    leagueAvg: app.board.meta.leagueAvg,
    playoffWeeks: app.board.meta.playoffWeeks,
  });

  $('btnMore').hidden = shown.length >= list.length;
  $('listMeta').textContent = `${shown.length} von ${list.length} Spielern · ${app.draftState.count} weg`;

  $('myTeamPanel').hidden = !Object.keys(app.draftState.teamNames).length;
  renderRoster($('myRoster'), app.board, app.draftState, Number(app.config.myTeamId) || 0,
    app.board.meta.starters);
  renderDiagnostics();
}

function renderStatus() {
  const chips = [];
  chips.push({ text: `Saison ${app.config.season}` });

  if (app.loading) chips.push({ text: 'lädt …', tone: 'warn' });
  else if (app.raw.players.length) chips.push({ text: `${app.raw.players.length} Spieler`, tone: 'live' });
  else chips.push({ text: 'keine Daten', tone: 'warn' });

  if (!Object.keys(app.raw.ratings).length) {
    chips.push({ text: 'SoS: keine Defense-Daten', tone: 'warn' });
  } else if (app.raw.ratingsSeason && app.raw.ratingsSeason !== app.config.season) {
    chips.push({ text: `SoS-Basis ${app.raw.ratingsSeason}` });
  }

  if (app.bridgeConnected) chips.push({ text: 'ESPN-Tab verbunden', tone: 'live' });
  if (app.poller?.running) chips.push({ text: 'Draft-Sync aktiv', tone: 'live' });

  if (app.draftState.count) {
    const time = app.draftState.lastUpdate
      ? app.draftState.lastUpdate.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';
    chips.push({ text: `${app.draftState.count} gedraftet${time ? ` · ${time}` : ''}`, tone: 'live' });
  }
  renderChips($('statusChips'), chips);
}

function renderDiagnostics() {
  const info = [];
  const settings = app.raw.settings;
  info.push(['Liga', app.config.leagueId ? `${settings?.name || 'ID'} ${app.config.leagueId}` : 'nicht gesetzt']);
  info.push(['Teams', settings?.teams ?? '— (Annahme 10)']);
  info.push(['Startplätze', JSON.stringify(app.board?.meta.starters ?? DEFAULT_STARTERS)]);
  info.push(['PPR', settings ? `${settings.ppr} Punkt(e) pro Reception` : '—']);
  info.push(['Fantasy-Playoffs', (app.board?.meta.playoffWeeks || []).join(', ') || '—']);
  info.push(['Defense-Ratings', Object.keys(app.raw.ratings).length
    ? `${Object.keys(app.raw.ratings).join(', ')} (Saison ${app.raw.ratingsSeason})`
    : 'nicht geladen — SoS wirkt nicht']);
  info.push(['Spielplan', `${Object.keys(app.raw.schedule).length} NFL-Teams`]);
  info.push(['Replacement-Level', app.board
    ? Object.entries(app.board.meta.replacementPoints)
      .map(([k, v]) => `${k} ${v.toFixed(0)}`).join(' · ')
    : '—']);
  info.push(['Bridge', app.bridgeConnected ? 'verbunden' : 'nicht verbunden']);

  for (const entry of (app.client?.log || []).slice(-12)) {
    info.push([entry.label || 'Request', entry.ok ? `OK (${entry.ms} ms)` : `Fehler: ${entry.error}`]);
  }
  renderDiag($('diagBox'), info);
}

/* ------------------------------------------------------------------ */
/* Daten laden (direkter Weg)                                          */
/* ------------------------------------------------------------------ */

function makeClient() {
  app.client = new EspnClient({
    season: app.config.season,
    leagueId: app.config.leagueId,
    proxy: app.config.proxy,
  });
  return app.client;
}

async function loadData() {
  app.loading = true;
  notice($('notice'), '');
  renderStatus();
  const client = makeClient();

  try {
    const players = await client.fetchPlayers({ rankType: app.config.rankType });
    if (!players.length) throw new Error('ESPN lieferte keinen Spielerpool.');
    app.raw.players = players;
  } catch (err) {
    app.loading = false;
    render();
    notice($('notice'),
      `Spielerpool konnte nicht geladen werden (${err.message}). `
      + 'Der Browser blockiert vermutlich den direkten Zugriff auf ESPN (CORS). '
      + 'Nutze „Über ESPN-Tab verbinden“ — das umgeht die Sperre vollständig.',
      'bad');
    return;
  }

  // Spielplan und Defense-Ratings sind optional: ohne sie fehlt nur der SoS-Teil.
  try {
    app.raw.schedule = await client.fetchSchedule();
  } catch {
    app.raw.schedule = {};
  }
  await loadRatings(client);

  if (app.config.leagueId) {
    try {
      app.raw.settings = await client.fetchSettings();
    } catch { /* Liga privat oder CORS — Standardannahmen greifen. */ }
    startPolling();
  }

  app.loading = false;
  rebuild();
  if (!Object.keys(app.raw.ratings).length) {
    notice($('notice'),
      'Defense-Ratings sind nicht verfügbar. Das Board rechnet ohne Spielplan-Komponente weiter — '
      + 'Offense-Stärke und Gesundheit wirken normal.', '');
  }
  toast(`${app.raw.players.length} Spieler geladen`);
}

/**
 * Defense-Ratings: vor dem ersten Spieltag ist die laufende Saison leer,
 * dann bildet die Vorsaison die Baseline.
 */
async function loadRatings(client) {
  for (const season of [app.config.season, app.config.season - 1]) {
    try {
      const ratings = await client.fetchPositionalRatings(season);
      if (Object.keys(ratings).length) {
        app.raw.ratings = ratings;
        app.raw.ratingsSeason = season;
        return;
      }
    } catch { /* nächste Saison probieren */ }
  }
  app.raw.ratings = {};
  app.raw.ratingsSeason = null;
}

/* ------------------------------------------------------------------ */
/* Draft-Sync                                                          */
/* ------------------------------------------------------------------ */

function startPolling() {
  if (!app.config.autoSync || !app.config.leagueId) return;
  app.poller?.stop();
  app.poller = new DraftPoller({
    client: app.client || makeClient(),
    draftState: app.draftState,
    intervalMs: Math.max(5, Number(app.config.syncSeconds) || 12) * 1000,
    onStatus: (status) => {
      if (status.state === 'error' && status.failures === 1) {
        notice($('notice'),
          'Der automatische Draft-Abgleich erreicht ESPN nicht direkt. '
          + 'Über „Über ESPN-Tab verbinden“ läuft der Abgleich zuverlässig.', 'bad');
      }
      if (status.state === 'ok' && status.changed) toast('Draft aktualisiert');
      renderStatus();
    },
  });
  app.poller.start();
}

function startBridge() {
  app.bridge = new BridgeReceiver({
    season: app.config.season,
    onStatus: (status) => {
      if (status.state === 'connected') {
        app.bridgeConnected = true;
        notice($('notice'), '');
        toast('ESPN-Tab verbunden');
      }
      renderStatus();
    },
    onData: ({ kind, value }) => {
      if (kind === 'players' && value.length) app.raw.players = value;
      else if (kind === 'schedule') app.raw.schedule = value;
      else if (kind === 'ratings' && Object.keys(value).length) {
        app.raw.ratings = value;
        app.raw.ratingsSeason = app.raw.ratingsSeason ?? app.config.season - 1;
      } else if (kind === 'settings') app.raw.settings = value;
      else if (kind === 'draft') {
        const changed = app.draftState.applyEspnDraft(value);
        fillTeamSelect();
        if (changed) toast('Draft aktualisiert');
      }
      rebuildSoon();
    },
  });
  app.bridge.start();
}

function fillTeamSelect() {
  const select = $('fMyTeam');
  const names = app.draftState.teamNames;
  const options = ['<option value="0">— noch nicht gewählt —</option>'];
  for (const [id, name] of Object.entries(names)) {
    options.push(`<option value="${id}">${name.replace(/</g, '&lt;')}</option>`);
  }
  if (select.options.length !== options.length) select.innerHTML = options.join('');
  select.value = String(app.config.myTeamId || 0);
}

/* ------------------------------------------------------------------ */
/* Formular / Ereignisse                                               */
/* ------------------------------------------------------------------ */

function fillForm() {
  $('fSeason').value = app.config.season;
  $('fLeague').value = app.config.leagueId;
  $('fRankType').value = app.config.rankType;
  $('fInterval').value = String(app.config.syncSeconds);
  $('fProxy').value = app.config.proxy;
  $('fHideDrafted').checked = app.config.hideDrafted;
  $('fOnlyHealthy').checked = app.config.onlyHealthy;
  $('fSort').value = app.filters.sort;
}

function readForm() {
  app.config.season = Number($('fSeason').value) || app.config.season;
  app.config.leagueId = $('fLeague').value.replace(/\D/g, '');
  app.config.rankType = $('fRankType').value;
  app.config.syncSeconds = Number($('fInterval').value) || 12;
  app.config.proxy = $('fProxy').value.trim();
  persist();
}

function persist() {
  saveConfig(app.config);
  writeHash(app.config);
}

function togglePanel(panelId, buttonId) {
  const panel = $(panelId);
  const button = $(buttonId);
  panel.hidden = !panel.hidden;
  button.setAttribute('aria-expanded', String(!panel.hidden));
}

function wire() {
  $('toggleSetup').addEventListener('click', () => togglePanel('setupPanel', 'toggleSetup'));
  $('toggleWeights').addEventListener('click', () => togglePanel('weightsPanel', 'toggleWeights'));

  for (const id of ['fSeason', 'fLeague', 'fRankType', 'fInterval', 'fProxy']) {
    $(id).addEventListener('change', readForm);
  }

  $('btnLoad').addEventListener('click', () => { readForm(); loadData(); });

  $('btnBridge').addEventListener('click', () => {
    const box = $('bridgeBox');
    box.hidden = false;
    readForm();
    const href = buildBookmarklet({
      boardUrl: shareUrl(app.config),
      season: app.config.season,
      intervalMs: Math.max(5, app.config.syncSeconds) * 1000,
    });
    $('bookmarkletLink').href = href;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  $('bookmarkletLink').addEventListener('click', (e) => {
    e.preventDefault();
    toast('Diesen Link in die Lesezeichenleiste ziehen — nicht hier klicken.');
  });

  $('btnCopyBookmarklet').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('bookmarkletLink').href);
      toast('Bookmarklet-Adresse kopiert');
    } catch {
      toast('Kopieren nicht möglich — Link stattdessen ziehen');
    }
  });

  $('btnShare').addEventListener('click', async () => {
    readForm();
    const url = shareUrl(app.config);
    try {
      if (navigator.share) await navigator.share({ title: 'Fantasy Draft Board', url });
      else { await navigator.clipboard.writeText(url); toast('Link kopiert'); }
    } catch { /* Nutzer hat abgebrochen */ }
  });

  $('btnExport').addEventListener('click', () => {
    const blob = new Blob([exportState(app.config, app.draftState)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `draft-board-${app.config.season}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('fImport').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const { config, drafted } = importState(await file.text());
      app.config = { ...app.config, ...config };
      app.draftState.restore([...drafted.entries()]);
      fillForm();
      renderSliders($('sliders'), app.config.weights);
      persist();
      rebuild();
      toast('Board importiert');
    } catch (err) {
      toast(`Import fehlgeschlagen: ${err.message}`);
    }
    e.target.value = '';
  });

  $('posTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    app.filters.pos = btn.dataset.pos;
    app.limit = LIST_STEP;
    renderTabs($('posTabs'), app.filters.pos);
    render();
  });

  $('fSearch').addEventListener('input', (e) => {
    app.filters.search = e.target.value;
    app.limit = LIST_STEP;
    render();
  });

  $('fSort').addEventListener('change', (e) => { app.filters.sort = e.target.value; render(); });

  $('fHideDrafted').addEventListener('change', (e) => {
    app.config.hideDrafted = e.target.checked; persist(); render();
  });
  $('fOnlyHealthy').addEventListener('change', (e) => {
    app.config.onlyHealthy = e.target.checked; persist(); render();
  });

  $('fMyTeam').addEventListener('change', (e) => {
    app.config.myTeamId = Number(e.target.value) || 0; persist(); render();
  });

  $('btnMore').addEventListener('click', () => { app.limit += LIST_STEP; render(); });

  $('sliders').addEventListener('input', (e) => {
    const key = e.target.dataset.weight;
    if (!key) return;
    const value = Number(e.target.value);
    app.config.weights[key] = value;
    const def = SLIDER_DEFS.find((d) => d.key === key);
    $(`wv_${key}`).textContent = formatWeight(def, value);
    persist();
    rebuildSoon();
  });

  $('btnResetWeights').addEventListener('click', () => {
    app.config.weights = { ...DEFAULT_WEIGHTS };
    renderSliders($('sliders'), app.config.weights);
    persist();
    rebuild();
  });

  // Klick auf eine Zeile: aufklappen. Klick auf den Button darin: Status wechseln.
  $('playerList').addEventListener('click', (e) => {
    const action = e.target.closest('[data-action="toggle-drafted"]');
    if (action) {
      const id = Number(action.dataset.id);
      if (!app.draftState.toggleManual(id, Number(app.config.myTeamId) || 0)) {
        toast('Dieser Pick kommt aus ESPN und lässt sich nicht überschreiben.');
      }
      render();
      return;
    }
    const row = e.target.closest('.row');
    if (!row) return;
    const id = Number(row.dataset.id);
    app.expandedId = app.expandedId === id ? null : id;
    render();
  });

  // Neue Picks muessen die Liste neu zeichnen, nicht nur die Statusleiste:
  // sonst bleiben gedraftete Spieler bis zur naechsten Interaktion stehen.
  app.draftState.onChange(() => { fillTeamSelect(); render(); });
  window.addEventListener('hashchange', () => { app.config = loadConfig(); fillForm(); });
}

/* ------------------------------------------------------------------ */

/**
 * Die Kopfzeile bricht je nach Displaybreite auf mehrere Zeilen um.
 * Die Steuerleiste muss genau darunter kleben, nicht dahinter verschwinden.
 */
function trackTopbarHeight() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  const apply = () => document.documentElement.style
    .setProperty('--topbar-h', `${Math.round(bar.getBoundingClientRect().height)}px`);
  apply();
  if (typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(bar);
  window.addEventListener('resize', apply);
}

function init() {
  fillForm();
  trackTopbarHeight();
  renderTabs($('posTabs'), app.filters.pos);
  renderSliders($('sliders'), app.config.weights);
  wire();
  startBridge();
  render();

  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (hash.get('bridge') === '1') {
    // Vom Bookmarklet geöffnet: auf die Daten aus dem ESPN-Tab warten.
    notice($('notice'), 'Warte auf Daten aus dem ESPN-Tab …');
  } else if (app.config.leagueId) {
    loadData();
  } else {
    $('setupPanel').hidden = false;
    $('toggleSetup').setAttribute('aria-expanded', 'true');
  }
}

init();

// Für Tests und manuelle Kontrolle in der Konsole.
window.__board = app;
export { app, POSITIONS, positionalLeagueAverage };
