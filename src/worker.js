/**
 * Mafia BCN — Cloudflare Worker
 *
 * Public:
 *   GET  /api/data                     all public data (nicknames only)
 *   GET  /api/me                       who is logged in
 * Login (Telegram OpenID Connect, authorization code + PKCE):
 *   GET  /api/auth/telegram/start      → redirects to Telegram
 *   GET  /api/auth/telegram/callback   ← Telegram redirects back here
 *   POST /api/auth/logout
 * Admin only:
 *   GET    /api/admin/players          players with private fields + linked accounts
 *   POST   /api/admin/players          { nickname }
 *   PATCH  /api/admin/players/:id      { nickname, first_name, last_name, telegram }
 *   DELETE /api/admin/players/:id
 *   PATCH  /api/admin/accounts/:id     { player_id, role }
 *   POST   /api/admin/games            { date }
 *   PUT    /api/admin/games/:id        full game
 *   DELETE /api/admin/games/:id
 *   PUT    /api/admin/settings         { priorWeight, minGames, defaultSeats }
 *   GET    /api/admin/backup           full database as JSON (private fields included)
 *
 * Secrets (Cloudflare → Worker → Settings → Variables and Secrets):
 *   TELEGRAM_CLIENT_ID, TELEGRAM_CLIENT_SECRET   from @BotFather → Login Widget
 *   TELEGRAM_BOT_TOKEN                           from @BotFather (bot messages, later)
 */

const ROLES = ['citizen', 'sheriff', 'doctor', 'maniac', 'mafia', 'don'];
const NIGHT_KINDS = { mafiaKill: 'mafia_kill', donCheck: 'don_check', sheriffCheck: 'sheriff_check', maniacKill: 'maniac_kill', doctorHeal: 'doctor_heal' };
const SESSION_COOKIE = 'mbcn_session';
const OAUTH_COOKIE = 'mbcn_oauth';
const SESSION_DAYS = 60;
const TG_ISSUER = 'https://oauth.telegram.org';

/* ---------------- helpers ---------------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const redirect = (location, headers = {}) => new Response(null, { status: 302, headers: { location, ...headers } });

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}
const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(text) { return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))); }

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}
const cookie = (name, value, { maxAge, path = '/' } = {}) =>
  `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=Lax${maxAge != null ? `; Max-Age=${maxAge}` : ''}`;

const int = (v, min, max) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Invalid number: ${v}`);
  return n;
};
const str = (v, max = 200) => (v === null || v === undefined ? null : String(v).trim().slice(0, max) || null);
const chunk = (arr, size) => { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; };

/** Multi-row INSERT split so each statement stays under D1's 100 bound-parameter limit. */
function insertMany(db, table, cols, rows) {
  const per = Math.max(1, Math.floor(99 / cols.length));
  return chunk(rows, per).map(part =>
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${part.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')}`)
      .bind(...part.flat()));
}

/* ---------------- public data ---------------- */
async function loadSettings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of results) s[r.key] = Number.isNaN(Number(r.value)) ? r.value : Number(r.value);
  return s;
}

async function getData(env) {
  const [players, games, seats, noms, events, settings] = await env.DB.batch([
    env.DB.prepare("SELECT id, nickname, created_at FROM players WHERE status != 'hidden' ORDER BY id"),
    env.DB.prepare('SELECT id, date, number, winner, notes, source FROM games ORDER BY date, number'),
    env.DB.prepare('SELECT game_id, seat, player_id, role, alive, fouls FROM game_seats ORDER BY game_id, seat'),
    env.DB.prepare('SELECT game_id, round, by_seat, target_seat, votes FROM nominations ORDER BY game_id, round, position'),
    env.DB.prepare('SELECT game_id, round, kind, seat FROM round_events ORDER BY game_id, round'),
    env.DB.prepare('SELECT key, value FROM settings'),
  ]);

  const byGame = new Map();
  for (const g of games.results) {
    byGame.set(g.id, { id: String(g.id), date: g.date, number: g.number, winner: g.winner, notes: g.notes || '', source: g.source, seats: [], rounds: [] });
  }
  const round = (g, n) => {
    while (g.rounds.length < n) {
      g.rounds.push({ nominations: [], eliminated: [], removed: [], night: { mafiaKill: null, donCheck: null, sheriffCheck: null, maniacKill: null, doctorHeal: null } });
    }
    return g.rounds[n - 1];
  };
  for (const s of seats.results) {
    const g = byGame.get(s.game_id);
    if (g) g.seats.push({ seat: s.seat, playerId: s.player_id == null ? null : String(s.player_id), role: s.role, alive: s.alive, fouls: s.fouls });
  }
  for (const n of noms.results) {
    const g = byGame.get(n.game_id);
    if (g) round(g, n.round).nominations.push({ by: n.by_seat, target: n.target_seat, votes: n.votes });
  }
  const nightKey = Object.fromEntries(Object.entries(NIGHT_KINDS).map(([k, v]) => [v, k]));
  for (const e of events.results) {
    const g = byGame.get(e.game_id);
    if (!g) continue;
    const r = round(g, e.round);
    if (e.kind === 'eliminated') r.eliminated.push(e.seat);
    else if (e.kind === 'removed') r.removed.push(e.seat);
    else if (nightKey[e.kind]) r.night[nightKey[e.kind]] = e.seat;
  }
  const s = {};
  for (const r of settings.results) s[r.key] = Number(r.value);

  return {
    schema: 2,
    generatedAt: new Date().toISOString(),
    settings: s,
    players: players.results.map(p => ({ id: String(p.id), number: p.id, nickname: p.nickname, createdAt: p.created_at })),
    games: [...byGame.values()],
  };
}

/* ---------------- sessions ---------------- */
async function currentUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT a.id, a.player_id, a.username, a.display_name, a.role, a.status, p.nickname
       FROM sessions s JOIN accounts a ON a.id = s.account_id LEFT JOIN players p ON p.id = a.player_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
  ).bind(await sha256(token)).first();
  return row || null;
}
async function requireAdmin(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw new HttpError(401, 'Please log in');
  if (user.role !== 'admin') throw new HttpError(403, 'Admins only');
  return user;
}

/* ---------------- Telegram login (OIDC + PKCE) ---------------- */
function telegramConfigured(env) { return Boolean(env.TELEGRAM_CLIENT_ID && env.TELEGRAM_CLIENT_SECRET); }

async function authStart(request, env) {
  if (!telegramConfigured(env)) return new Response('Telegram login is not configured yet (missing TELEGRAM_CLIENT_ID / TELEGRAM_CLIENT_SECRET).', { status: 503 });
  const url = new URL(request.url);
  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const back = url.searchParams.get('back') || '/';
  const auth = new URL(TG_ISSUER + '/auth');
  auth.search = new URLSearchParams({
    client_id: env.TELEGRAM_CLIENT_ID,
    redirect_uri: `${url.origin}/api/auth/telegram/callback`,
    response_type: 'code',
    scope: 'openid profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  const value = [state, verifier, back.startsWith('/') ? back : '/'].join('|');
  return redirect(auth.toString(), { 'set-cookie': cookie(OAUTH_COOKIE, value, { maxAge: 600, path: '/api/auth' }) });
}

let jwksCache = null;
async function telegramKeys(force = false) {
  if (!force && jwksCache && jwksCache.at > Date.now() - 3600e3) return jwksCache.keys;
  const res = await fetch(TG_ISSUER + '/.well-known/jwks.json');
  if (!res.ok) throw new Error('Could not load Telegram keys');
  jwksCache = { at: Date.now(), keys: (await res.json()).keys || [] };
  return jwksCache.keys;
}

async function verifyIdToken(idToken, env) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm ' + header.alg);
  let jwk = (await telegramKeys()).find(k => !header.kid || k.kid === header.kid);
  if (!jwk) jwk = (await telegramKeys(true)).find(k => !header.kid || k.kid === header.kid);
  if (!jwk) throw new Error('Signing key not found');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('Bad token signature');
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== TG_ISSUER) throw new Error('Bad issuer');
  const auds = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud)];
  const botId = (env.TELEGRAM_BOT_TOKEN || '').split(':')[0];
  if (!auds.includes(String(env.TELEGRAM_CLIENT_ID)) && !(botId && auds.includes(botId))) throw new Error('Token is for another app');
  if (!claims.exp || claims.exp < now - 60) throw new Error('Token expired');
  return claims;
}

async function authCallback(request, env) {
  const url = new URL(request.url);
  const fail = msg => redirect('/#/login-error/' + encodeURIComponent(msg), { 'set-cookie': cookie(OAUTH_COOKIE, '', { maxAge: 0, path: '/api/auth' }) });
  if (url.searchParams.get('error')) return fail(url.searchParams.get('error'));
  const [state, verifier, back] = (getCookie(request, OAUTH_COOKIE) || '').split('|');
  if (!state || state !== url.searchParams.get('state')) return fail('Login expired, please try again');
  const code = url.searchParams.get('code');
  if (!code) return fail('No code from Telegram');

  let claims;
  try {
    const res = await fetch(TG_ISSUER + '/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: 'Basic ' + btoa(`${env.TELEGRAM_CLIENT_ID}:${env.TELEGRAM_CLIENT_SECRET}`),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code,
        redirect_uri: `${url.origin}/api/auth/telegram/callback`,
        client_id: env.TELEGRAM_CLIENT_ID, code_verifier: verifier,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id_token) throw new Error(body.error_description || body.error || `Token request failed (${res.status})`);
    claims = await verifyIdToken(body.id_token, env);
  } catch (err) {
    console.error('telegram login failed', err);
    return fail(err.message);
  }

  const uid = String(claims.id ?? claims.sub);
  const username = claims.preferred_username ? String(claims.preferred_username).replace(/^@/, '') : null;
  const name = claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || null;

  // 1) known account → 2) account the admin pre-filled with this @username → 3) new (not linked yet)
  let account = await env.DB.prepare("SELECT id FROM accounts WHERE provider = 'telegram' AND provider_uid = ?").bind(uid).first();
  if (!account && username) {
    account = await env.DB.prepare("SELECT id FROM accounts WHERE provider = 'telegram' AND provider_uid IS NULL AND lower(username) = lower(?) ORDER BY id LIMIT 1").bind(username).first();
  }
  if (account) {
    await env.DB.prepare("UPDATE accounts SET provider_uid = ?, username = COALESCE(?, username), display_name = ?, last_login_at = datetime('now') WHERE id = ?")
      .bind(uid, username, name, account.id).run();
  } else {
    account = await env.DB.prepare("INSERT INTO accounts (provider, provider_uid, username, display_name, status, last_login_at) VALUES ('telegram', ?, ?, ?, 'pending', datetime('now')) RETURNING id")
      .bind(uid, username, name).first();
  }

  const token = randomToken(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')"),
    env.DB.prepare(`INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`).bind(await sha256(token), account.id),
  ]);
  const headers = new Headers({ location: back && back.startsWith('/') ? back : '/' });
  headers.append('set-cookie', cookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400 }));
  headers.append('set-cookie', cookie(OAUTH_COOKIE, '', { maxAge: 0, path: '/api/auth' }));
  return new Response(null, { status: 302, headers });
}

async function logout(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
  return json({ ok: true }, 200, { 'set-cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }) });
}

/* ---------------- admin: players & accounts ---------------- */
async function adminPlayers(env) {
  const [players, accounts] = await env.DB.batch([
    env.DB.prepare('SELECT id, nickname, first_name, last_name, status, notes, created_at FROM players ORDER BY id'),
    env.DB.prepare('SELECT id, player_id, provider, provider_uid, username, display_name, role, status, last_login_at FROM accounts ORDER BY id'),
  ]);
  return {
    players: players.results.map(p => ({ ...p, id: String(p.id), number: p.id })),
    accounts: accounts.results.map(a => ({ ...a, player_id: a.player_id == null ? null : String(a.player_id), linked: a.provider_uid != null })),
  };
}

async function createPlayer(env, body) {
  const nickname = str(body.nickname, 60);
  if (!nickname) throw new HttpError(400, 'Nickname is required');
  const existing = await env.DB.prepare('SELECT id FROM players WHERE nickname = ? COLLATE NOCASE').bind(nickname).first();
  if (existing) throw new HttpError(409, 'This nickname already exists');
  const p = await env.DB.prepare('INSERT INTO players (nickname) VALUES (?) RETURNING id, nickname, created_at').bind(nickname).first();
  return { id: String(p.id), number: p.id, nickname: p.nickname, createdAt: p.created_at };
}

async function updatePlayer(env, id, body) {
  const pid = int(id, 1, 1e9);
  const cur = await env.DB.prepare('SELECT id FROM players WHERE id = ?').bind(pid).first();
  if (!cur) throw new HttpError(404, 'Player not found');
  const stmts = [];
  if ('nickname' in body) {
    const nickname = str(body.nickname, 60);
    if (!nickname) throw new HttpError(400, 'Nickname is required');
    const clash = await env.DB.prepare('SELECT id FROM players WHERE nickname = ? COLLATE NOCASE AND id != ?').bind(nickname, pid).first();
    if (clash) throw new HttpError(409, 'Another player already has this nickname');
    stmts.push(env.DB.prepare("UPDATE players SET nickname = ?, updated_at = datetime('now') WHERE id = ?").bind(nickname, pid));
  }
  for (const f of ['first_name', 'last_name', 'notes']) {
    if (f in body) stmts.push(env.DB.prepare(`UPDATE players SET ${f} = ?, updated_at = datetime('now') WHERE id = ?`).bind(str(body[f], 200), pid));
  }
  if ('telegram' in body) {
    // Pre-fill a Telegram @username: the player is linked automatically on their first login.
    const username = str(body.telegram, 64)?.replace(/^@/, '') || null;
    stmts.push(env.DB.prepare("DELETE FROM accounts WHERE player_id = ? AND provider = 'telegram' AND provider_uid IS NULL").bind(pid));
    if (username) {
      const loggedIn = await env.DB.prepare("SELECT id FROM accounts WHERE provider = 'telegram' AND provider_uid IS NOT NULL AND lower(username) = lower(?)").bind(username).first();
      if (loggedIn) stmts.push(env.DB.prepare("UPDATE accounts SET player_id = ?, status = 'linked' WHERE id = ?").bind(pid, loggedIn.id));
      else stmts.push(env.DB.prepare("INSERT INTO accounts (player_id, provider, username, status) VALUES (?, 'telegram', ?, 'linked')").bind(pid, username));
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true };
}

async function deletePlayer(env, id) {
  const pid = int(id, 1, 1e9);
  const used = await env.DB.prepare('SELECT 1 FROM game_seats WHERE player_id = ? LIMIT 1').bind(pid).first();
  if (used) throw new HttpError(409, 'This player has games — rename instead of deleting');
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET player_id = NULL WHERE player_id = ?').bind(pid),
    env.DB.prepare('DELETE FROM players WHERE id = ?').bind(pid),
  ]);
  return { ok: true };
}

async function updateAccount(env, id, body, admin) {
  const aid = int(id, 1, 1e9);
  const stmts = [];
  if ('player_id' in body) {
    const pid = body.player_id ? int(body.player_id, 1, 1e9) : null;
    stmts.push(env.DB.prepare('UPDATE accounts SET player_id = ?, status = ? WHERE id = ?').bind(pid, pid ? 'linked' : 'pending', aid));
  }
  if ('role' in body) {
    if (!['player', 'admin'].includes(body.role)) throw new HttpError(400, 'Bad role');
    if (aid === admin.id && body.role !== 'admin') throw new HttpError(400, "You can't remove your own admin role");
    stmts.push(env.DB.prepare('UPDATE accounts SET role = ? WHERE id = ?').bind(body.role, aid));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true };
}

/* ---------------- admin: games ---------------- */
async function createGame(env, body) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : null;
  if (!date) throw new HttpError(400, 'Date is required (YYYY-MM-DD)');
  const settings = await loadSettings(env);
  const seats = int(body.seats ?? settings.defaultSeats ?? 10, 4, 20);
  const next = await env.DB.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM games WHERE date = ?').bind(date).first();
  const g = await env.DB.prepare("INSERT INTO games (date, number, source) VALUES (?, ?, 'app') RETURNING id").bind(date, next.n).first();
  await env.DB.batch(insertMany(env.DB, 'game_seats', ['game_id', 'seat'], Array.from({ length: seats }, (_, i) => [g.id, i + 1])));
  return {
    id: String(g.id), date, number: next.n, winner: null, notes: '', source: 'app', rounds: [],
    seats: Array.from({ length: seats }, (_, i) => ({ seat: i + 1, playerId: null, role: null, alive: null, fouls: 0 })),
  };
}

async function saveGame(env, id, body) {
  const gid = int(id, 1, 1e9);
  const cur = await env.DB.prepare('SELECT id FROM games WHERE id = ?').bind(gid).first();
  if (!cur) throw new HttpError(404, 'Game not found');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : null;
  if (!date) throw new HttpError(400, 'Bad date');
  const number = int(body.number, 1, 99);
  const clash = await env.DB.prepare('SELECT id FROM games WHERE date = ? AND number = ? AND id != ?').bind(date, number, gid).first();
  if (clash) throw new HttpError(409, `There is already a game #${number} on ${date}`);
  const winner = body.winner === 'town' || body.winner === 'mafia' ? body.winner : null;

  const seats = (Array.isArray(body.seats) ? body.seats : []).slice(0, 20).map(s => [
    gid, int(s.seat, 1, 20), s.playerId ? int(s.playerId, 1, 1e9) : null,
    ROLES.includes(s.role) ? s.role : null,
    s.alive === 0 || s.alive === 1 ? s.alive : null,
    int(s.fouls ?? 0, 0, 9) ?? 0,
  ]);
  const seatNos = new Set(seats.map(s => s[1]));
  if (seatNos.size !== seats.length) throw new HttpError(400, 'Duplicate seat numbers');
  const seatOk = n => (n == null ? null : seatNos.has(n) ? n : null);

  const noms = [], events = [];
  (Array.isArray(body.rounds) ? body.rounds : []).slice(0, 30).forEach((r, i) => {
    const rn = i + 1;
    (r.nominations || []).slice(0, 40).forEach((nm, j) => {
      const target = seatOk(int(nm.target, 1, 20));
      if (target) noms.push([gid, rn, j + 1, seatOk(int(nm.by, 1, 20)), target, int(nm.votes, 0, 30)]);
    });
    const seen = new Set();
    const ev = (kind, s) => { s = seatOk(int(s, 1, 20)); if (s && !seen.has(kind + s)) { seen.add(kind + s); events.push([gid, rn, kind, s]); } };
    (r.eliminated || []).forEach(s => ev('eliminated', s));
    (r.removed || []).forEach(s => ev('removed', s));
    for (const [k, kind] of Object.entries(NIGHT_KINDS)) if (r.night && r.night[k]) ev(kind, r.night[k]);
  });

  await env.DB.batch([
    env.DB.prepare("UPDATE games SET date = ?, number = ?, winner = ?, notes = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(date, number, winner, str(body.notes, 4000), gid),
    env.DB.prepare('DELETE FROM game_seats WHERE game_id = ?').bind(gid),
    env.DB.prepare('DELETE FROM nominations WHERE game_id = ?').bind(gid),
    env.DB.prepare('DELETE FROM round_events WHERE game_id = ?').bind(gid),
    ...insertMany(env.DB, 'game_seats', ['game_id', 'seat', 'player_id', 'role', 'alive', 'fouls'], seats),
    ...insertMany(env.DB, 'nominations', ['game_id', 'round', 'position', 'by_seat', 'target_seat', 'votes'], noms),
    ...insertMany(env.DB, 'round_events', ['game_id', 'round', 'kind', 'seat'], events),
  ]);
  return { ok: true };
}

async function deleteGame(env, id) {
  const gid = int(id, 1, 1e9);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM game_seats WHERE game_id = ?').bind(gid),
    env.DB.prepare('DELETE FROM nominations WHERE game_id = ?').bind(gid),
    env.DB.prepare('DELETE FROM round_events WHERE game_id = ?').bind(gid),
    env.DB.prepare('DELETE FROM games WHERE id = ?').bind(gid),
  ]);
  return { ok: true };
}

async function saveSettings(env, body) {
  const allowed = { priorWeight: [0, 50], minGames: [1, 50], defaultSeats: [4, 20] };
  const stmts = [];
  for (const [k, [min, max]] of Object.entries(allowed)) {
    if (k in body) stmts.push(env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(k, String(int(body[k], min, max))));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ok: true };
}

async function backup(env) {
  const tables = ['players', 'accounts', 'games', 'game_seats', 'nominations', 'round_events', 'settings'];
  const res = await env.DB.batch(tables.map(t => env.DB.prepare(`SELECT * FROM ${t}`)));
  const out = { exportedAt: new Date().toISOString(), tables: {} };
  tables.forEach((t, i) => { out.tables[t] = res[i].results; });
  return out;
}

/* ---------------- router ---------------- */
async function readBody(request) {
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw new HttpError(415, 'Expected JSON');
  try { return await request.json(); } catch { throw new HttpError(400, 'Invalid JSON'); }
}
function checkOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, 'Bad origin');
}

async function api(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/data' && method === 'GET') return json(await getData(env), 200, { 'cache-control': 'no-cache' });
  if (path === '/api/health') return json({ ok: true });
  if (path === '/api/me' && method === 'GET') {
    const u = await currentUser(request, env);
    return json({
      loginAvailable: telegramConfigured(env),
      user: u && { accountId: u.id, username: u.username, name: u.display_name, role: u.role, playerId: u.player_id == null ? null : String(u.player_id), nickname: u.nickname },
    });
  }
  if (path === '/api/auth/telegram/start' && method === 'GET') return authStart(request, env);
  if (path === '/api/auth/telegram/callback' && method === 'GET') return authCallback(request, env);
  if (path === '/api/auth/logout' && method === 'POST') { checkOrigin(request); return logout(request, env); }

  if (path.startsWith('/api/admin/')) {
    checkOrigin(request);
    const admin = await requireAdmin(request, env);
    const m = path.match(/^\/api\/admin\/(players|accounts|games|settings|backup)(?:\/(\d+))?$/);
    if (!m) throw new HttpError(404, 'Not found');
    const [, resource, id] = m;
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(request) : null;
    if (resource === 'players') {
      if (method === 'GET' && !id) return json(await adminPlayers(env));
      if (method === 'POST' && !id) return json(await createPlayer(env, body), 201);
      if (method === 'PATCH' && id) return json(await updatePlayer(env, id, body));
      if (method === 'DELETE' && id) return json(await deletePlayer(env, id));
    }
    if (resource === 'accounts' && method === 'PATCH' && id) return json(await updateAccount(env, id, body, admin));
    if (resource === 'games') {
      if (method === 'POST' && !id) return json(await createGame(env, body), 201);
      if (method === 'PUT' && id) return json(await saveGame(env, id, body));
      if (method === 'DELETE' && id) return json(await deleteGame(env, id));
    }
    if (resource === 'settings' && method === 'PUT') return json(await saveSettings(env, body));
    if (resource === 'backup' && method === 'GET') return json(await backup(env), 200, { 'content-disposition': `attachment; filename="mafia-bcn-backup-${new Date().toISOString().slice(0, 10)}.json"` });
    throw new HttpError(405, 'Method not allowed');
  }
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        console.error(err);
        return json({ error: 'Server error' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
