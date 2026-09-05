/**
 * main.js — Oberflaeche des Draftboards.
 *
 * Die Seite liest ausschliesslich assets/data/board.json. Es gibt keinen
 * Netzzugriff zur Laufzeit; die Datei entsteht offline (siehe tools/).
 */

import {
  POSITIONS, DEFAULT_WEIGHTS, rankPlayers, filterPlayers, groupByTier, resolveList,
} from './board.js';

const $ = (id) => document.getElementById(id);
const STORAGE = 'draft-board:v2';
const POS_TABS = ['ALLE', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'DST'];

const SLIDERS = [
  {
    key: 'offense',
    label: 'Offense-Stärke',
    min: 0,
    max: 0.4,
    step: 0.01,
    desc: 'Wie stark zählt die erwartete Punktausbeute der eigenen Offense (aus Wettquoten geschätzt)?',
  },
  {
    key: 'sos',
    label: 'Spielplan',
    min: 0,
    max: 0.4,
    step: 0.01,
    desc: 'Wie stark zählen durchlässige Gegner-Defenses über die Saison, Playoff-Wochen doppelt?',
  },
];

const app = {
  data: null,
  players: [],
  view: 'board',
  filters: { pos: 'ALLE', search: '', sort: 'score' },
  weights: { ...DEFAULT_WEIGHTS },
  drafted: new Set(),
  hideDrafted: true,
  expandAll: false,
  openTiers: new Set([1]),
  expanded: null,
};

/* ------------------------------------------------------------------ */
/* Zustand                                                             */
/* ------------------------------------------------------------------ */

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE) || '{}');
    if (raw.weights) app.weights = { ...DEFAULT_WEIGHTS, ...raw.weights };
    if (Array.isArray(raw.drafted)) app.drafted = new Set(raw.drafted);
    if (typeof raw.hideDrafted === 'boolean') app.hideDrafted = raw.hideDrafted;
  } catch { /* gesperrter Storage: ohne Merken weitermachen */ }
}

function save() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify({
      weights: app.weights, drafted: [...app.drafted], hideDrafted: app.hideDrafted,
    }));
  } catch { /* egal */ }
}

/* ------------------------------------------------------------------ */
/* Hilfen                                                              */
/* ------------------------------------------------------------------ */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Nachname fuer die Tier-Vorschau — Zusaetze wie Jr. oder III zaehlen nicht. */
const SUFFIX = /^(jr|sr|ii|iii|iv|v)\.?$/i;
function surname(name) {
  const parts = String(name).split(' ').filter((w) => !SUFFIX.test(w));
  return parts[parts.length - 1] || name;
}

const signed = (v, digits = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;

function toast(message, ms = 2400) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ------------------------------------------------------------------ */
/* Rendern                                                             */
/* ------------------------------------------------------------------ */

function playerRow(p, { showRank = true } = {}) {
  const isDrafted = app.drafted.has(p.id);
  const cls = ['row'];
  if (isDrafted) cls.push('row--drafted');
  if (app.expanded === p.id) cls.push('row--open');

  const marks = [];
  if (p.injuryReserve) {
    marks.push(`<span class="badge badge--bad" title="Rosterstatus: ${esc(p.injuryLabel)}">${esc(p.injuryLabel)}</span>`);
  }
  if (p.handcuff) {
    marks.push(`<span class="badge badge--backup" title="Rueckt fuer ${esc(p.handcuffFor)} nach, falls der ausfaellt">Backup</span>`);
  }
  if (p.rookie) marks.push('<span class="badge badge--rookie">Rookie</span>');
  if (p.team === 'FA') marks.push('<span class="badge badge--warn">ohne Team</span>');
  if (p.value >= 12) marks.push(`<span class="badge badge--good">Wert ${signed(p.value)}</span>`);
  else if (p.value <= -12) marks.push(`<span class="badge badge--warn">Reach ${signed(p.value)}</span>`);

  const cell = (v, extra = '') => `<span class="c c--num ${extra}">${v}</span>`;
  const tone = (x) => (x > 0.15 ? 'up' : (x < -0.15 ? 'down' : ''));
  // Vorjahres-Positionierung direkt unter der ECR, wie gewuenscht: nicht als
  // eigene Spalte, sondern als Ergaenzung der bestehenden ECR-Zelle.
  const priorLabel = p.priorPosRank ? `${p.pos}${p.priorPosRank} '${String(app.data.meta.priorSeason).slice(-2)}`
    : (p.rookie ? 'Rookie' : '—');

  return `
    <li class="${cls.join(' ')}" data-id="${esc(p.id)}">
      <span class="c c--rank">${showRank ? p.rank : ''}</span>
      <span class="c c--check">
        <input type="checkbox" data-action="draft" data-id="${esc(p.id)}"
               ${isDrafted ? 'checked' : ''} aria-label="${esc(p.name)} als vergeben markieren">
      </span>
      <span class="c c--pick">${p.round}.${String(p.pickInRound).padStart(2, '0')}</span>
      <span class="c c--name">
        <b>${esc(p.name)}</b><em>(${esc(p.team)})</em>
        ${marks.join('')}
      </span>
      <span class="c c--pos"><i class="pos pos--${esc(p.pos)}">${esc(p.pos)}${p.boardPosRank}</i></span>
      ${cell(p.age !== null ? p.age.toFixed(1) : '—')}
      ${cell(p.best ?? '—')}
      ${cell(p.worst ?? '—')}
      <span class="c c--ecr">
        <b>${p.ecr.toFixed(1)}</b>
        <small>${esc(priorLabel)}</small>
      </span>
      ${cell(p.bye || '—')}
      ${cell(signed(p.offenseIndex * 100), tone(p.offenseIndex))}
      ${cell(signed(p.sosIndex * 100), tone(p.sosIndex))}
      <span class="c c--score">${p.score.toFixed(1)}</span>
    </li>
    ${app.expanded === p.id ? detailRow(p) : ''}`;
}

function detailRow(p) {
  const team = app.data.teams[p.team];
  const facts = [
    ['Experten-Ranking', `${p.ecr.toFixed(1)}${p.best ? ` (best ${p.best}, worst ${p.worst})` : ''}`],
    ['Uneinigkeit der Experten', p.sd ? p.sd.toFixed(2) : '—'],
    ['Handelswert vs. Ranking', p.marketDelta === null ? '—'
      : `${signed(p.marketDelta)} Plätze${p.marketDelta > 0 ? ' — günstiger gehandelt' : ''}`],
    ['Redraft-Ranking', p.ecrRedraft ? p.ecrRedraft.toFixed(1) : '—'],
    [`Punkte ${app.data.meta.priorSeason}`, p.priorPoints ? `${p.priorPoints} (${p.pos}${p.priorPosRank})` : 'kein Vorjahreswert'],
    [`Punkte ${app.data.meta.priorSeason - 1}`, p.prior2Points ? `${p.prior2Points} (${p.pos}${p.prior2PosRank})` : '—'],
    ['Rosterstatus', p.rosterStatus ? (p.injuryLabel ? `${p.injuryLabel} (Reserve-Liste)` : p.rosterStatus) : 'nicht ermittelt'],
    ['Besitzquote', p.owned ? `${Math.round(p.owned)} %` : '—'],
    ['Erwartete Teampunkte', team ? `${team.impliedSeason} / Spiel` : '—'],
    ['Anpassung', `${signed((p.adjust - 1) * 100, 1)} %`],
  ];
  if (p.handcuff) facts.splice(2, 0, ['Backup für', p.handcuffFor]);
  const weeks = (team?.schedule || []).map((g) => {
    const d = app.data.teams[g.opp]?.defense ?? 0;
    const cls = d > 0.5 ? 'week--easy' : d < -0.5 ? 'week--hard' : '';
    const po = app.data.meta.playoffWeeks.includes(g.week) ? ' week--po' : '';
    return `<span class="week ${cls}${po}">W${g.week} ${g.home ? 'vs' : '@'} ${esc(g.opp)}</span>`;
  }).join('');

  return `
    <li class="detail">
      <div class="facts">
        ${facts.map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      </div>
      ${weeks ? `<div class="weeks">${weeks}${team.bye ? `<span class="week week--bye">W${team.bye} BYE</span>` : ''}</div>
      <p class="hint">Grün = Gegner lässt überdurchschnittlich viele Punkte zu. Unterstrichen = Fantasy-Playoffs.</p>` : ''}
      <div class="btnrow">
        <button class="btn btn--ghost" data-action="draft" data-id="${esc(p.id)}">
          ${app.drafted.has(p.id) ? 'Wieder verfügbar' : 'Als weg markieren'}
        </button>
      </div>
    </li>`;
}

const HEAD = `
  <li class="row row--head">
    <span class="c c--rank">RK</span>
    <span class="c c--check"></span>
    <span class="c c--pick">Pick</span>
    <span class="c c--name">Spieler</span>
    <span class="c c--pos">Pos</span>
    <span class="c c--num">Alter</span>
    <span class="c c--num">Best</span>
    <span class="c c--num">Worst</span>
    <span class="c c--ecr" title="Expert Consensus Ranking von FantasyPros, darunter die Position, auf der er letzte Saison abgeschlossen hat">ECR</span>
    <span class="c c--num">Bye</span>
    <span class="c c--num" title="Offense-Staerke des Teams, aus Wettquoten geschaetzt">Off</span>
    <span class="c c--num" title="Durchlaessigkeit der Gegner-Defenses ueber die Saison">SoS</span>
    <span class="c c--score">Score</span>
  </li>`;

function renderBoard() {
  const list = filterPlayers(app.players, {
    ...app.filters, drafted: app.drafted, hideDrafted: app.hideDrafted,
  });
  const groups = app.filters.sort === 'score'
    ? groupByTier(list, app.filters.pos)
    : [{ tier: null, players: list }];

  $('listMeta').textContent = `${list.length} Spieler · ${app.drafted.size} weg`;

  $('views').innerHTML = groups.map((g) => {
    if (g.tier === null) {
      return `<ol class="list">${HEAD}${g.players.map((p) => playerRow(p)).join('')}</ol>`;
    }
    const open = app.expandAll || app.openTiers.has(g.tier);
    const best = g.players[0];
    const worst = g.players[g.players.length - 1];
    return `
      <section class="tier" data-tier="${g.tier}">
        <button class="tier__band" data-tier="${g.tier}" aria-expanded="${open}">
          <span class="tier__caret">${open ? '▾' : '▸'}</span>
          <span class="tier__name">Tier ${g.tier}</span>
          <span class="tier__meta">${g.players.length} Spieler · Score ${best.score.toFixed(1)}–${worst.score.toFixed(1)}</span>
          <span class="tier__preview">${g.players.slice(0, 5).map((p) => esc(surname(p.name))).join(' · ')}${g.players.length > 5 ? ' …' : ''}</span>
        </button>
        ${open ? `<ol class="list">${HEAD}${g.players.map((p) => playerRow(p)).join('')}</ol>` : ''}
      </section>`;
  }).join('') || '<p class="hint pad">Keine Spieler für diesen Filter.</p>';
}

function renderList(kind) {
  const ids = app.data.lists[kind] || [];
  const chosen = resolveList(app.players, ids)
    .filter((p) => !(app.hideDrafted && app.drafted.has(p.id)));
  $('listMeta').textContent = `${chosen.length} Spieler`;
  $('views').innerHTML = chosen.length
    ? `<ol class="list">${HEAD}${chosen.map((p) => playerRow(p)).join('')}</ol>`
    : '<p class="hint pad">Nichts übrig — alle bereits markiert.</p>';
}

const LEADS = {
  breakouts: 'Rookies und Spieler ohne nennenswerte Vorsaison, die erst ab der vierten Runde '
    + 'gehandelt werden. Genau dort liegt der Hebel: geringer Einsatz, offenes Ergebnis.',
  discount: 'Spieler, die letztes Jahr oder im Jahr davor unter den Top 30 ihrer Position lagen, '
    + 'ein aktuelles Team haben und gerade verletzt sind, also verspätet in die Saison starten '
    + '(rotes Badge nennt IR/PUP/NFI). Ohne einen solchen Fund als Ersatzsignal, wer stattdessen '
    + 'in der Redraft-Rangliste stark abgerutscht ist. Backup-Tag markiert zusätzlich Running Backs, '
    + 'die bei einem Ausfall des Starters selbst zum Starter würden.',
};

function render() {
  const isBoard = app.view === 'board';
  $('controls').classList.toggle('controls--slim', !isBoard);
  $('posTabs').hidden = !isBoard;
  $('viewLead').hidden = isBoard;
  if (!isBoard) $('viewLead').textContent = LEADS[app.view];

  if (isBoard) renderBoard(); else renderList(app.view);
  renderChips();
}

function renderChips() {
  const m = app.data.meta;
  const chips = [
    { text: `${m.rankingBasis === 'dynasty' ? 'Dynasty' : 'Redraft'} · ${m.league.teams} Teams ${m.league.scoring}` },
    { text: `Rankings ${m.scrapeDate}`, tone: 'live' },
    { text: `${app.players.length} Spieler` },
  ];
  $('statusChips').innerHTML = chips
    .map((c) => `<span class="chip ${c.tone ? `chip--${c.tone}` : ''}">${esc(c.text)}</span>`).join('');
}

function renderSliders() {
  $('sliders').innerHTML = SLIDERS.map((d) => `
    <div class="slider">
      <div class="slider__head">
        <label for="w_${d.key}">${esc(d.label)}</label>
        <output id="wv_${d.key}">${Math.round(app.weights[d.key] * 100)} %</output>
      </div>
      <input type="range" id="w_${d.key}" data-weight="${d.key}"
             min="${d.min}" max="${d.max}" step="${d.step}" value="${app.weights[d.key]}">
      <p class="slider__desc">${esc(d.desc)}</p>
    </div>`).join('');
  $('weightsNote').textContent = 'Beide Werte gelten je NFL-Team — alle Spieler eines Teams '
    + 'verschieben sich gemeinsam. Bei 0 % steht exakt die Expertenrangliste.';
}

function renderSources() {
  const m = app.data.meta;
  const rows = m.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>${s.date ? ` — Stand ${esc(s.date)}` : ''}</li>`).join('');
  $('sourcesBox').innerHTML = `
    <ul class="linklist">${rows}</ul>
    <p class="hint">
      Basis ist das Expert Consensus Ranking, übersetzt in einen Draft-Wert mit exponentiell
      fallender Kurve. Der Offense-Index zerlegt die Wettquoten aller ${m.lineGames} Spiele der
      Saison in erwartete Punkte je Team; der Spielplan-Index mittelt daraus die Durchlässigkeit
      der Gegner-Defenses, Fantasy-Playoffs (Woche ${m.playoffWeeks.join(', ')}) doppelt gewichtet.
    </p>
    <p class="hint">
      Grenzen: Quoten liegen nur für die vorderen Wochen vor, spätere Werte sind Modellschätzungen.
      Einen Verletzungs-Feed gibt es nicht — aktuelle Ausfälle stecken indirekt in der
      Redraft-Rangliste und damit in der Liste der versteckten Werte.
    </p>`;
  $('footNote').textContent = `Erzeugt ${new Date(m.generatedAt).toLocaleString('de-DE')} · `
    + `Saison ${m.season} · Vorjahreswerte aus ${m.priorSeason}. `
    + 'Inoffizielles Hilfsmittel, alle Daten aus offenen Quellen.';
}

/* ------------------------------------------------------------------ */
/* Ereignisse                                                          */
/* ------------------------------------------------------------------ */

function recompute() {
  app.players = rankPlayers(app.data.players, app.weights, app.data.meta.league.teams);
  render();
}

function wire() {
  $('viewTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.view');
    if (!btn) return;
    app.view = btn.dataset.view;
    app.expanded = null;
    for (const b of $('viewTabs').querySelectorAll('.view')) {
      b.setAttribute('aria-selected', String(b === btn));
    }
    render();
  });

  $('posTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    app.filters.pos = btn.dataset.pos;
    app.openTiers = new Set([1]);
    renderPosTabs();
    render();
  });

  $('fSearch').addEventListener('input', (e) => {
    app.filters.search = e.target.value;
    render();
  });
  $('fSort').addEventListener('change', (e) => { app.filters.sort = e.target.value; render(); });
  $('fHideDrafted').addEventListener('change', (e) => {
    app.hideDrafted = e.target.checked; save(); render();
  });
  $('fExpandAll').addEventListener('change', (e) => { app.expandAll = e.target.checked; render(); });

  $('toggleWeights').addEventListener('click', () => {
    const panel = $('weightsPanel');
    panel.hidden = !panel.hidden;
    $('toggleWeights').setAttribute('aria-expanded', String(!panel.hidden));
  });

  $('sliders').addEventListener('input', (e) => {
    const key = e.target.dataset.weight;
    if (!key) return;
    app.weights[key] = Number(e.target.value);
    $(`wv_${key}`).textContent = `${Math.round(app.weights[key] * 100)} %`;
    save();
    recompute();
  });

  $('btnResetWeights').addEventListener('click', () => {
    app.weights = { ...DEFAULT_WEIGHTS };
    renderSliders();
    save();
    recompute();
  });

  $('btnClearDrafted').addEventListener('click', () => {
    app.drafted.clear();
    save();
    render();
    toast('Markierungen gelöscht');
  });

  $('views').addEventListener('click', (e) => {
    const tierHead = e.target.closest('.tier__band');
    if (tierHead) {
      const t = Number(tierHead.dataset.tier);
      if (app.openTiers.has(t)) app.openTiers.delete(t); else app.openTiers.add(t);
      render();
      return;
    }
    const draftControl = e.target.closest('[data-action="draft"]');
    if (draftControl) {
      const { id } = draftControl.dataset;
      if (app.drafted.has(id)) app.drafted.delete(id); else app.drafted.add(id);
      save();
      render();
      // Der Klick auf die Checkbox darf die Detailzeile nicht mit oeffnen.
      e.stopPropagation();
      return;
    }
    const row = e.target.closest('.row');
    if (!row || row.classList.contains('row--head')) return;
    app.expanded = app.expanded === row.dataset.id ? null : row.dataset.id;
    render();
  });
}

function renderPosTabs() {
  $('posTabs').innerHTML = POS_TABS.map((t) => `
    <button class="tab" role="tab" data-pos="${t}"
            aria-selected="${t === app.filters.pos}">${t === 'DST' ? 'D/ST' : t}</button>`).join('');
}

/* ------------------------------------------------------------------ */

async function init() {
  load();
  try {
    const res = await fetch('assets/data/board.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    app.data = await res.json();
  } catch (err) {
    $('views').innerHTML = `<p class="notice notice--bad">Datendatei konnte nicht geladen werden (${esc(err.message)}). `
      + 'Die Seite braucht einen HTTP-Server — ein Doppelklick auf index.html genügt nicht.</p>';
    return;
  }
  $('fHideDrafted').checked = app.hideDrafted;
  $('fSort').value = app.filters.sort;
  renderPosTabs();
  renderSliders();
  renderSources();
  wire();
  recompute();
}

init();

// Fuer Tests und Kontrolle in der Konsole.
window.__board = app;
export { app, POSITIONS };
