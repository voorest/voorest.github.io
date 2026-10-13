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

  /* ---- loading ---- */
  async function init() {
    if (location.protocol.startsWith('http')) {
      try {
        const res = await fetch('/api/data', { headers: { Accept: 'application/json' } });
        if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
          db = normalize(await res.json());
          mode = 'live';
          try { me = await api('/api/me'); } catch (e) { /* not logged in */ }
          if (isAdmin()) await loadAdmin();
          return db;
        }
      } catch (e) { /* no API here → local mode */ }
    }
    mode = 'local';
    try { db = normalize(JSON.parse(localStorage.getItem(KEY))); }
    catch (e) { db = empty(); }
    return db;
  }
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
  async function newGame(date) {
    let g;
    if (isLive()) {
      g = await api('/api/admin/games', { method: 'POST', body: { date, seats: db.settings.defaultSeats } });
    } else {
      const n = db.settings.defaultSeats || 10;
      const sameDay = db.games.filter(x => x.date === date);
      g = {
        id: uid(), date,
        number: sameDay.length ? Math.max(...sameDay.map(x => x.number)) + 1 : 1,
        seats: Array.from({ length: n }, (_, i) => ({ seat: i + 1, playerId: null, role: null, alive: null, fouls: 0 })),
        rounds: [], winner: null, notes: '', source: 'app', createdAt: new Date().toISOString(),
      };
    }
    db.games.push(normalize({ games: [g] }).games[0]);
    saveLocal();
    return game(g.id);
  }

  /** Save a whole game (called by the editor's "Save changes" button). Throws on failure. */
  async function saveGame(g) {
    const tl = GameLogic.timeline(g);
    const copy = JSON.parse(JSON.stringify({
      ...g,
      seats: g.seats.map(s => ({ ...s, alive: g.source === 'xls' ? s.alive : (tl.alive.includes(s.seat) ? 1 : 0) })),
    }));
    if (isLive()) {
      setSaveState('saving');
      try { await api('/api/admin/games/' + g.id, { method: 'PUT', body: copy }); }
      catch (e) { setSaveState('error', e.message); throw e; }
      setSaveState('saved');
    }
    const i = db.games.findIndex(x => x.id === String(g.id));
    if (i >= 0) db.games[i] = normalize({ games: [copy] }).games[0];
    saveLocal();
    return game(g.id);
  }
  const game = id => db.games.find(g => g.id === String(id));
  async function deleteGame(id) {
    if (isLive()) await api('/api/admin/games/' + id, { method: 'DELETE' });
    db.games = db.games.filter(g => g.id !== String(id));
    saveLocal();
  }
  /** Running number across all games (like the Attendance sheet: 1, 2, 3 …). */
  function overallNumber(g) {
    const all = [...db.games].sort((a, b) => a.date.localeCompare(b.date) || a.number - b.number);
    return all.findIndex(x => x.id === String(g.id)) + 1;
  }
  const sortedGames = () => [...db.games].sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number);

  async function saveSettings(patch) {
    if (isLive()) await api('/api/admin/settings', { method: 'PUT', body: patch });
    Object.assign(db.settings, patch);
    saveLocal();
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    location.reload();
  }

  return {
    uid, init, get, isLive, canEdit, isAdmin, user, loginAvailable, adminData, loadAdmin,
    onSaveState, replace, clear, saveLocal, logout,
    addPlayer, updatePlayer, deletePlayer, updateAccount, playerInUse, player, playerName,
    newGame, saveGame, game, deleteGame, sortedGames, overallNumber, saveSettings,
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
