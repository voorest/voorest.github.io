/**
 * Mafia BCN — Telegram bot (@mafia_bcn_bot)
 *
 * Webhook (Telegram → us):  POST /api/telegram/webhook   (secret header derived from the bot token)
 *   /start   subscribe to announcements (+ auto-link to a player by @username)
 *   /mystats your stats (only if your Telegram is linked to a player)
 *   /help    what the bot can do
 *   /stop    stop announcements
 *   Being added to / removed from a group is remembered, so the admin can post there.
 *
 * Admin (Bot page): connect the bot, see who receives messages, send posts to
 * group / subscribers / admins, edit (any time) or delete (Telegram: within 48 h).
 * Messages go out in batches of 40 per request (free plan: max 50 outgoing requests each).
 */

const TOWN = new Set(['citizen', 'sheriff', 'doctor', 'maniac']);
const ROLE_LABEL = { citizen: 'Citizen', sheriff: 'Sheriff', doctor: 'Doctor', maniac: 'Maniac', mafia: 'Mafia', don: 'Don' };
const BATCH = 40;

export class BotError extends Error {
  constructor(status, message) { super(message); this.httpStatus = status; }
}

const escHtml = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export async function tg(env, method, payload) {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, description: 'TELEGRAM_BOT_TOKEN is not set' };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  return res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
}

/** Secret that Telegram sends back with every webhook call (derived from the bot token: nothing extra to configure). */
export async function webhookSecret(env) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.TELEGRAM_BOT_TOKEN}:mafia-bcn-webhook`));
  let s = '';
  for (const b of new Uint8Array(digest)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 48);
}

/* ============================================================
   Webhook
   ============================================================ */
export async function handleWebhook(request, env, deps) {
  if (!env.TELEGRAM_BOT_TOKEN || request.headers.get('x-telegram-bot-api-secret-token') !== await webhookSecret(env)) {
    return new Response('forbidden', { status: 403 });
  }
  const update = await request.json().catch(() => null);
  try {
    if (update && update.my_chat_member) await onMembership(env, update.my_chat_member);
    if (update && update.message) await onMessage(env, update.message, deps);
  } catch (e) {
    console.error('telegram webhook failed', e);
  }
  return new Response('ok');   // always 200, otherwise Telegram keeps retrying
}

async function saveChat(env, chat, status) {
  const title = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || null;
  await env.DB.prepare(
    `INSERT INTO bot_chats (chat_id, type, title, username, status) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET type = excluded.type, title = excluded.title, username = excluded.username,
       status = excluded.status, updated_at = datetime('now')`
  ).bind(String(chat.id), chat.type, title, chat.username || null, status).run();
}

async function onMembership(env, m) {
  const st = m.new_chat_member && m.new_chat_member.status;
  const active = ['member', 'administrator', 'creator'].includes(st);
  const status = active ? 'active' : (m.chat.type === 'private' ? 'blocked' : 'left');
  await saveChat(env, m.chat, status);
}

/** Same matching as the website login: known Telegram id → admin-prefilled @username → new (unlinked) account. */
async function ensureAccount(env, from) {
  const uid = String(from.id);
  const username = from.username || null;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || null;
  let acc = await env.DB.prepare("SELECT id, player_id FROM accounts WHERE provider = 'telegram' AND provider_uid = ?").bind(uid).first();
  if (!acc && username) {
    acc = await env.DB.prepare("SELECT id, player_id FROM accounts WHERE provider = 'telegram' AND provider_uid IS NULL AND lower(username) = lower(?) ORDER BY id LIMIT 1").bind(username).first();
    if (acc) await env.DB.prepare('UPDATE accounts SET provider_uid = ?, display_name = ? WHERE id = ?').bind(uid, name, acc.id).run();
  }
  if (!acc) {
    acc = await env.DB.prepare("INSERT INTO accounts (provider, provider_uid, username, display_name, status) VALUES ('telegram', ?, ?, ?, 'pending') RETURNING id, player_id")
      .bind(uid, username, name).first();
  } else {
    await env.DB.prepare('UPDATE accounts SET username = COALESCE(?, username), display_name = COALESCE(?, display_name) WHERE id = ?').bind(username, name, acc.id).run();
  }
  return acc;
}

async function onMessage(env, msg, deps) {
  const chat = msg.chat;
  if (msg.migrate_to_chat_id) {      // group upgraded to supergroup → new chat id
    await env.DB.prepare("UPDATE bot_chats SET chat_id = ?, type = 'supergroup', updated_at = datetime('now') WHERE chat_id = ?").bind(String(msg.migrate_to_chat_id), String(chat.id)).run();
    return;
  }
  const text = (msg.text || '').trim();
  if (!text.startsWith('/') || !msg.from) return;
  const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
  const isPrivate = chat.type === 'private';
  if (!isPrivate) await saveChat(env, chat, 'active');

  const reply = (html) => tg(env, 'sendMessage', {
    chat_id: chat.id, text: html, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(isPrivate ? {} : { reply_parameters: { message_id: msg.message_id } }),
  });

  if (cmd === '/stop' && isPrivate) {
    await saveChat(env, chat, 'blocked');
    return reply('You will not receive announcements any more. Send /start to subscribe again.');
  }

  const acc = await ensureAccount(env, msg.from);
  if (isPrivate && cmd !== '/stop') await saveChat(env, chat, 'active');
  const site = env.SITE_URL || deps.origin;

  if (cmd === '/start' || cmd === '/help') {
    const linked = acc && acc.player_id ? await env.DB.prepare('SELECT nickname FROM players WHERE id = ?').bind(acc.player_id).first() : null;
    const lines = [
      `👋 Hi${msg.from.first_name ? ' ' + escHtml(msg.from.first_name) : ''}! This is the <b>Mafia BCN</b> bot.`,
      '',
      isPrivate ? '✅ You will receive our announcements here.' : '',
      '',
      '<b>Commands</b>',
      '/mystats — your games, wins, rating and rank',
      '/stop — stop announcements',
      '',
      linked ? `🔗 Your Telegram is linked to player <b>${escHtml(linked.nickname)}</b>.`
             : '🔗 Your Telegram is not linked to a player yet — ask the game master (@voorest) to link you, or log in once on the website.',
      `🌐 ${site}`,
    ].filter((l, i, a) => !(l === '' && a[i - 1] === ''));
    return reply(lines.join('\n'));
  }

  if (cmd === '/mystats') {
    if (!acc || !acc.player_id) {
      return reply('🔗 Your Telegram is not linked to a player yet.\nAsk the game master (@voorest) to link you — then /mystats will show your stats.');
    }
    const data = await deps.publicData();
    return reply(playerStatsText(data, String(acc.player_id), site));
  }
}

/** Short stats summary for one player, from the public data copy (same rating rule as the website). */
export function playerStatsText(data, pid, site) {
  const K = data.settings && Number.isFinite(+data.settings.priorWeight) ? +data.settings.priorWeight : 5;
  const per = {};
  let seats = 0, wins = 0;
  const finished = (data.games || []).filter(g => g.winner).sort((a, b) => a.date.localeCompare(b.date) || a.number - b.number);
  for (const g of finished) {
    for (const s of g.seats) {
      if (!s.playerId || !s.role) continue;
      const won = (TOWN.has(s.role) ? 'town' : 'mafia') === g.winner;
      const p = (per[s.playerId] ||= { g: 0, w: 0, roles: {}, last: null });
      p.g++; seats++;
      if (won) { p.w++; wins++; }
      const r = (p.roles[s.role] ||= { g: 0, w: 0 });
      r.g++; if (won) r.w++;
      p.last = { date: g.date, number: g.number, role: s.role, won };
    }
  }
  const avg = seats ? wins / seats : 0.5;
  const rating = p => (p.w + K * avg) / (p.g + K);
  const ranked = Object.entries(per).sort((a, b) => rating(b[1]) - rating(a[1]));
  const me = per[pid];
  const player = (data.players || []).find(p => p.id === pid) || {};
  const name = escHtml(player.nickname || 'you');
  if (!me) return `📊 <b>${name}</b>\nNo finished games yet.\n${site}/player/${player.number || pid}`;
  const pct = x => Math.round(x * 100) + '%';
  const roles = Object.entries(me.roles).sort((a, b) => b[1].g - a[1].g).map(([r, v]) => `${ROLE_LABEL[r] || r} ${v.w}/${v.g}`).join(' · ');
  const d = new Date(me.last.date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return [
    `📊 <b>${name}</b> (No. ${player.number || pid})`,
    `🏅 Rank #${ranked.findIndex(([id]) => id === pid) + 1} of ${ranked.length} · rating ${pct(rating(me))}`,
    `🎲 Games ${me.g} · wins ${me.w} (${pct(me.w / me.g)})`,
    `🎭 ${roles}`,
    `🕒 Last game: ${d} — ${me.last.won ? 'won' : 'lost'} as ${ROLE_LABEL[me.last.role] || me.last.role}`,
    '',
    `Full stats: ${site}/player/${player.number || pid}`,
  ].join('\n');
}

/* ============================================================
   Admin: state, setup, posts
   ============================================================ */
export async function botState(env, origin) {
  const [chats, posts] = await env.DB.batch([
    env.DB.prepare(`SELECT c.chat_id, c.type, c.title, c.username, c.status, c.started_at, c.updated_at, p.nickname, a.role
                      FROM bot_chats c
                      LEFT JOIN accounts a ON a.provider = 'telegram' AND a.provider_uid = c.chat_id
                      LEFT JOIN players p ON p.id = a.player_id
                     ORDER BY c.type = 'private', c.updated_at DESC`),
    env.DB.prepare(`SELECT b.*,
                      (SELECT count(*) FROM bot_post_messages m WHERE m.post_id = b.id) AS total,
                      (SELECT count(*) FROM bot_post_messages m WHERE m.post_id = b.id AND m.state = 'sent') AS sent,
                      (SELECT count(*) FROM bot_post_messages m WHERE m.post_id = b.id AND m.state = 'failed') AS failed,
                      (SELECT count(*) FROM bot_post_messages m WHERE m.post_id = b.id AND m.state LIKE 'pending%') AS pending,
                      (SELECT count(*) FROM bot_post_messages m WHERE m.post_id = b.id AND m.state = 'deleted') AS deleted,
                      (SELECT group_concat(DISTINCT m.error) FROM bot_post_messages m WHERE m.post_id = b.id AND m.error IS NOT NULL) AS errors
                    FROM bot_posts b ORDER BY b.id DESC LIMIT 200`),
  ]);
  let webhook = null;
  if (env.TELEGRAM_BOT_TOKEN) {
    const info = await tg(env, 'getWebhookInfo', {});
    if (info.ok) webhook = { url: info.result.url, pending: info.result.pending_update_count, lastError: info.result.last_error_message || null };
  }
  return {
    tokenSet: !!env.TELEGRAM_BOT_TOKEN,
    expectedUrl: `${origin}/api/telegram/webhook`,
    webhook,
    chats: chats.results,
    posts: posts.results,
  };
}

export async function botSetup(env, url) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new BotError(400, 'TELEGRAM_BOT_TOKEN is not set in Cloudflare');
  if (['localhost', '127.0.0.1'].includes(url.hostname)) throw new BotError(400, 'Connect the bot from the live site, not from your computer');
  const hook = await tg(env, 'setWebhook', {
    url: `${url.origin}/api/telegram/webhook`,
    secret_token: await webhookSecret(env),
    allowed_updates: ['message', 'my_chat_member'],
  });
  if (!hook.ok) throw new BotError(502, 'Telegram: ' + hook.description);
  await tg(env, 'setMyCommands', {
    commands: [
      { command: 'mystats', description: 'My Mafia BCN stats' },
      { command: 'help', description: 'What this bot can do' },
      { command: 'stop', description: 'Stop announcements' },
    ],
  });
  return { ok: true };
}

async function targetsFor(env, audience, chatId) {
  if (audience === 'group') {
    const { results } = chatId
      ? await env.DB.prepare("SELECT chat_id FROM bot_chats WHERE chat_id = ? AND type IN ('group', 'supergroup') AND status = 'active'").bind(String(chatId)).all()
      : await env.DB.prepare("SELECT chat_id FROM bot_chats WHERE type IN ('group', 'supergroup') AND status = 'active'").all();
    return results.map(r => r.chat_id);
  }
  if (audience === 'subscribers') {
    const { results } = await env.DB.prepare("SELECT chat_id FROM bot_chats WHERE type = 'private' AND status = 'active'").all();
    return results.map(r => r.chat_id);
  }
  if (audience === 'admins') {
    const { results } = await env.DB.prepare("SELECT provider_uid AS chat_id FROM accounts WHERE role = 'admin' AND provider = 'telegram' AND provider_uid IS NOT NULL AND provider_uid != 'dev-admin'").all();
    return results.map(r => r.chat_id);
  }
  throw new BotError(400, 'Unknown audience');
}

export async function createPost(env, admin, body) {
  const text = String(body.text || '').trim();
  if (!text) throw new BotError(400, 'The message is empty');
  if (text.length > 4000) throw new BotError(400, 'Too long: Telegram allows up to 4096 characters');
  const audience = String(body.audience || '');
  const targets = await targetsFor(env, audience, body.chatId);
  if (!targets.length) {
    throw new BotError(400, audience === 'group' ? 'The bot is not in any group yet: add @mafia_bcn_bot to your group first.'
      : audience === 'subscribers' ? 'Nobody has pressed Start in the bot yet.' : 'No admin with a Telegram account found.');
  }
  const kind = ['announcement', 'game', 'update'].includes(body.kind) ? body.kind : 'announcement';
  const gameId = Number.isInteger(+body.gameId) && +body.gameId > 0 ? +body.gameId : null;
  const post = await env.DB.prepare('INSERT INTO bot_posts (kind, audience, text, game_id, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(kind, audience, text, gameId, admin.id).first();
  const per = 33;   // rows per insert (3 params each, D1 max 100 params)
  const stmts = [];
  for (let i = 0; i < targets.length; i += per) {
    const part = targets.slice(i, i + per);
    stmts.push(env.DB.prepare(`INSERT INTO bot_post_messages (post_id, chat_id, state) VALUES ${part.map(() => "(?, ?, 'pending')").join(', ')}`)
      .bind(...part.flatMap(c => [post.id, c])));
  }
  await env.DB.batch(stmts);
  return { id: post.id, ...(await processPost(env, post.id)) };
}

/** Do up to 40 pending sends / edits / deletes for a post. The page calls this again until remaining = 0. */
export async function processPost(env, id) {
  const post = await env.DB.prepare('SELECT id, text FROM bot_posts WHERE id = ?').bind(id).first();
  if (!post) throw new BotError(404, 'Post not found');
  const { results } = await env.DB.prepare("SELECT chat_id, message_id, state FROM bot_post_messages WHERE post_id = ? AND state LIKE 'pending%' LIMIT ?").bind(id, BATCH).all();
  const updates = [];
  const upd = (chatId, state, messageId, error) => updates.push(
    env.DB.prepare("UPDATE bot_post_messages SET state = ?, message_id = COALESCE(?, message_id), error = ?, updated_at = datetime('now') WHERE post_id = ? AND chat_id = ?")
      .bind(state, messageId ?? null, error ?? null, id, chatId));
  for (const row of results) {
    if (row.state === 'pending') {
      const r = await tg(env, 'sendMessage', { chat_id: row.chat_id, text: post.text, disable_web_page_preview: true });
      if (r.ok) upd(row.chat_id, 'sent', r.result.message_id, null);
      else {
        upd(row.chat_id, 'failed', null, r.description || 'failed');
        if (r.error_code === 403) updates.push(env.DB.prepare("UPDATE bot_chats SET status = 'blocked', updated_at = datetime('now') WHERE chat_id = ?").bind(row.chat_id));
      }
    } else if (row.state === 'pending_edit') {
      const r = await tg(env, 'editMessageText', { chat_id: row.chat_id, message_id: row.message_id, text: post.text, disable_web_page_preview: true });
      const ok = r.ok || /not modified/i.test(r.description || '');
      upd(row.chat_id, 'sent', null, ok ? null : 'edit: ' + (r.description || 'failed'));
    } else if (row.state === 'pending_delete') {
      const r = await tg(env, 'deleteMessage', { chat_id: row.chat_id, message_id: row.message_id });
      const gone = r.ok || /not found/i.test(r.description || '');
      upd(row.chat_id, gone ? 'deleted' : 'sent', null, gone ? null : 'delete: ' + (r.description || 'failed') + ' (Telegram allows deleting only within 48 h)');
    }
  }
  if (updates.length) await env.DB.batch(updates);
  const left = await env.DB.prepare("SELECT count(*) AS n FROM bot_post_messages WHERE post_id = ? AND state LIKE 'pending%'").bind(id).first();
  return { remaining: left.n };
}

export async function editPost(env, id, body) {
  const text = String(body.text || '').trim();
  if (!text) throw new BotError(400, 'The message is empty');
  if (text.length > 4000) throw new BotError(400, 'Too long: Telegram allows up to 4096 characters');
  const post = await env.DB.prepare('SELECT id, deleted_at FROM bot_posts WHERE id = ?').bind(id).first();
  if (!post) throw new BotError(404, 'Post not found');
  if (post.deleted_at) throw new BotError(400, 'This post was deleted');
  await env.DB.batch([
    env.DB.prepare("UPDATE bot_posts SET text = ?, edited_at = datetime('now') WHERE id = ?").bind(text, id),
    env.DB.prepare("UPDATE bot_post_messages SET state = 'pending_edit', error = NULL WHERE post_id = ? AND state = 'sent'").bind(id),
  ]);
  return processPost(env, id);
}

export async function deletePost(env, id) {
  const post = await env.DB.prepare('SELECT id FROM bot_posts WHERE id = ?').bind(id).first();
  if (!post) throw new BotError(404, 'Post not found');
  await env.DB.batch([
    env.DB.prepare("UPDATE bot_posts SET deleted_at = datetime('now') WHERE id = ?").bind(id),
    env.DB.prepare("UPDATE bot_post_messages SET state = 'pending_delete', error = NULL WHERE post_id = ? AND state = 'sent'").bind(id),
    env.DB.prepare("UPDATE bot_post_messages SET state = 'deleted', error = NULL WHERE post_id = ? AND state IN ('pending', 'failed')").bind(id),
  ]);
  return processPost(env, id);
}
