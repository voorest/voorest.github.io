/**
 * Mafia BCN — Cloudflare Worker
 *
 * Public:
 *   GET  /api/data?v=<version>         public data (nicknames only) + who is logged in.
 *                                      Served from a ready-made copy in KV; answers {unchanged:true}
 *                                      when the browser already has the current version. Rate limited.
 *   GET  /api/me                       who is logged in
 * Login (Telegram OpenID Connect, authorization code + PKCE):
 *   GET  /api/auth/telegram/start      → redirects to Telegram
 *   GET  /api/auth/telegram/callback   ← Telegram redirects back here
 *   POST /api/auth/logout
 * Admin only:
 *   GET    /api/admin/players          players with private fields + linked accounts
 *   POST   /api/admin/players          { name, nickname, gender }
 *   PATCH  /api/admin/players/:id      { name, nickname, gender, first_name, last_name, telegram }
 *   DELETE /api/admin/players/:id
 *   PATCH  /api/admin/accounts/:id     { player_id, role }
 *   POST   /api/admin/games            { date }
 *   PUT    /api/admin/games/:id        full game
 *   DELETE /api/admin/games/:id
 *   PUT    /api/admin/settings         { priorWeight, minGames, defaultSeats }
 *   GET    /api/admin/backup           full database as JSON (private fields included)
 *   GET    /api/admin/backups          list of stored backups (weekly + manual)
 *   POST   /api/admin/backups          make a backup now
 *   GET    /api/admin/backups/:name    download a stored backup
 *   GET    /api/admin/bot              bot status: connection, groups, number of subscribers
 *   GET    /api/admin/bot/chats        people who pressed Start (with linked player)
 *   GET    /api/admin/bot/posts        sent posts, newest first
 *   POST   /api/admin/bot/preview      what the bot answers to a command { command, playerId? } (nothing is sent)
 *   POST   /api/admin/bot/setup        connect the webhook + commands (run once from the live site)
 *   POST   /api/admin/bot/posts        send a post { text, audience: group|subscribers|admins|person, chatId?, kind?, gameId? }
 *   POST   /api/admin/bot/posts/:id/process   continue sending (40 per call)
 *   PUT    /api/admin/bot/posts/:id    edit a sent post { text }
 *   DELETE /api/admin/bot/posts/:id    delete a sent post (Telegram: within 48 h)
 * Telegram → us:
 *   POST   /api/telegram/webhook       bot updates (/start, /mystats, /help, /stop, added to groups) — see src/bot.js
 *
 * Scheduled: every Sunday 07:00 UTC → full backup into KV (keep 12) + Telegram report to admins.
 *
 * Secrets (Cloudflare → Worker → Settings → Variables and Secrets):
 *   TELEGRAM_CLIENT_ID, TELEGRAM_CLIENT_SECRET   from @BotFather → Login Widget
 *   TELEGRAM_BOT_TOKEN                           from @BotFather (bot messages, later)
 */

import { BotError, displayName, telegramPhoto, handleWebhook, botStatus, botChats, botPosts, botPreview, botSetup, createPost, processPost, editPost, deletePost } from './bot.js';

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
    env.DB.prepare("SELECT id, COALESCE(number, id) AS number, name, nickname, gender, avatar_v, created_at FROM players WHERE status != 'hidden' ORDER BY id"),
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
  for (const r of settings.results) if (!Number.isNaN(Number(r.value))) s[r.key] = Number(r.value);

  return {
    schema: 2,
    generatedAt: new Date().toISOString(),
    settings: s,
    // name + nick are public; real first/last names never leave the admin API. av = avatar version (photos are for logged-in users only)
    players: players.results.map(p => ({ id: String(p.id), number: p.number, name: p.name || '', nickname: p.nickname, gender: p.gender || null, av: p.avatar_v || 0, createdAt: p.created_at })),
    games: [...byGame.values()],
  };
}

/* ---------------- sessions ---------------- */
async function currentUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT a.id, a.player_id, a.provider_uid, a.username, a.display_name, a.role, a.status, p.nickname, p.name, p.first_name, p.last_name
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
  const fail = msg => redirect('/login-error/' + encodeURIComponent(msg), { 'set-cookie': cookie(OAUTH_COOKIE, '', { maxAge: 0, path: '/api/auth' }) });
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
  let account = await env.DB.prepare("SELECT id, last_login_at, EXISTS (SELECT 1 FROM bot_chats WHERE chat_id = ?) AS bot FROM accounts WHERE provider = 'telegram' AND provider_uid = ?").bind(uid, uid).first();
  // 'firstid' = the admin stored this Telegram ID in advance and the person shows up for the first time
  let match = account ? (account.last_login_at || account.bot ? 'known' : 'firstid') : null;
  if (!account && username) {
    account = await env.DB.prepare("SELECT id FROM accounts WHERE provider = 'telegram' AND provider_uid IS NULL AND lower(username) = lower(?) ORDER BY id LIMIT 1").bind(username).first();
    if (account) match = 'prefill';
  }
  if (account) {
    await env.DB.prepare("UPDATE accounts SET provider_uid = ?, username = COALESCE(?, username), display_name = ?, last_login_at = datetime('now') WHERE id = ?")
      .bind(uid, username, name, account.id).run();
  } else {
    account = await env.DB.prepare("INSERT INTO accounts (provider, provider_uid, username, display_name, status, last_login_at) VALUES ('telegram', ?, ?, ?, 'pending', datetime('now')) RETURNING id")
      .bind(uid, username, name).first();
    match = 'new';
  }
  if (match !== 'known') {
    await loginNotice(env, { match, accountId: account.id, name, username, via: 'site' }).catch(() => {});
    await autoAvatar(env, account.id).catch(() => {});
  }

  const token = randomToken(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')"),
    env.DB.prepare(`INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`).bind(await sha256(token), account.id),
  ]);
  const target = back && back.startsWith('/') && !back.startsWith('//') ? back : '/';
  const [path, hash] = target.split('#');
  const headers = new Headers({ location: `${path}${path.includes('?') ? '&' : '?'}fresh=1${hash !== undefined ? '#' + hash : ''}` });
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
    env.DB.prepare('SELECT id, COALESCE(number, id) AS number, name, nickname, gender, first_name, last_name, status, notes, avatar_v, avatar_src, created_at FROM players ORDER BY id'),
    env.DB.prepare(`SELECT a.id, a.player_id, a.provider, a.provider_uid, a.username, a.display_name, a.role, a.status, a.last_login_at,
                           EXISTS (SELECT 1 FROM bot_chats c WHERE c.chat_id = a.provider_uid) AS bot
                      FROM accounts a ORDER BY a.id`),
  ]);
  return {
    players: players.results.map(p => ({ ...p, id: String(p.id) })),
    // linked = Telegram ID known; seen = the person has logged in or pressed Start at least once
    accounts: accounts.results.map(a => ({ ...a, player_id: a.player_id == null ? null : String(a.player_id), linked: a.provider_uid != null, seen: !!(a.last_login_at || a.bot) })),
  };
}

const gender = v => (v === 'm' || v === 'f' ? v : null);   // anything else = not set
async function createPlayer(env, body) {
  // A quick add may give only a name: the nick then starts as the name and can be changed later
  const name = str(body.name, 40);
  const nickname = str(body.nickname, 60) || name;
  if (!nickname) throw new HttpError(400, 'Name or nick is required');
  const existing = await env.DB.prepare('SELECT id FROM players WHERE nickname = ? COLLATE NOCASE').bind(nickname).first();
  if (existing) throw new HttpError(409, `The nick "${nickname}" is already taken. Please choose another one.`);
  // Next free number after the highest one: deleting the newest player frees its number again
  const p = await env.DB.prepare(
    'INSERT INTO players (name, nickname, gender, number) VALUES (?, ?, ?, (SELECT COALESCE(MAX(COALESCE(number, id)), 0) + 1 FROM players)) RETURNING id, number, name, nickname, gender, created_at',
  ).bind(name, nickname, gender(body.gender)).first();
  return { id: String(p.id), number: p.number, name: p.name || '', nickname: p.nickname, gender: p.gender || null, av: 0, createdAt: p.created_at };
}

async function updatePlayer(env, id, body) {
  const pid = int(id, 1, 1e9);
  const cur = await env.DB.prepare('SELECT id FROM players WHERE id = ?').bind(pid).first();
  if (!cur) throw new HttpError(404, 'Player not found');
  const stmts = [];
  if ('name' in body) stmts.push(env.DB.prepare("UPDATE players SET name = ?, updated_at = datetime('now') WHERE id = ?").bind(str(body.name, 40), pid));
  if ('gender' in body) stmts.push(env.DB.prepare("UPDATE players SET gender = ?, updated_at = datetime('now') WHERE id = ?").bind(gender(body.gender), pid));
  if ('nickname' in body) {
    const nickname = str(body.nickname, 60);
    if (!nickname) throw new HttpError(400, 'Nick is required');
    const clash = await env.DB.prepare('SELECT id FROM players WHERE nickname = ? COLLATE NOCASE AND id != ?').bind(nickname, pid).first();
    if (clash) throw new HttpError(409, `The nick "${nickname}" is already taken. Please choose another one.`);
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
  // linked to a player by hand: take their Telegram photo if they have none yet
  if (body.player_id) await autoAvatar(env, aid).catch(() => {});
  return { ok: true };
}

/* ---------------- admin: games ---------------- */
const SEATS_MIN = 7, SEATS_MAX = 16; // players per game (the page offers the same range)
async function createGame(env, body) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : null;
  if (!date) throw new HttpError(400, 'Date is required (YYYY-MM-DD)');
  const settings = await loadSettings(env);
  // The editor sends the whole game on its first save; older callers send only a seat count.
  const full = Array.isArray(body.seats);
  const seats = int(full ? body.seats.length : body.seats ?? settings.defaultSeats ?? 10, SEATS_MIN, SEATS_MAX);
  const next = await env.DB.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM games WHERE date = ?').bind(date).first();
  const g = await env.DB.prepare("INSERT INTO games (date, number, source) VALUES (?, ?, 'app') RETURNING id").bind(date, next.n).first();
  if (full) {
    try { await saveGame(env, g.id, { ...body, number: body.number ?? next.n }); }
    catch (e) { await deleteGame(env, g.id); throw e; }
    return { id: String(g.id) };
  }
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

  if (!Array.isArray(body.seats) || body.seats.length < SEATS_MIN || body.seats.length > SEATS_MAX) throw new HttpError(400, `A game has ${SEATS_MIN}–${SEATS_MAX} players`);
  const seats = body.seats.map(s => [
    gid, int(s.seat, 1, SEATS_MAX), s.playerId ? int(s.playerId, 1, 1e9) : null,
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
  const allowed = { priorWeight: [0, 50], minGames: [1, 50], defaultSeats: [SEATS_MIN, SEATS_MAX] };
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

/* ---------------- public snapshot in KV ---------------- */
// The public data is built once after every admin change and stored in KV with its version.
// Visitors read that copy (0 database reads); browsers keep their own copy and only ask
// "is version X still current?".
const SNAPSHOT_KEY = 'public:data';

/* ---------------- avatars ----------------
   One square image per player (about 320×320, ≤150 KB) in KV under avatar:<player id>.
   Only logged-in people can load them; everyone else sees the hat icon drawn by the page. */
const AVATAR_TYPES = ['image/webp', 'image/jpeg', 'image/png'];
const AVATAR_MAX = 150 * 1024;
function decodeImage(body) {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(body && body.image || ''));
  if (!m) throw new HttpError(400, 'Send the picture as a data URL');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type: m[1] };
}
async function saveAvatar(env, pid, { bytes, type }, src, rebuild = true) {
  if (!AVATAR_TYPES.includes(type)) throw new HttpError(400, 'Use a JPEG, PNG or WebP picture');
  if (bytes.byteLength > AVATAR_MAX) throw new HttpError(413, 'The picture is too big (max 150 KB)');
  await env.KV.put(`avatar:${pid}`, bytes, { metadata: { type } });
  const v = Date.now();   // milliseconds: a new picture always gets a new address, so browsers never show a cached old one
  await env.DB.prepare("UPDATE players SET avatar_v = ?, avatar_src = ?, updated_at = datetime('now') WHERE id = ?").bind(v, src, pid).run();
  if (rebuild) await rebuildSnapshot(env);
  return { av: v };
}
async function removeAvatar(env, pid) {
  await env.KV.delete(`avatar:${pid}`);
  await env.DB.prepare("UPDATE players SET avatar_v = NULL, avatar_src = 'removed', updated_at = datetime('now') WHERE id = ?").bind(pid).run();
  await rebuildSnapshot(env);
  return { av: 0 };
}
/** Take the photo from Telegram. Returns the new version, or null if the person has no (visible) photo. */
async function avatarFromTelegram(env, pid, uid, rebuild = true) {
  const photo = await telegramPhoto(env, uid);
  if (!photo) {
    await env.DB.prepare("UPDATE players SET avatar_src = 'none' WHERE id = ? AND avatar_v IS NULL").bind(pid).run();
    return null;
  }
  return saveAvatar(env, pid, photo, 'telegram', rebuild);
}
/** First contact of a linked player: take the Telegram photo once, unless they already have one or removed it. */
async function autoAvatar(env, accountId) {
  const r = await env.DB.prepare(`SELECT a.provider_uid, p.id AS pid FROM accounts a JOIN players p ON p.id = a.player_id
                                   WHERE a.id = ? AND p.avatar_v IS NULL AND p.avatar_src IS NULL`).bind(accountId).first();
  if (r && r.provider_uid && r.provider_uid !== 'dev-admin') await avatarFromTelegram(env, r.pid, r.provider_uid);
}
async function serveAvatar(request, env, number) {
  if (!await currentUser(request, env)) return new Response('Log in to see photos', { status: 403 });
  const p = await env.DB.prepare('SELECT id FROM players WHERE COALESCE(number, id) = ?').bind(int(number, 1, 1e9)).first();
  const img = p ? await env.KV.getWithMetadata(`avatar:${p.id}`, 'arrayBuffer') : null;
  if (!img || !img.value) return new Response('No photo', { status: 404 });
  // the address carries the version (?v=…), so the browser may keep it for good
  return new Response(img.value, { headers: { 'content-type': (img.metadata && img.metadata.type) || 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' } });
}
/** Admin: take Telegram photos for linked players who have none yet (a few per call; the page repeats). */
async function bulkTelegramAvatars(env) {
  const { results } = await env.DB.prepare(`SELECT p.id AS pid, MIN(a.provider_uid) AS uid FROM players p JOIN accounts a ON a.player_id = p.id
                                             WHERE p.avatar_v IS NULL AND p.avatar_src IS NULL AND a.provider_uid IS NOT NULL AND a.provider_uid != 'dev-admin'
                                             GROUP BY p.id LIMIT 12`).all();
  let added = 0;
  for (const r of results) { if (await avatarFromTelegram(env, r.pid, r.uid, false).catch(() => null)) added++; else await env.DB.prepare("UPDATE players SET avatar_src = 'none' WHERE id = ? AND avatar_v IS NULL").bind(r.pid).run(); }
  if (added) await rebuildSnapshot(env);
  const left = await env.DB.prepare(`SELECT count(DISTINCT p.id) AS n FROM players p JOIN accounts a ON a.player_id = p.id
                                      WHERE p.avatar_v IS NULL AND p.avatar_src IS NULL AND a.provider_uid IS NOT NULL AND a.provider_uid != 'dev-admin'`).first();
  return { checked: results.length, added, remaining: left.n };
}
/** Avatar actions for one player: upload a picture, remove it, or take it from Telegram. */
async function avatarAction(request, env, pid, method, tail) {
  if (method === 'POST' && tail === 'telegram') {
    const a = await env.DB.prepare("SELECT provider_uid FROM accounts WHERE player_id = ? AND provider_uid IS NOT NULL AND provider_uid != 'dev-admin' LIMIT 1").bind(pid).first();
    if (!a) throw new HttpError(400, 'This player has no linked Telegram account');
    await env.DB.prepare('UPDATE players SET avatar_src = NULL WHERE id = ? AND avatar_v IS NULL').bind(pid).run();
    const r = await avatarFromTelegram(env, pid, a.provider_uid);
    if (!r) throw new HttpError(404, 'No Telegram photo found (none, or hidden by privacy settings)');
    return r;
  }
  if (method === 'POST' && !tail) return saveAvatar(env, pid, decodeImage(await readBody(request)), 'upload');
  if (method === 'DELETE' && !tail) return removeAvatar(env, pid);
  throw new HttpError(405, 'Method not allowed');
}

async function rebuildSnapshot(env) {
  const data = await getData(env);
  const version = new Date().toISOString();
  data.version = version;
  const body = JSON.stringify(data);
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('dataVersion', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(version).run();
  if (env.KV) {
    try { await env.KV.put(SNAPSHOT_KEY, body, { metadata: { version } }); }
    catch (e) {
      // KV allows 1 write per second per key: wait and retry once.
      await new Promise(r => setTimeout(r, 1200));
      await env.KV.put(SNAPSHOT_KEY, body, { metadata: { version } });
    }
  }
  return { version, body };
}

async function publicSnapshot(env) {
  if (env.KV) {
    const { value, metadata } = await env.KV.getWithMetadata(SNAPSHOT_KEY);
    if (value && metadata && metadata.version) return { version: metadata.version, body: value };
  }
  return rebuildSnapshot(env);
}

/** Local development only: "Dev login" works when DEV_LOGIN=true (from .dev.vars) AND the site runs on localhost. */
function devLoginAllowed(env, url) {
  return env.DEV_LOGIN === 'true' && url && ['localhost', '127.0.0.1'].includes(url.hostname);
}

async function devLogin(env, url) {
  if (!devLoginAllowed(env, url)) throw new HttpError(404, 'Not found');
  let acc = await env.DB.prepare("SELECT id FROM accounts WHERE provider = 'telegram' AND provider_uid = 'dev-admin'").first();
  if (!acc) {
    acc = await env.DB.prepare("INSERT INTO accounts (provider, provider_uid, username, display_name, role, status) VALUES ('telegram', 'dev-admin', 'local-admin', 'Local admin', 'admin', 'linked') RETURNING id").first();
  }
  const token = randomToken(32);
  await env.DB.prepare(`INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, datetime('now', '+1 days'))`).bind(await sha256(token), acc.id).run();
  return redirect('/?fresh=1', { 'set-cookie': cookie(SESSION_COOKIE, token, { maxAge: 86400 }) });
}

function meFor(u, env, url) {
  return {
    devLogin: devLoginAllowed(env, url),
    loginAvailable: telegramConfigured(env),
    user: u && {
      accountId: u.id, username: u.username, name: u.display_name, role: u.role,
      playerId: u.player_id == null ? null : String(u.player_id), nickname: u.player_id == null ? null : displayName(u),
      // your own private details, so you can see and edit them on your page
      firstName: u.first_name || '', lastName: u.last_name || '',
    },
  };
}

async function dataEndpoint(request, env, url) {
  if (env.RL) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const { success } = await env.RL.limit({ key: 'data:' + ip });
    if (!success) return json({ error: 'Too many requests — please wait a minute' }, 429, { 'retry-after': '60' });
  }
  const user = getCookie(request, SESSION_COOKIE) ? await currentUser(request, env) : null;
  const me = JSON.stringify(meFor(user, env, url));
  // Admins always get fresh data straight from the database.
  if (user && user.role === 'admin') {
    const data = await getData(env);
    return new Response(`{"me":${me},"version":"live","data":${JSON.stringify(data)}}`, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const snap = await publicSnapshot(env);
  if (url.searchParams.get('v') === snap.version) return json({ me: JSON.parse(me), version: snap.version, unchanged: true });
  return new Response(`{"me":${me},"version":${JSON.stringify(snap.version)},"data":${snap.body}}`, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/* ---------------- backups in KV ---------------- */
const BACKUP_PREFIX = 'backup:';
const KEEP = { weekly: 12, manual: 5 };

async function makeBackup(env, kind) {
  if (!env.KV) throw new Error('KV storage is not connected');
  const data = await backup(env);
  const body = JSON.stringify(data);
  const at = new Date().toISOString();
  const name = `${at.slice(0, 16).replace(/[:]/g, '')}-${kind}`;            // e.g. 2026-10-18T0700-weekly
  const meta = { at, kind, size: body.length, games: data.tables.games.length, players: data.tables.players.length };
  await env.KV.put(BACKUP_PREFIX + name, body, { metadata: meta });
  // keep only the newest N of each kind
  const all = await listBackups(env);
  const old = all.filter(b => b.kind === kind).slice(KEEP[kind] || 10);
  for (const b of old) await env.KV.delete(BACKUP_PREFIX + b.name);
  return { name, ...meta };
}

async function listBackups(env) {
  if (!env.KV) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: BACKUP_PREFIX, cursor });
    for (const k of page.keys) out.push({ name: k.name.slice(BACKUP_PREFIX.length), ...(k.metadata || {}) });
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/* ---------------- Telegram messages to admins (free Bot API) ---------------- */
const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Tell the admins about a first login (website or bot): linked automatically by @username, or waiting to be linked. */
async function loginNotice(env, { match, accountId, name, username, via }) {
  const who = `${esc(name || 'Без імені')}${username ? ' (@' + esc(username) + ')' : ''}`;
  const where = via === 'bot' ? 'натиснув(ла) Start у боті' : 'увійшов(ла) на сайт';
  const site = env.SITE_URL || '';
  if (match === 'prefill' || match === 'firstid') {
    const p = await env.DB.prepare('SELECT p.nickname, p.name FROM accounts a JOIN players p ON p.id = a.player_id WHERE a.id = ?').bind(accountId).first();
    if (p || match === 'prefill') return notifyAdmins(env, `✅ ${who} ${where} і автоматично прив'язаний(а) до гравця <b>${esc(p ? displayName(p) : '?')}</b> (${match === 'prefill' ? 'за @username' : 'за Telegram ID'}).`);
  }
  return notifyAdmins(env, `🆕 ${who} ${where} вперше.\nЩе не прив'язаний(а) до гравця — прив'яжіть на сторінці Players → Telegram logins:\n${site}/players`);
}

async function notifyAdmins(env, html) {
  if (!env.TELEGRAM_BOT_TOKEN) return [{ ok: false, error: 'TELEGRAM_BOT_TOKEN is not set' }];
  const { results } = await env.DB.prepare("SELECT provider_uid, username FROM accounts WHERE role = 'admin' AND provider = 'telegram' AND provider_uid IS NOT NULL AND provider_uid != 'dev-admin'").all();
  const out = [];
  for (const a of results) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: a.provider_uid, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const body = await res.json().catch(() => ({}));
    out.push({ to: a.username, ok: !!body.ok, error: body.ok ? null : (body.description || `HTTP ${res.status}`) });
  }
  return out;
}

async function alertAdmins(env, message) {
  // at most one error alert per hour
  try {
    if (env.KV) {
      if (await env.KV.get('alert:last')) return;
      await env.KV.put('alert:last', new Date().toISOString(), { expirationTtl: 3600 });
    }
    await notifyAdmins(env, `⚠️ <b>Помилка на сайті Mafia BCN</b>\n${esc(message).slice(0, 500)}\n\n(наступні сповіщення вимкнено на 1 годину)`);
  } catch (e) { console.error('alert failed', e); }
}

async function weeklyBackup(env) {
  try {
    const b = await makeBackup(env, 'weekly');
    await notifyAdmins(env, `✅ <b>Щотижнева резервна копія збережена</b>\nІгор: ${b.games} · гравців: ${b.players} · ${Math.round(b.size / 1024)} KB\nЗберігаються останні ${KEEP.weekly} щотижневих копій (сторінка Data → Backups).`);
  } catch (e) {
    console.error('weekly backup failed', e);
    await notifyAdmins(env, `❌ <b>Не вдалося зробити щотижневу резервну копію</b>\n${esc(e.message || e)}`).catch(() => {});
  }
}

/* ---------------- router ---------------- */
// Pages opened on an old address (workers.dev, www) move to SITE_URL. The API is left alone,
// so the Telegram webhook and logins started on the old address keep working.
function canonicalRedirect(request, env, url) {
  if (!env.SITE_URL || url.pathname.startsWith('/api/')) return null;
  if (!['GET', 'HEAD'].includes(request.method) || ['localhost', '127.0.0.1'].includes(url.hostname)) return null;
  const site = new URL(env.SITE_URL);
  if (url.host === site.host && url.protocol === site.protocol) return null;   // also moves http:// to https://
  return Response.redirect(site.origin + url.pathname + url.search, 301);
}

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

  if (path === '/api/data' && method === 'GET') return dataEndpoint(request, env, url);
  if (path === '/api/health') return json({ ok: true });
  if (path === '/api/telegram/webhook' && method === 'POST') {
    return handleWebhook(request, env, {
      origin: url.origin,
      loginNotice: info => loginNotice(env, { ...info, via: 'bot' }),
      autoAvatar: accountId => autoAvatar(env, accountId),
      publicData: async () => JSON.parse((await publicSnapshot(env)).body),
    });
  }
  if (path === '/api/me' && method === 'GET') return json(meFor(await currentUser(request, env), env, url));
  const av = path.match(/^\/api\/avatar\/(\d+)$/);
  if (av && method === 'GET') return serveAvatar(request, env, av[1]);
  // A logged-in player edits their own private details and photo (nick and name stay with the admin)
  if (path === '/api/me/profile' || path.startsWith('/api/me/avatar')) {
    checkOrigin(request);
    const u = await currentUser(request, env);
    if (!u) throw new HttpError(401, 'Please log in');
    if (!u.player_id) throw new HttpError(403, 'Your Telegram is not linked to a player yet');
    if (path === '/api/me/profile' && method === 'PATCH') {
      const body = await readBody(request);
      const stmts = ['first_name', 'last_name'].filter(f => f in body)
        .map(f => env.DB.prepare(`UPDATE players SET ${f} = ?, updated_at = datetime('now') WHERE id = ?`).bind(str(body[f], 100), u.player_id));
      if (stmts.length) await env.DB.batch(stmts);
      return json({ ok: true });
    }
    const tail = path === '/api/me/avatar' ? '' : path.replace('/api/me/avatar/', '');
    if (tail === 'telegram' && method === 'POST') {
      await env.DB.prepare('UPDATE players SET avatar_src = NULL WHERE id = ? AND avatar_v IS NULL').bind(u.player_id).run();
      const r = await avatarFromTelegram(env, u.player_id, u.provider_uid);
      if (!r) throw new HttpError(404, 'No Telegram photo found (none, or hidden by privacy settings)');
      return json(r);
    }
    return json(await avatarAction(request, env, u.player_id, method, tail));
  }
  if (path === '/api/auth/dev-login' && method === 'GET') return devLogin(env, url);
  if (path === '/api/auth/telegram/start' && method === 'GET') {
    if (env.RL) {
      const { success } = await env.RL.limit({ key: 'auth:' + (request.headers.get('cf-connecting-ip') || 'unknown') });
      if (!success) return new Response('Too many login attempts — please wait a minute.', { status: 429 });
    }
    return authStart(request, env);
  }
  if (path === '/api/auth/telegram/callback' && method === 'GET') return authCallback(request, env);
  if (path === '/api/auth/logout' && method === 'POST') { checkOrigin(request); return logout(request, env); }

  if (path.startsWith('/api/admin/')) {
    checkOrigin(request);
    const admin = await requireAdmin(request, env);
    if (path === '/api/admin/backups' && method === 'GET') return json({ backups: await listBackups(env) });
    if (path === '/api/admin/backups' && method === 'POST') return json(await makeBackup(env, 'manual'), 201);
    const bm = path.match(/^\/api\/admin\/backups\/([\w-]+)$/);
    if (bm && method === 'GET') {
      const value = env.KV ? await env.KV.get(BACKUP_PREFIX + bm[1]) : null;
      if (!value) throw new HttpError(404, 'Backup not found');
      return new Response(value, { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="mafia-bcn-backup-${bm[1]}.json"`, 'cache-control': 'no-store' } });
    }
    if (path === '/api/admin/bot' && method === 'GET') return json(await botStatus(env, url.origin));
    if (path === '/api/admin/bot/chats' && method === 'GET') return json(await botChats(env));
    if (path === '/api/admin/bot/posts' && method === 'GET') return json(await botPosts(env));
    if (path === '/api/admin/bot/preview' && method === 'POST') {
      return json(await botPreview(env, await readBody(request), { origin: url.origin, publicData: async () => JSON.parse((await publicSnapshot(env)).body) }));
    }
    if (path === '/api/admin/bot/setup' && method === 'POST') { await botSetup(env, url); return json(await botStatus(env, url.origin)); }
    if (path === '/api/admin/bot/posts' && method === 'POST') return json(await createPost(env, admin, await readBody(request)), 201);
    const pm = path.match(/^\/api\/admin\/bot\/posts\/(\d+)(\/process)?$/);
    if (pm && method === 'POST' && pm[2]) return json(await processPost(env, +pm[1]));
    if (pm && method === 'PUT' && !pm[2]) return json(await editPost(env, +pm[1], await readBody(request)));
    if (pm && method === 'DELETE' && !pm[2]) return json(await deletePost(env, +pm[1]));
    const pa = path.match(/^\/api\/admin\/players\/(\d+)\/avatar(?:\/(telegram))?$/);
    if (pa) return json(await avatarAction(request, env, int(pa[1], 1, 1e9), method, pa[2] || ''));
    if (path === '/api/admin/avatars/telegram' && method === 'POST') return json(await bulkTelegramAvatars(env));
    const m = path.match(/^\/api\/admin\/(players|accounts|games|settings|backup)(?:\/(\d+))?$/);
    if (!m) throw new HttpError(404, 'Not found');
    const [, resource, id] = m;
    const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(request) : null;
    if (method !== 'GET') {
      // every successful change refreshes the public copy
      const res = await adminWrite(resource, id, method, body, env, admin);
      await rebuildSnapshot(env);
      return res;
    }
    if (resource === 'players' && !id) return json(await adminPlayers(env));
    if (resource === 'backup') return json(await backup(env), 200, { 'content-disposition': `attachment; filename="mafia-bcn-backup-${new Date().toISOString().slice(0, 10)}.json"` });
    throw new HttpError(405, 'Method not allowed');
  }
  throw new HttpError(404, 'Not found');
}

async function adminWrite(resource, id, method, body, env, admin) {
  if (resource === 'players') {
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
  throw new HttpError(405, 'Method not allowed');
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(weeklyBackup(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const canonical = canonicalRedirect(request, env, url);
    if (canonical) return canonical;
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (err) {
        if (err instanceof HttpError) return json({ error: err.message }, err.status);
        if (err instanceof BotError) return json({ error: err.message }, err.httpStatus);
        console.error(err);
        if (/no such table/i.test(String(err.message)) && ['localhost', '127.0.0.1'].includes(url.hostname)) {
          return json({ error: 'Local database is empty — stop the server and run: npm run seed:local' }, 500);
        }
        if (ctx) ctx.waitUntil(alertAdmins(env, `${request.method} ${url.pathname}: ${err.message || err}`));
        return json({ error: 'Server error' }, 500);
      }
    }
    // Site pages (/games, /game/17-05-2026/1, /player/27 …) are all the same index.html;
    // the browser-side router picks the view from the address.
    if (!/\.[a-z0-9]+$/i.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL('/', url), request));
    return env.ASSETS.fetch(request);
  },
};
