/* ============================================================
   DATA LAYER
   Two modes:
   - "live":  served by our Cloudflare app → data comes from the database (/api/data).
              Read-only for now (admin editing comes with Telegram login).
   - "local": opened as a file / on GitHub Pages → data lives in this browser
              (localStorage) and can be edited, backed up and restored.
   ============================================================ */
'use strict';

const ROLES = {
  citizen: { label: 'Citizen', short: 'МИР', team: 'town' },
  sheriff: { label: 'Sheriff', short: 'Ш',   team: 'town' },
  doctor:  { label: 'Doctor',  short: 'ЛІК', team: 'town' },
  maniac:  { label: 'Maniac',  short: 'МАН', team: 'town' },   // plays with the citizens
  mafia:   { label: 'Mafia',   short: 'М',   team: 'mafia' },
  don:     { label: 'Don',     short: 'ДМ',  team: 'mafia' },
};
const ROLE_ORDER = ['citizen', 'sheriff', 'doctor', 'maniac', 'mafia', 'don'];
const TEAM_LABEL = { town: 'Citizens', mafia: 'Mafia' };

/** Suggested role pack for N players (used by "Random roles"; you can always edit). */
function roleSetup(n) {
  const mafiaTeam = n <= 8 ? 2 : n <= 11 ? 3 : 4;
  const setup = { don: 1, mafia: mafiaTeam - 1, sheriff: 1, doctor: n >= 10 ? 1 : 0, maniac: n >= 11 ? 1 : 0 };
  setup.citizen = n - Object.values(setup).reduce((a, b) => a + b, 0);
  return setup;
}

function pct(x) {
  return x == null || isNaN(x) ? '—' : Math.round(x * 100) + '%';
}

/** Players per game: 7 to 16 (the server checks the same limits). */
const SEATS_MIN = 7, SEATS_MAX = 16;
const seatOptions = () => Array.from({ length: SEATS_MAX - SEATS_MIN + 1 }, (_, k) => k + SEATS_MIN);

const DEFAULT_SETTINGS = { minGames: 3, priorWeight: 5, defaultSeats: 10 };

/** Small JSON fetch helper for our API. Throws Error(message) on failure. */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const Store = (() => {
  const KEY = 'mafia-bcn-db';
  let db = null;
  let mode = 'local';
  let me = { loginAvailable: false, user: null };
  let admin = { players: [], accounts: [] };      // private data, admin only
  const listeners = new Set();
  let saveState = 'idle';                         // idle | saving | saved | error

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const empty = () => ({ schema: 2, players: [], games: [], settings: { ...DEFAULT_SETTINGS } });

  /* ---- normalize / migrate older local data to the current shape ---- */
  function normalizeRound(r) {
    r = r || {};
    const day = r.day || {};
    const night = r.night || {};
    return {
      nominations: Array.isArray(r.nominations) ? r.nominations : [],
      eliminated: r.eliminated || day.eliminated || [],
      removed: r.removed || day.removed || [],
      night: {
        mafiaKill: night.mafiaKill ?? night.kill ?? null,
        donCheck: night.donCheck ?? null,
        sheriffCheck: night.sheriffCheck ?? null,
        maniacKill: night.maniacKill ?? null,
        doctorHeal: night.doctorHeal ?? null,
      },
    };
  }
  function normalize(d) {
    const base = empty();
    d = d && typeof d === 'object' ? d : {};
    const out = {
      ...base, ...d,
      settings: { ...base.settings, ...(d.settings || {}) },
      players: (Array.isArray(d.players) ? d.players : []).map((p, i) => ({ ...p, id: String(p.id), number: p.number || i + 1, nickname: p.nickname || p.name || '?' })),
      games: (Array.isArray(d.games) ? d.games : []).map(g => ({
        notes: '', source: 'app', ...g,
        id: String(g.id),
        seats: (g.seats || []).map(s => ({ fouls: 0, alive: null, ...s, playerId: s.playerId == null ? null : String(s.playerId) })),
        rounds: (g.rounds || []).map(normalizeRound),
      })),
    };
    out.schema = 2;
    return out;
  }

  /* ---- loading ----
     Live site: the browser keeps its own copy of the public data (+ version) in localStorage.
     Each visit asks the server "is my version still current?" (1 tiny request, 0 database reads).
     Anti-spam: 3 checks per minute are free; after that the device must wait 10 s, then 30 s,
     60 s, 2 min, 5 min (like "resend SMS code"). While waiting, the saved copy is shown. */
  const CACHE_KEY = 'mafia-bcn-live-cache';
  const CHECKS_KEY = 'mafia-bcn-checks';
  const WAITS = [0, 10, 30, 60, 120, 300];
  let throttledFor = 0;

  function readCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY));
      if (c && c.version && c.data && Array.isArray(c.data.games) && Array.isArray(c.data.players)) return c;
    } catch (e) { /* missing or broken → download again */ }
    return null;
  }
  function writeCache(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* storage full or blocked */ } }

  /** Returns 0 if a check is allowed now, otherwise seconds to wait. */
  function checkThrottle() {
    let st;
    try { st = JSON.parse(localStorage.getItem(CHECKS_KEY)) || {}; } catch (e) { st = {}; }
    const now = Date.now();
    const save = () => { try { localStorage.setItem(CHECKS_KEY, JSON.stringify(st)); } catch (e) { /* ignore */ } };
    if (st.until && now < st.until) return Math.ceil((st.until - now) / 1000);
    if (st.until && now - st.until > 10 * 60e3) st.level = 0;          // calm for 10 minutes → forgiven
    st.times = (st.times || []).filter(t => now - t < 60e3);
    if (st.times.length >= 3) {
      st.level = Math.min((st.level || 0) + 1, WAITS.length - 1);
      st.until = now + WAITS[st.level] * 1000;
      st.times = [];
      save();
      return WAITS[st.level];
    }
    st.times.push(now);
    save();
    return 0;
  }

  async function init() {
    if (location.protocol.startsWith('http')) {
      const cache = readCache();
      const useCache = () => { db = normalize(cache.data); mode = 'live'; me = cache.me || me; return db; };
      // Admins are never throttled (role remembered from the last visit; the server checks it anyway).
      const wasAdmin = cache && cache.me && cache.me.user && cache.me.user.role === 'admin';
      // Just logged in (?fresh=1) → always ask the server once.
      const fresh = new URLSearchParams(location.search).has('fresh');
      if (fresh) history.replaceState(null, '', location.pathname + location.hash);
      if (cache && !wasAdmin && !fresh) {
        const wait = checkThrottle();
        if (wait) { throttledFor = wait; return useCache(); }
      }
      try {
        const res = await fetch('/api/data' + (cache ? '?v=' + encodeURIComponent(cache.version) : ''), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
        if (res.status === 429 && cache) { throttledFor = 60; return useCache(); }
        if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
          const body = await res.json();
          mode = 'live';
          me = body.me || me;
          if (body.unchanged && cache) {
            db = normalize(cache.data);
            if (JSON.stringify(cache.me) !== JSON.stringify(me)) writeCache({ ...cache, me });
          } else {
            db = normalize(body.data);
            writeCache({ version: body.version, data: body.data, me, savedAt: new Date().toISOString() });
          }
          if (isAdmin()) await loadAdmin();
          return db;
        }
      } catch (e) {
        if (cache) return useCache();      // offline: show the saved copy
      }
    }
    mode = 'local';
    try { db = normalize(JSON.parse(localStorage.getItem(KEY))); }
    catch (e) { db = empty(); }
    return db;
  }
  const throttleWait = () => throttledFor;

  async function loadAdmin() {
    try { admin = await api('/api/admin/players'); } catch (e) { console.warn(e); }
    return admin;
  }

  function saveLocal() {
    if (mode !== 'local') return true;
    db.updatedAt = new Date().toISOString();
    try { localStorage.setItem(KEY, JSON.stringify(db)); return true; }
    catch (e) { console.error(e); alert('Could not save to browser storage: ' + e.message); return false; }
  }

  const get = () => db;
  const isLive = () => mode === 'live';
  const user = () => me.user;
  const loginAvailable = () => me.loginAvailable;
  const devLogin = () => !!me.devLogin;
  const isAdmin = () => mode === 'live' && me.user && me.user.role === 'admin';
  const canEdit = () => mode === 'local' || isAdmin();
  const adminData = () => admin;

  /* ---- save status (shown in the top bar) ---- */
  function setSaveState(s, msg) { saveState = s; listeners.forEach(fn => fn(s, msg)); }
  const onSaveState = fn => listeners.add(fn);

  function replace(newDb) { db = normalize(newDb); saveLocal(); }
  function clear() { db = empty(); saveLocal(); }

  /* ---------- players ---------- */
  async function addPlayer(nickname) {
    nickname = String(nickname || '').trim();
    if (!nickname) return null;
    const existing = db.players.find(p => p.nickname.toLowerCase() === nickname.toLowerCase());
    if (existing) return existing;
    let p;
    if (isLive()) {
      p = await api('/api/admin/players', { method: 'POST', body: { nickname } });
      admin.players.push({ ...p, first_name: null, last_name: null });
    } else {
      p = { id: uid(), number: Math.max(0, ...db.players.map(x => x.number || 0)) + 1, nickname, createdAt: new Date().toISOString() };
    }
    db.players.push(p);
    saveLocal();
    return p;
  }
  async function updatePlayer(id, patch) {
    const p = player(id);
    if (!p) return;
    if (isLive()) {
      await api('/api/admin/players/' + id, { method: 'PATCH', body: patch });
      await loadAdmin();
    }
    if (patch.nickname) p.nickname = patch.nickname;
    saveLocal();
  }
  const playerInUse = id => db.games.some(g => g.seats.some(s => s.playerId === String(id)));
  async function deletePlayer(id) {
    if (playerInUse(id)) return false;
    if (isLive()) await api('/api/admin/players/' + id, { method: 'DELETE' });
    db.players = db.players.filter(p => p.id !== String(id));
    saveLocal();
    return true;
  }
  async function updateAccount(id, patch) {
    await api('/api/admin/accounts/' + id, { method: 'PATCH', body: patch });
    await loadAdmin();
  }
  const player = id => db.players.find(p => p.id === String(id));
  const playerName = id => (player(id) || {}).nickname || '(unknown)';

  /* ---------- games ---------- */
  /** A new game exists only in the browser until its first "Save changes". */
  function draftGame(date, seats) {
    const n = seats || +db.settings.defaultSeats || 10;
    const sameDay = db.games.filter(x => x.date === date);
    return normalize({ games: [{
      id: 'new', date,
      number: sameDay.length ? Math.max(...sameDay.map(x => x.number)) + 1 : 1,
      seats: Array.from({ length: n }, (_, i) => ({ seat: i + 1, playerId: null, role: null, alive: null, fouls: 0 })),
      rounds: [], winner: null, notes: '', source: 'app',
    }] }).games[0];
  }

  function prepareForSave(g) {
    const tl = GameLogic.timeline(g);
    return JSON.parse(JSON.stringify({
      ...g,
      seats: g.seats.map(s => ({ ...s, alive: g.source === 'xls' ? s.alive : (tl.alive.includes(s.seat) ? 1 : 0) })),
    }));
  }

  /** Save a whole game (called by the editor's "Save changes" button). Creates it on the first save. Throws on failure. */
  async function saveGame(g) {
    const copy = prepareForSave(g);
    const isNew = copy.id === 'new';
    if (isLive()) {
      setSaveState('saving');
      try {
        if (isNew) copy.id = String((await api('/api/admin/games', { method: 'POST', body: copy })).id);
        else await api('/api/admin/games/' + g.id, { method: 'PUT', body: copy });
      } catch (e) { setSaveState('error', e.message); throw e; }
      setSaveState('saved');
    } else if (isNew) copy.id = uid();
    const saved = normalize({ games: [copy] }).games[0];
    const i = db.games.findIndex(x => x.id === saved.id);
    if (i >= 0) db.games[i] = saved; else db.games.push(saved);
    saveLocal();
    return game(saved.id);
  }
  const game = id => db.games.find(g => g.id === String(id));
  async function deleteGame(id) {
    if (isLive()) await api('/api/admin/games/' + id, { method: 'DELETE' });
    db.games = db.games.filter(g => g.id !== String(id));
    saveLocal();
  }
  /** Running number across all games (like the Attendance sheet: 1, 2, 3 …). Works for an unsaved draft too. */
  function overallNumber(g) {
    return db.games.filter(x => x.id !== String(g.id) && (x.date < g.date || (x.date === g.date && x.number < g.number))).length + 1;
  }
  /** Games are addressed by date + game number of that day: /game/17-05-2026/1 */
  const gameByDay = (date, number) => db.games.find(g => g.date === date && g.number === +number);
  const playerByNumber = n => db.players.find(p => p.number === +n);
  const sortedGames = () => [...db.games].sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number);

  async function saveSettings(patch) {
    if (isLive()) await api('/api/admin/settings', { method: 'PUT', body: patch });
    Object.assign(db.settings, patch);
    saveLocal();
  }

  const listBackups = () => api('/api/admin/backups');
  const backupNow = () => api('/api/admin/backups', { method: 'POST', body: {} });
  const notifyTest = () => api('/api/admin/notify-test', { method: 'POST', body: {} });
  const bot = {
    state: () => api('/api/admin/bot'),
    setup: () => api('/api/admin/bot/setup', { method: 'POST', body: {} }),
    send: post => api('/api/admin/bot/posts', { method: 'POST', body: post }),
    process: id => api(`/api/admin/bot/posts/${id}/process`, { method: 'POST', body: {} }),
    edit: (id, text) => api(`/api/admin/bot/posts/${id}`, { method: 'PUT', body: { text } }),
    remove: id => api(`/api/admin/bot/posts/${id}`, { method: 'DELETE' }),
  };

  async function logout() {
    try { localStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  }

  return {
    uid, init, throttleWait, get, isLive, canEdit, isAdmin, user, loginAvailable, devLogin, adminData, loadAdmin,
    onSaveState, replace, clear, saveLocal, logout,
    addPlayer, updatePlayer, deletePlayer, updateAccount, playerInUse, player, playerName,
    draftGame, saveGame, game, gameByDay, playerByNumber, deleteGame, sortedGames, overallNumber, saveSettings,
    listBackups, backupNow, notifyTest, bot,
  };
})();

/* ============================================================
   GAME LOGIC
   A round = Night N (shots, checks, heal) then Day N (nominations, vote-outs).
   ============================================================ */
const GameLogic = {
  emptyRound() {
    return {
      nominations: [],                 // [{ by: seat, target: seat, votes: n }]
      eliminated: [], removed: [],     // seats voted out / removed for fouls
      night: { mafiaKill: null, donCheck: null, sheriffCheck: null, maniacKill: null, doctorHeal: null },
    };
  },

  teamOf(game, seat) {
    const s = game.seats.find(x => x.seat === +seat);
    return s && s.role ? ROLES[s.role].team : null;
  },
  hasRole(game, role) { return game.seats.some(s => s.role === role); },

  /** Night deaths: mafia shot and maniac shot, unless the doctor healed that seat. */
  nightDeaths(night) {
    const out = [];
    if (night.mafiaKill && night.mafiaKill !== night.doctorHeal) out.push({ seat: night.mafiaKill, type: 'killed' });
    if (night.maniacKill && night.maniacKill !== night.doctorHeal && night.maniacKill !== night.mafiaKill) out.push({ seat: night.maniacKill, type: 'maniac' });
    return out;
  },

  timeline(game) {
    const fates = {};                     // seat -> { type, round }
    const alive = new Set(game.seats.map(s => s.seat));
    const phases = [];                    // who was alive at the START of each phase
    game.rounds.forEach((r, i) => {
      const n = i + 1;
      phases.push({ round: n, phase: 'night', alive: [...alive] });
      this.nightDeaths(r.night || {}).forEach(d => { if (alive.has(d.seat)) { alive.delete(d.seat); fates[d.seat] = { type: d.type, round: n }; } });
      phases.push({ round: n, phase: 'day', alive: [...alive] });
      (r.removed || []).forEach(s => { if (alive.has(s)) { alive.delete(s); fates[s] = { type: 'removed', round: n }; } });
      (r.eliminated || []).forEach(s => { if (alive.has(s)) { alive.delete(s); fates[s] = { type: 'voted', round: n }; } });
    });
    // Imported games only know "alive at the end": trust that when it is recorded.
    const explicit = game.source === 'xls' && game.seats.some(s => s.alive === 0 || s.alive === 1);
    let finalAlive = [...alive];
    if (explicit) {
      finalAlive = game.seats.filter(s => s.alive === 1).map(s => s.seat);
      game.seats.forEach(s => { if (s.alive === 0 && !fates[s.seat]) fates[s.seat] = { type: 'died', round: null }; });
    }
    return { fates, alive: finalAlive.sort((a, b) => a - b), phases };
  },

  isAliveAtEnd(game, seat, tl) { return (tl || this.timeline(game)).alive.includes(seat); },

  roleCounts(game) {
    const c = Object.fromEntries(ROLE_ORDER.map(r => [r, 0]));
    game.seats.forEach(s => { if (s.role) c[s.role]++; });
    return c;
  },

  suggestWinner(game) {
    if (!game.rounds.length || game.seats.some(s => !s.role)) return null;
    const { alive } = this.timeline(game);
    const mafia = alive.filter(n => this.teamOf(game, n) === 'mafia').length;
    const town = alive.length - mafia;
    if (mafia === 0) return 'town';
    if (mafia >= town) return 'mafia';
    return null;
  },

  validate(game) {
    const w = [];
    const empty = game.seats.filter(s => !s.playerId).length;
    if (empty) w.push(`${empty} seat(s) without a player`);
    const ids = game.seats.map(s => s.playerId).filter(Boolean);
    const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
    if (dup.length) w.push(`Same player in more than one seat: ${dup.map(Store.playerName).join(', ')}`);
    const noRole = game.seats.filter(s => !s.role).length;
    if (noRole) w.push(`${noRole} seat(s) without a role`);
    const c = this.roleCounts(game);
    if (!noRole && c.don + c.mafia === 0) w.push('No mafia in this game?');
    // consistency checks (useful for imported games)
    const tl = this.timeline(game);
    game.rounds.forEach((r, i) => {
      (r.eliminated || []).forEach(s => { if (tl.alive.includes(s)) w.push(`Seat ${s} is voted out on day ${i + 1} but marked alive at the end`); });
      const dayAlive = (tl.phases.find(p => p.round === i + 1 && p.phase === 'day') || { alive: [] }).alive;
      (r.nominations || []).forEach(n => { if (n.by && !dayAlive.includes(n.by)) w.push(`Day ${i + 1}: seat ${n.by} nominates but was already out`); });
    });
    if (game.winner && !noRole) {
      const mafia = tl.alive.filter(n => this.teamOf(game, n) === 'mafia').length;
      const town = tl.alive.length - mafia;
      if (game.winner === 'town' && mafia > 0) w.push('Citizens won, but some mafia are marked alive at the end');
      if (game.winner === 'mafia' && mafia < town) w.push('Mafia won, but fewer mafia than citizens are alive at the end');
    }
    return w;
  },
};
