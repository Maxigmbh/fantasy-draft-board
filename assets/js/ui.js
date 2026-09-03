/**
 * ui.js — Reines Rendering. Kein Netzwerk, kein Zustand:
 * jede Funktion bekommt die Daten übergeben und schreibt DOM.
 */

import { PRO_TEAM, healthLabel } from './espn.js';

export const POS_COLOR = {
  QB: 'var(--qb)', RB: 'var(--rb)', WR: 'var(--wr)',
  TE: 'var(--te)', K: 'var(--k)', 'D/ST': 'var(--dst)',
};

export const TABS = ['ALLE', 'QB', 'RB', 'WR', 'TE', 'FLEX', 'K', 'D/ST'];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const signed = (value, digits = 0) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`;

export const SLIDER_DEFS = [
  {
    key: 'offense', label: 'Offense-Stärke', min: 0, max: 0.4, step: 0.01,
    desc: 'Wie stark zählt das Fantasy-Volumen der eigenen Offense?',
  },
  {
    key: 'sos', label: 'Spielplan (SoS)', min: 0, max: 0.4, step: 0.01,
    desc: 'Wie stark zählen schwache Gegner-Defenses über die Saison?',
  },
  {
    key: 'playoffBoost', label: 'Playoff-Wochen', min: 1, max: 4, step: 0.1,
    desc: 'Extra-Gewicht der Fantasy-Playoffs im Spielplan.',
  },
  {
    key: 'health', label: 'Verletzungs-Abschlag', min: 0, max: 1, step: 0.05,
    desc: 'Wie hart schlägt ein Verletzungsstatus auf den Score durch?',
  },
  {
    key: 'market', label: 'Marktabgleich', min: 0, max: 0.6, step: 0.05,
    desc: 'Zieht das Board Richtung ESPN-ADP — 0 heißt: rein eigene Bewertung.',
  },
];

export function renderTabs(el, active) {
  el.innerHTML = TABS.map((tab) => `
    <button class="tab" role="tab" data-pos="${esc(tab)}"
            aria-selected="${tab === active}">${esc(tab)}</button>`).join('');
}

export function renderSliders(el, weights) {
  el.innerHTML = SLIDER_DEFS.map((def) => `
    <div class="slider">
      <div class="slider__head">
        <label class="slider__label" for="w_${def.key}">${esc(def.label)}</label>
        <output class="slider__value" id="wv_${def.key}">${formatWeight(def, weights[def.key])}</output>
      </div>
      <input type="range" id="w_${def.key}" data-weight="${def.key}"
             min="${def.min}" max="${def.max}" step="${def.step}"
             value="${Number(weights[def.key])}">
      <p class="slider__desc">${esc(def.desc)}</p>
    </div>`).join('');
}

export function formatWeight(def, value) {
  const n = Number(value) || 0;
  if (def.key === 'playoffBoost') return `${n.toFixed(1)}×`;
  return `${Math.round(n * 100)} %`;
}

export function renderChips(el, chips) {
  el.innerHTML = chips.map((c) => `<span class="chip ${c.tone ? `chip--${c.tone}` : ''}">${esc(c.text)}</span>`).join('');
}

/** Farbliche Einordnung des Verletzungsstatus. */
function healthTone(status) {
  const key = String(status || 'ACTIVE').toUpperCase();
  if (key === 'ACTIVE' || key === 'NORMAL' || key === 'PROBABLE') return null;
  if (key === 'QUESTIONABLE' || key === 'DAY_TO_DAY') return 'warn';
  return 'bad';
}

export function renderPlayers(el, players, ctx) {
  if (!players.length) {
    el.innerHTML = '<li class="hint" style="padding:20px;text-align:center">Keine Spieler für diesen Filter.</li>';
    return;
  }
  const maxScore = Math.max(1, ...players.map((p) => p.score));
  el.innerHTML = players.map((p) => rowHtml(p, ctx, maxScore)).join('');
}

function rowHtml(p, ctx, maxScore) {
  const pick = ctx.draftState.pickOf(p.id);
  const isMine = pick && ctx.myTeamId && pick.teamId === ctx.myTeamId;
  const classes = ['row'];
  if (pick) classes.push('row--drafted');
  if (isMine) classes.push('row--mine');

  const badges = [];
  badges.push(`<span class="badge badge--pos">${esc(p.pos)}${p.posRank ? ` ${p.posRank}` : ''}</span>`);
  badges.push(`<span class="badge">${esc(p.team)}</span>`);
  if (p.byeWeek) badges.push(`<span class="badge">BYE ${p.byeWeek}</span>`);
  badges.push(`<span class="badge">T${p.tier}</span>`);

  const tone = healthTone(p.injuryStatus);
  if (tone) badges.push(`<span class="badge badge--${tone}">${esc(healthLabel(p.injuryStatus))}</span>`);

  if (p.sos && Math.abs(p.sosZ) > 0.08) {
    const good = p.sosZ > 0;
    badges.push(`<span class="badge badge--${good ? 'good' : 'bad'}">SoS ${signed(p.sosZ * 100)}</span>`);
  }
  if (Math.abs(p.offZ) > 0.25) {
    badges.push(`<span class="badge badge--${p.offZ > 0 ? 'good' : 'bad'}">OFF ${signed(p.offZ * 100)}</span>`);
  }
  if (p.adpDelta !== null && Math.abs(p.adpDelta) >= 8) {
    badges.push(`<span class="badge badge--${p.adpDelta > 0 ? 'good' : 'warn'}">${p.adpDelta > 0 ? 'Value' : 'Reach'} ${signed(p.adpDelta)}</span>`);
  }
  if (pick) {
    const who = pick.source === 'espn'
      ? `${ctx.draftState.teamNames[pick.teamId] || `Team ${pick.teamId}`}${pick.round ? ` · R${pick.round}` : ''}`
      : 'manuell';
    badges.push(`<span class="badge">weg — ${esc(who)}</span>`);
  }

  const width = Math.max(2, Math.round((p.score / maxScore) * 100));
  const detail = ctx.expandedId === p.id ? detailHtml(p, ctx) : '';

  return `
    <li class="${classes.join(' ')}" data-id="${p.id}" style="--pos-color:${POS_COLOR[p.pos] || 'var(--muted)'}">
      <div class="row__rank">${p.rank}</div>
      <div class="row__main">
        <div class="row__name">${esc(p.name)}</div>
        <div class="row__sub">${badges.join('')}</div>
      </div>
      <div class="row__score">
        <span class="row__value">${p.score.toFixed(1)}</span>
        <span class="bar"><i style="width:${width}%"></i></span>
      </div>
      ${detail}
    </li>`;
}

function detailHtml(p, ctx) {
  const facts = [
    ['Projektion', `${p.projection.toFixed(0)} Pkt`],
    ['VOR', signed(p.vor, 0)],
    ['ESPN-ADP', p.adp > 0 ? p.adp.toFixed(1) : '—'],
    ['ESPN-Rank', p.espnRankPpr || p.espnRankStd || '—'],
    ['Besitzquote', `${Math.round(p.percentOwned)} %`],
    ['Status', healthLabel(p.injuryStatus)],
    ['Offense-Index', signed(p.offZ * 100)],
    ['Spielplan-Index', p.sos ? signed(p.sosZ * 100) : '—'],
  ];
  const factHtml = facts.map(([k, v]) => `<div class="fact">${esc(k)}<b>${esc(v)}</b></div>`).join('');

  return `
    <div class="row__detail">
      <div class="facts">${factHtml}</div>
      ${weeksHtml(p, ctx)}
      <div class="btnrow">
        <button class="btn btn--ghost" data-action="toggle-drafted" data-id="${p.id}">
          ${ctx.draftState.isDrafted(p.id) ? 'Als verfügbar markieren' : 'Als gedraftet markieren'}
        </button>
      </div>
    </div>`;
}

/** Wochenweiser Spielplan mit Matchup-Bewertung für die Position des Spielers. */
function weeksHtml(p, ctx) {
  const team = ctx.schedule?.[p.teamId];
  const table = ctx.ratings?.[p.pos];
  const avg = ctx.leagueAvg?.[p.pos];
  if (!team) return '<p class="hint">Kein Spielplan geladen.</p>';

  const playoff = new Set(ctx.playoffWeeks || []);
  const cells = [];
  for (let week = 1; week <= 18; week += 1) {
    if (week === team.byeWeek) {
      cells.push(`<span class="week week--bye">W${week} BYE</span>`);
      continue;
    }
    const game = team.opponents[week];
    if (!game) continue;
    const abbr = PRO_TEAM[game.opponentId] || '?';
    const rating = table?.[game.opponentId];
    let cls = 'week';
    let delta = '';
    if (rating && avg) {
      const diff = (rating.average - avg) / avg;
      if (diff > 0.05) cls += ' week--easy';
      else if (diff < -0.05) cls += ' week--hard';
      delta = ` ${signed(diff * 100)}%`;
    }
    if (playoff.has(week)) cls += ' week--po';
    cells.push(`<span class="${cls}">W${week} ${game.home ? 'vs' : '@'} ${esc(abbr)}${esc(delta)}</span>`);
  }
  const legend = table
    ? 'Grün = Defense lässt an dieser Position überdurchschnittlich viele Punkte zu. Unterstrichen = Fantasy-Playoffs.'
    : 'Ohne Defense-Ratings ist der Spielplan nur informativ.';
  return `<div class="weeks">${cells.join('')}</div><p class="hint">${legend}</p>`;
}

export function renderRoster(el, board, draftState, myTeamId, starters) {
  if (!myTeamId) {
    el.innerHTML = '<p class="hint">Team auswählen, um den eigenen Kader zu verfolgen.</p>';
    return;
  }
  const mine = board.players.filter((p) => {
    const pick = draftState.pickOf(p.id);
    return pick && pick.teamId === myTeamId;
  }).sort((a, b) => (draftState.pickOf(a.id).overall || 0) - (draftState.pickOf(b.id).overall || 0));

  const counts = {};
  for (const p of mine) counts[p.pos] = (counts[p.pos] || 0) + 1;

  const needs = Object.entries(starters)
    .filter(([slot]) => slot !== 'FLEX')
    .map(([slot, want]) => {
      const have = counts[slot] || 0;
      return `<div class="roster__slot"><span>${esc(slot)}</span><span>${have} / ${want}${have < want ? ' — offen' : ''}</span></div>`;
    }).join('');

  const list = mine.length
    ? mine.map((p) => {
      const pick = draftState.pickOf(p.id);
      return `<div class="roster__slot"><span>${esc(p.pos)}</span><span>${esc(p.name)} · ${esc(p.team)}${pick.round ? ` · R${pick.round}` : ''}</span></div>`;
    }).join('')
    : '<p class="hint">Noch kein Pick registriert.</p>';

  el.innerHTML = `${list}<p class="hint" style="margin-top:10px">Startplätze</p>${needs}`;
}

export function renderDiag(el, info) {
  const rows = info.map(([key, value]) => `<tr><td>${esc(key)}</td><td>${esc(value)}</td></tr>`).join('');
  el.innerHTML = `<table>${rows}</table>`;
}

let toastTimer = null;
export function toast(message, ms = 2600) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function notice(el, message, tone = '') {
  if (!message) { el.hidden = true; return; }
  el.className = `notice${tone ? ` notice--${tone}` : ''}`;
  el.textContent = message;
  el.hidden = false;
}
