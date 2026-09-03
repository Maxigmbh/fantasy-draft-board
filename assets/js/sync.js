/**
 * sync.js — Live-Abgleich mit dem laufenden ESPN-Draft.
 *
 * Zwei Wege, weil ESPN keine CORS-Header garantiert:
 *
 *  A) Direkt   Das Board pollt die ESPN-API selbst. Bequem, funktioniert aber
 *              nur, wenn ESPN die Origin des Boards erlaubt (oder ein Proxy
 *              hinterlegt ist).
 *  B) Bridge   Ein Bookmarklet läuft im ESPN-Tab, holt die Daten dort
 *              gleich-origin (inkl. Login-Cookies) und schickt sie per
 *              postMessage ans Board. Umgeht CORS vollständig.
 *
 * Zusätzlich lässt sich jeder Spieler manuell als "weg" markieren.
 */

import { parseDraft, parsePlayers, parseSchedule, parsePositionalRatings, parseSettings } from './espn.js';

const ESPN_ORIGINS = new Set([
  'https://fantasy.espn.com',
  'https://www.espn.com',
  'https://espn.com',
  'https://lm-api-reads.fantasy.espn.com',
]);

export class DraftState {
  constructor() {
    /** playerId -> { teamId, overall, round, roundPick, source } */
    this.drafted = new Map();
    this.teamNames = {};
    this.inProgress = false;
    this.lastUpdate = null;
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  isDrafted(playerId) {
    return this.drafted.has(Number(playerId));
  }

  pickOf(playerId) {
    return this.drafted.get(Number(playerId)) || null;
  }

  get count() {
    return this.drafted.size;
  }

  /** Manuelles Umschalten. ESPN-Picks lassen sich so nicht überschreiben. */
  toggleManual(playerId, teamId = 0) {
    const id = Number(playerId);
    const existing = this.drafted.get(id);
    if (existing && existing.source === 'espn') return false;
    if (existing) this.drafted.delete(id);
    else this.drafted.set(id, { teamId, overall: 0, round: 0, roundPick: 0, source: 'manual' });
    this.lastUpdate = new Date();
    this._emit();
    return true;
  }

  /**
   * Übernimmt den Stand aus ESPN. ESPN ist die Wahrheit: Picks, die dort
   * nicht (mehr) stehen, verlieren ihre ESPN-Markierung.
   */
  applyEspnDraft(draft) {
    const next = new Map();
    for (const pick of draft.picks) {
      next.set(pick.playerId, {
        teamId: pick.teamId,
        overall: pick.overall,
        round: pick.round,
        roundPick: pick.roundPick,
        keeper: pick.keeper,
        source: 'espn',
      });
    }
    // Manuelle Markierungen erhalten, solange ESPN nichts anderes sagt.
    for (const [id, entry] of this.drafted) {
      if (entry.source === 'manual' && !next.has(id)) next.set(id, entry);
    }
    const changed = next.size !== this.drafted.size
      || [...next.keys()].some((id) => !this.drafted.has(id));

    this.drafted = next;
    this.teamNames = draft.teamNames || this.teamNames;
    this.inProgress = draft.inProgress;
    this.lastUpdate = new Date();
    this._emit();
    return changed;
  }

  restore(entries) {
    this.drafted = new Map(entries);
    this._emit();
  }

  clear() {
    this.drafted.clear();
    this.lastUpdate = new Date();
    this._emit();
  }
}

/** Wiederholtes Direkt-Polling der ESPN-API durch das Board selbst. */
export class DraftPoller {
  constructor({ client, draftState, intervalMs = 12000, onStatus = () => {} }) {
    this.client = client;
    this.draftState = draftState;
    this.intervalMs = intervalMs;
    this.onStatus = onStatus;
    this.timer = null;
    this.failures = 0;
  }

  get running() {
    return this.timer !== null;
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.onStatus({ state: 'running' });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onStatus({ state: 'stopped' });
  }

  async tick() {
    try {
      const draft = await this.client.fetchDraft();
      this.failures = 0;
      const changed = this.draftState.applyEspnDraft(draft);
      this.onStatus({
        state: 'ok', changed, picks: draft.picks.length, inProgress: draft.inProgress,
      });
    } catch (err) {
      this.failures += 1;
      this.onStatus({ state: 'error', error: err, failures: this.failures });
      // Nach mehreren Fehlversuchen aufhören zu hämmern.
      if (this.failures >= 5) this.stop();
    }
  }
}

/**
 * Empfängt Daten aus dem ESPN-Tab (Bookmarklet). Akzeptiert ausschließlich
 * Nachrichten von ESPN-Origins.
 */
export class BridgeReceiver {
  constructor({ season, onData = () => {}, onStatus = () => {} }) {
    this.season = season;
    this.onData = onData;
    this.onStatus = onStatus;
    this.connected = false;
    this._handler = (event) => this._receive(event);
  }

  start() {
    window.addEventListener('message', this._handler);
    // Das Board wurde vom Bookmarklet geöffnet: Bereitschaft melden.
    if (window.opener) {
      for (const origin of ESPN_ORIGINS) {
        try {
          window.opener.postMessage({ source: 'fantasy-board', kind: 'ready' }, origin);
        } catch { /* falsche Origin — der nächste Versuch trifft. */ }
      }
    }
  }

  stop() {
    window.removeEventListener('message', this._handler);
  }

  _receive(event) {
    if (!ESPN_ORIGINS.has(event.origin)) return;
    const msg = event.data;
    if (!msg || msg.source !== 'espn-bridge') return;

    if (!this.connected) {
      this.connected = true;
      this.onStatus({ state: 'connected', origin: event.origin });
    }
    try {
      switch (msg.kind) {
        case 'hello':
          this.onStatus({ state: 'hello', payload: msg.payload });
          break;
        case 'settings':
          this.onData({ kind: 'settings', value: parseSettings(msg.payload) });
          break;
        case 'players':
          this.onData({ kind: 'players', value: parsePlayers(msg.payload, this.season) });
          break;
        case 'schedule':
          this.onData({ kind: 'schedule', value: parseSchedule(msg.payload) });
          break;
        case 'ratings':
          this.onData({ kind: 'ratings', value: parsePositionalRatings(msg.payload) });
          break;
        case 'draft':
          this.onData({ kind: 'draft', value: parseDraft(msg.payload) });
          break;
        default:
          break;
      }
    } catch (err) {
      this.onStatus({ state: 'error', error: err });
    }
  }
}

/**
 * Baut das Bookmarklet, das im ESPN-Tab läuft.
 * Bewusst kompakt gehalten — Bookmarklets sind in der Länge begrenzt.
 */
export function buildBookmarklet({ boardUrl, season, intervalMs = 12000 }) {
  const base = boardUrl.split('#')[0];
  const origin = new URL(base).origin;
  const src = `(function(){
var q=new URLSearchParams(location.search);
var L=q.get('leagueId')||q.get('leagueid')||prompt('ESPN League-ID?');
if(!L)return;
var S=q.get('seasonId')||'${season}';
var W=window.open('${base}#bridge=1&league='+L+'&season='+S,'fantasyBoardBridge');
if(!W){alert('Bitte Pop-ups fuer espn.com erlauben und erneut klicken.');return;}
var H='https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/';
var LG=H+S+'/segments/0/leagues/'+L;
var F={players:{filterSlotIds:{value:[0,2,4,6,16,17,23]},limit:1000,sortDraftRanks:{sortPriority:100,sortAsc:true,value:'PPR'},sortPercOwned:{sortPriority:1,sortAsc:false}}};
function g(u,f){var o={credentials:'include',headers:{}};if(f)o.headers['X-Fantasy-Filter']=JSON.stringify(f);return fetch(u,o).then(function(r){if(!r.ok)throw 0;return r.json()})}
function s(k,d){try{W.postMessage({source:'espn-bridge',kind:k,payload:d},'${origin}')}catch(e){}}
var booted=0;
function boot(){if(booted)return;booted=1;
g(LG+'?view=mSettings').then(function(d){s('settings',d)}).catch(function(){});
g(LG+'?view=kona_player_info',F).then(function(d){s('players',d)}).catch(function(){
g(H+S+'/players?scoringPeriodId=0&view=kona_player_info',F).then(function(d){s('players',d)}).catch(function(){})});
g(H+S+'?view=proTeamSchedules_wl').then(function(d){s('schedule',d)}).catch(function(){});
var P=(S-1);
g(H+P+'/segments/0/leagues/'+L+'?view=mPositionalRatings').then(function(d){s('ratings',d)}).catch(function(){
g(H+P+'?view=mPositionalRatings').then(function(d){s('ratings',d)}).catch(function(){
g(LG+'?view=mPositionalRatings').then(function(d){s('ratings',d)}).catch(function(){})})});
p()}
function p(){g(LG+'?view=mDraftDetail&view=mTeam').then(function(d){s('draft',d)}).catch(function(){})}
window.addEventListener('message',function(e){var d=e.data;if(d&&d.source==='fantasy-board'&&d.kind==='ready'){s('hello',{league:L,season:S});boot()}});
setTimeout(boot,4000);
setInterval(p,${intervalMs});
})()`;
  return `javascript:${encodeURIComponent(src.replace(/\n/g, ''))}`;
}
