/* ============================================================
   DATA LAYER
   Today: data lives in this browser (localStorage) + JSON backup files.
   Later: these same functions can be re-implemented on top of a real
   database (e.g. Supabase) without touching the UI.
   ============================================================ */
'use strict';

const ROLES = {
  citizen: { label: 'Citizen', team: 'town' },
  sheriff: { label: 'Sheriff', team: 'town' },
  mafia:   { label: 'Mafia',   team: 'mafia' },
  don:     { label: 'Don',     team: 'mafia' },
};
const ROLE_ORDER = ['citizen', 'sheriff', 'mafia', 'don'];

/** Standard role setup for N players (10 → 6 citizens, 1 sheriff, 2 mafia, 1 don). */
function roleSetup(n) {
  const mafiaTeam = Math.max(1, Math.round(n * 0.3));
  return { citizen: n - mafiaTeam - 1, sheriff: 1, mafia: mafiaTeam - 1, don: 1 };
}

function pct(x) {
  return x == null || isNaN(x) ? '—' : Math.round(x * 100) + '%';
}

const Store = (() => {
  const KEY = 'mafia-bcn-db';
  const SCHEMA = 1;
  let db = null;

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const empty = () => ({
    schema: SCHEMA,
    players: [],
    games: [],
    settings: { minGames: 3, minRoleGames: 2, defaultSeats: 10 },
  });

  function normalize(d) {
    const base = empty();
    d = d && typeof d === 'object' ? d : {};
    return {
      ...base,
      ...d,
      settings: { ...base.settings, ...(d.settings || {}) },
      players: Array.isArray(d.players) ? d.players : [],
      games: Array.isArray(d.games) ? d.games : [],
    };
  }

  function load() {
    try { db = normalize(JSON.parse(localStorage.getItem(KEY))); }
    catch (e) { db = empty(); }
    return db;
  }

  function save() {
    db.updatedAt = new Date().toISOString();
    try { localStorage.setItem(KEY, JSON.stringify(db)); return true; }
    catch (e) { console.error(e); alert('Could not save to browser storage: ' + e.message); return false; }
  }

  const get = () => db || load();
  function replace(newDb) { db = normalize(newDb); save(); }
  function clear() { db = empty(); save(); }

  /* ---------- players ---------- */
  function addPlayer(name, nick = '') {
    name = String(name || '').trim();
    if (!name) return null;
    const existing = get().players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const p = { id: uid(), name, nick: String(nick || '').trim(), createdAt: new Date().toISOString() };
    db.players.push(p);
    save();
    return p;
  }
  function updatePlayer(id, patch) {
    const p = player(id);
    if (!p) return;
    Object.assign(p, patch);
    save();
  }
  function playerInUse(id) { return get().games.some(g => g.seats.some(s => s.playerId === id)); }
  function deletePlayer(id) {
    if (playerInUse(id)) return false;
    db.players = db.players.filter(p => p.id !== id);
    save();
    return true;
  }
  const player = id => get().players.find(p => p.id === id);
  const playerName = id => (player(id) || {}).name || '(unknown)';

  /* ---------- games ---------- */
  function newGame(date) {
    const n = get().settings.defaultSeats || 10;
    const sameDay = db.games.filter(g => g.date === date);
    const g = {
      id: uid(),
      date,
      number: sameDay.length ? Math.max(...sameDay.map(x => x.number)) + 1 : 1,
      seats: Array.from({ length: n }, (_, i) => ({ seat: i + 1, playerId: null, role: null, fouls: 0 })),
      rounds: [],
      winner: null,          // 'town' | 'mafia' | null (in progress)
      notes: '',
      createdAt: new Date().toISOString(),
    };
    db.games.push(g);
    save();
    return g;
  }
  const game = id => get().games.find(g => g.id === id);
  function deleteGame(id) { db.games = db.games.filter(g => g.id !== id); save(); }
  const sortedGames = () => [...get().games].sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number);

  return {
    uid, load, save, get, replace, clear,
    addPlayer, updatePlayer, deletePlayer, playerInUse, player, playerName,
    newGame, game, deleteGame, sortedGames,
  };
})();

/* ============================================================
   GAME LOGIC — derives who died when, who is alive, etc.
   A round = Day N (votes / eliminations) followed by Night N (shot / checks).
   ============================================================ */
const GameLogic = {
  emptyRound() {
    return {
      day: { votes: {}, eliminated: [], removed: [] },      // votes: { voterSeat: targetSeat }
      night: { kill: null, donCheck: null, sheriffCheck: null },
    };
  },

  timeline(game) {
    const fates = {};                     // seat -> { type: 'voted'|'killed'|'removed', round }
    const alive = new Set(game.seats.map(s => s.seat));
    const phases = [];                    // { round, phase, alive: [...] } = who was alive at the START of the phase
    game.rounds.forEach((r, i) => {
      const n = i + 1;
      phases.push({ round: n, phase: 'day', alive: [...alive] });
      (r.day.removed || []).forEach(s => {
        if (alive.has(s)) { alive.delete(s); fates[s] = { type: 'removed', round: n }; }
      });
      (r.day.eliminated || []).forEach(s => {
        if (alive.has(s)) { alive.delete(s); fates[s] = { type: 'voted', round: n }; }
      });
      phases.push({ round: n, phase: 'night', alive: [...alive] });
      const k = r.night.kill;
      if (k && alive.has(k)) { alive.delete(k); fates[k] = { type: 'killed', round: n }; }
    });
    return { fates, alive: [...alive].sort((a, b) => a - b), phases };
  },

  roleCounts(game) {
    const c = { citizen: 0, sheriff: 0, mafia: 0, don: 0 };
    game.seats.forEach(s => { if (s.role) c[s.role]++; });
    return c;
  },

  /** Winner by the rules, based on who is alive now (null if undecided or roles missing). */
  suggestWinner(game) {
    if (!game.rounds.length || game.seats.some(s => !s.role)) return null;
    const { alive } = this.timeline(game);
    const team = n => ROLES[game.seats.find(s => s.seat === n).role].team;
    const mafia = alive.filter(n => team(n) === 'mafia').length;
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
    const need = roleSetup(game.seats.length), have = this.roleCounts(game);
    if (!noRole && ROLE_ORDER.some(r => have[r] !== need[r])) w.push('Role counts differ from the standard setup');
    game.rounds.forEach((r, i) => {
      if ((r.day.eliminated || []).length > 1) w.push(`Round ${i + 1}: ${r.day.eliminated.length} players voted out (fine if it was a double elimination)`);
    });
    return w;
  },
};
