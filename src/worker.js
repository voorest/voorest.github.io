/**
 * Mafia BCN — Cloudflare Worker
 *  - Serves the website from /public (static assets)
 *  - GET /api/data → all public data (nicknames only, no private fields)
 *
 * Coming next: Telegram login (bot), admin write endpoints, player linking.
 */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });

async function getData(env) {
  const [players, games, seats, noms, events] = await env.DB.batch([
    env.DB.prepare("SELECT id, nickname FROM players WHERE status != 'hidden' ORDER BY nickname"),
    env.DB.prepare('SELECT id, date, number, winner, notes, source FROM games ORDER BY date, number'),
    env.DB.prepare('SELECT game_id, seat, player_id, role, alive, fouls FROM game_seats ORDER BY game_id, seat'),
    env.DB.prepare('SELECT game_id, round, by_seat, target_seat, votes FROM nominations ORDER BY game_id, round, position'),
    env.DB.prepare('SELECT game_id, round, kind, seat FROM round_events ORDER BY game_id, round'),
  ]);

  const byGame = new Map();
  for (const g of games.results) {
    byGame.set(g.id, {
      id: String(g.id), date: g.date, number: g.number, winner: g.winner,
      notes: g.notes || '', source: g.source, seats: [], rounds: [],
    });
  }
  const round = (g, n) => {
    while (g.rounds.length < n) {
      g.rounds.push({
        nominations: [], eliminated: [], removed: [],
        night: { mafiaKill: null, donCheck: null, sheriffCheck: null, maniacKill: null, doctorHeal: null },
      });
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
  const nightKey = { mafia_kill: 'mafiaKill', don_check: 'donCheck', sheriff_check: 'sheriffCheck', maniac_kill: 'maniacKill', doctor_heal: 'doctorHeal' };
  for (const e of events.results) {
    const g = byGame.get(e.game_id);
    if (!g) continue;
    const r = round(g, e.round);
    if (e.kind === 'eliminated') r.eliminated.push(e.seat);
    else if (e.kind === 'removed') r.removed.push(e.seat);
    else if (nightKey[e.kind]) r.night[nightKey[e.kind]] = e.seat;
  }

  return {
    schema: 2,
    generatedAt: new Date().toISOString(),
    players: players.results.map(p => ({ id: String(p.id), nickname: p.nickname })),
    games: [...byGame.values()],
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/data') {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      try {
        return json(await getData(env), 200, { 'cache-control': 'public, max-age=30' });
      } catch (err) {
        console.error(err);
        return json({ error: 'Database error' }, 500);
      }
    }
    if (url.pathname === '/api/health') return json({ ok: true });
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);

    return env.ASSETS.fetch(request);
  },
};
