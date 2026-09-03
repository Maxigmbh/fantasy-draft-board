/**
 * state.js — Konfiguration, lokale Persistenz und Teilen per Link.
 *
 * Die Liga-Konfiguration und die Gewichte liegen im URL-Hash, damit ein
 * geteilter Link bei Freunden dasselbe Board erzeugt. Draft-Fortschritt und
 * private Cookies bleiben ausschließlich lokal im Browser.
 */

import { DEFAULT_WEIGHTS } from './model.js';

const STORAGE_KEY = 'fantasy-board:v1';

export const DEFAULT_CONFIG = {
  season: new Date().getUTCFullYear(),
  leagueId: '',
  proxy: '',
  rankType: 'PPR',
  myTeamId: 0,
  autoSync: true,
  syncSeconds: 12,
  hideDrafted: true,
  onlyHealthy: false,
  weights: { ...DEFAULT_WEIGHTS },
};

/** Nur diese Felder wandern in den Teilen-Link — nichts Persönliches. */
const SHAREABLE = ['season', 'leagueId', 'rankType', 'weights'];

function safeParse(text, fallback) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

export function loadConfig() {
  let stored = {};
  try {
    stored = safeParse(localStorage.getItem(STORAGE_KEY) || '{}', {});
  } catch {
    stored = {}; // Privates Surfen / gesperrter Storage: einfach ohne weitermachen.
  }
  const fromHash = readHash();
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    ...fromHash,
    weights: { ...DEFAULT_WEIGHTS, ...(stored.weights || {}), ...(fromHash.weights || {}) },
  };
}

export function saveConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* Storage nicht verfügbar — die App funktioniert trotzdem, nur ohne Merken. */
  }
}

export function readHash() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return {};
  const params = new URLSearchParams(hash);
  const out = {};
  if (params.get('season')) out.season = Number(params.get('season'));
  if (params.get('league')) out.leagueId = params.get('league');
  if (params.get('rank')) out.rankType = params.get('rank');
  const w = params.get('w');
  if (w) {
    const parts = w.split(',').map(Number);
    const keys = ['offense', 'sos', 'health', 'playoffBoost', 'market'];
    const weights = {};
    keys.forEach((key, i) => {
      if (Number.isFinite(parts[i])) weights[key] = parts[i];
    });
    if (Object.keys(weights).length) out.weights = weights;
  }
  return out;
}

export function shareUrl(config) {
  const params = new URLSearchParams();
  params.set('season', String(config.season));
  if (config.leagueId) params.set('league', config.leagueId);
  params.set('rank', config.rankType);
  const w = config.weights || DEFAULT_WEIGHTS;
  params.set('w', [w.offense, w.sos, w.health, w.playoffBoost, w.market]
    .map((v) => Number(v).toFixed(2)).join(','));
  return `${location.origin}${location.pathname}#${params.toString()}`;
}

export function writeHash(config) {
  const url = shareUrl(config);
  const hash = url.slice(url.indexOf('#'));
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

/** Kompletter Board-Zustand als Datei — für Backup oder Weitergabe. */
export function exportState(config, draftState) {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    config: Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'proxy')),
    draft: { drafted: [...draftState.drafted.entries()] },
  };
  return JSON.stringify(payload, null, 2);
}

export function importState(text) {
  const data = safeParse(text, null);
  if (!data || data.version !== 1) throw new Error('Unbekanntes Dateiformat');
  const config = { ...DEFAULT_CONFIG, ...(data.config || {}) };
  config.weights = { ...DEFAULT_WEIGHTS, ...(data.config?.weights || {}) };
  const drafted = new Map(
    Array.isArray(data.draft?.drafted) ? data.draft.drafted : [],
  );
  return { config, drafted };
}

export function pickShareable(config) {
  return Object.fromEntries(SHAREABLE.map((key) => [key, config[key]]));
}
