# Mafia BCN: project memory

Stats website for our weekend Mafia games in Barcelona (Ukrainian-speaking group, Telegram chat).
Owner and game master: @voorest (the only admin). Live: https://mafiabcn.com (domain bought in Cloudflare, Oct 2026).

## Stack & hosting (all Cloudflare free plan)
- **Worker** `mafia-bcn` (`src/worker.js`) serves `public/` (plain HTML/CSS/JS, no build step) and the API.
- **D1** database `mafia-bcn` (id 44855031-…): the source of truth. Schema lives in `migrations/`.
- **KV** `mafia-bcn-kv`: the public data copy (`public:data`) and backups (`backup:<date>-weekly|manual`).
- **Deploy:** GitHub `voorest/voorest.github.io` → Cloudflare Workers Builds. **Only `master` deploys**; work on `dev`, then fast-forward `master`.
- Secrets live only in Cloudflare (Worker → Variables and Secrets): `TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`. Never commit them.
- The repo is public, so **no real data in git**: `data/` is ignored (xlsx, backups, `import.sql`).
- I (Claude) change the DB through the Cloudflare connector; schema changes are applied by hand. Also insert the migration name into `d1_migrations`.

## Domain
- `SITE_URL` (wrangler `vars`) = https://mafiabcn.com. The `*.workers.dev` address is off (`workers_dev: false`, `preview_urls: false`). Pages on `www.` or plain `http://` get a 301 to it; `/api/*` works on every host. `run_worker_first` covers only `/` and `/index.html`, so assets stay free.
- BotFather Login Widget needs the redirect URL and trusted origin for each host people log in on.
- Bot links use `SITE_URL`.

## Language
- The site, code and comments are in English. **Telegram bot messages are in Ukrainian.**

## Local development
`npm run seed:local` (copies the newest `data/mafia-bcn-backup-*.json` into the local D1), then `npm run dev`. On localhost with `DEV_LOGIN=true` in `.dev.vars` there is a "Dev login (local admin)" button. It is disabled in production (needs both the var and the localhost hostname).

## Game rules as modelled
- Roles: citizen (МИР), sheriff (Ш), doctor (ЛІК), **maniac (МАН) = citizens' team**, mafia (М), don (ДМ).
- Winner is `town` or `mafia`; every seat on the winning team gets a win.
- 7–16 players per game (`SEATS_MIN`/`SEATS_MAX` in data.js and worker.js), with a variable role pack. The seat count is chosen on New game ("Players") and can be changed in the editor.
- Date inputs show DD/MM/YYYY (text field + 📅 native picker); the stored format is ISO.
- A round = **Night N first** (mafia shot, don check, sheriff check, maniac shot, doctor heal), **then Day N** (nominations: who → whom + votes received, then voted out / removed for fouls).
- A doctor heal cancels a shot on the same seat.
- A night action counts only while its role is alive at the start of that night (mafia shot: any mafia/don alive). The editor hides the action once the role is out; an old value is ignored and flagged.
- Winner hint (`GameLogic.outcome`): town if no mafia left; mafia if mafia ≥ citizens; also mafia if, **after a day**, mafia ≥ citizens − 1 and no doctor or maniac is alive (the last night is a formality, so no extra round is needed).
- Day: "Voted out" is a multi-pick (nobody / one / both on a tie). A revote is entered as extra nomination rows with an empty "who"; those rows don't count for nomination stats. Empty votes = not counted (null), not 0.
- Imported spreadsheet games (`source='xls'`) have no night notes. Their "alive at end" is stored per seat and trusted; for app games it is computed.
- Games are numbered per day (`number`) and shown with an **overall #** (running order across all games).
- **No database ids in the UI.** Plain addresses (History API, no `#`): games `/game/DD-MM-YYYY/N` (date + game # of the day), players `/player/<No.>`, plus `/games`, `/players`, `/bot` and so on. The Worker serves index.html for any path without a file extension. Old `/#/…` links and `#/game/<id>` links are converted on load.
- **New game = browser-only draft** (`/game/new`) until the first "Save changes", which POSTs the whole game (create + save in one request). Leaving or Discard drops it.
- Game days are Sundays; history imported from `Mafia_stats_v2.xlsx` (14 games, 1 Mar to 3 May 2026). The sheet had day/month swaps, which are fixed.

## People & privacy
- `players`: **nickname is the only public field**. First and last names are private (admin only). Player **No.** = `players.number` (join order): a new player gets max+1, so deleting the newest frees its number; deleting an older one leaves a gap and nobody is renumbered.
- `accounts`: Telegram logins linked to a player. role `player` (default) or `admin`. Admin is granted only in the DB/admin UI, never by sign-up. On the Players page every link/role change asks for confirmation (Cancel restores the old value); your own role is shown as "admin · you" and can't be changed there (the server refuses it too).
- Linking: the admin enters a player's Telegram @username, and the player is linked on first login. The admin can also link a login by hand.
- First login (site or bot Start) sends admins a Telegram notice: "✅ … linked automatically to <player>" (matched the pre-filled @username) or "🆕 … not linked yet" with a link to /players. Matching order: known Telegram id → pre-filled @username → new pending account.
- Public pages show only the dashboard, games and player stats, by nickname.

## Login
Telegram OpenID Connect (authorization code + PKCE). BotFather → Login Widget:
- redirect URL `/api/auth/telegram/callback`;
- trusted origin = site URL;
- RS256 signing.

Sessions are stored in D1 as SHA-256 hashes; the cookie is HttpOnly.

## Saving & editing
- The admin edits on the live site. **Game edits are a draft** (a new game too, see above): a "Save changes" bar with a confirm dialog that lists the changes. Leaving the page with unsaved changes asks first.
- Writes need JSON plus a same-origin check. Every successful admin write rebuilds the KV public copy.

## Free-limit protection (decided Oct 2026)
- Visitors never read D1. `/api/data?v=<version>` serves the KV copy or `{unchanged:true}`.
- The browser keeps the data + version in localStorage.
- Client throttle: 3 checks per minute are free, then the device waits 10 s → 30 s → 60 s → 2 min → 5 min, using the saved copy meanwhile.
- Server rate limit: 30 data requests per minute per IP (`RL` binding).
- Admin requests skip the cache (always fresh from D1).

## Backups & alerts
- Cron every **Sunday 07:00 UTC** writes a full backup to KV and keeps 12 weekly + 5 manual.
- Data page (admin): backups list (loads on "Show backups", with Refresh), Download, "Back up now".
- D1 also has 7-day point-in-time restore. The admin downloads a copy into `data/` from time to time.
- Telegram messages go **only to admin accounts** that pressed Start in @mafia_bcn_bot: backup report, error alerts (max 1/hour). The Bot API is free.

## Telegram bot (@mafia_bcn_bot, `src/bot.js`)
- Webhook `POST /api/telegram/webhook`. Its secret is derived from the bot token, so there is nothing extra to configure. Connect it once from the live site: Bot page → "Connect bot".
- Commands (answers in Ukrainian): `/start` (subscribe + auto-link by the @username the admin pre-filled), `/mystats` (only for linked players), `/help`, `/stop`. Admin alerts (backup, errors) are in Ukrainian too.
- **Only people who pressed Start receive messages.** The bot is added to the group by hand and remembered via `my_chat_member`.
- Bot page (admin, live only), top part loads at once:
  - **Status**: connection, groups, number of subscribers (`GET /api/admin/bot`, light).
  - **Commands**: list + preview of the bot's answer as any player or as "not linked" (`POST /api/admin/bot/preview`, nothing is sent). Replies come from `commandReply()` in bot.js, the same function the webhook uses.
  - **New post**: audience Group / Subscribers / One person (loads the list on demand) / Admins.
  - **Templates**: Day stats (picked game day, agreed format, built in `dayStatsText`), Last game, Game night, Reminder, /mystats how-to, Welcome, Site update.
  - Bottom tabs **History** and **Who receives messages** load only on a button press (`/bot/posts`, `/bot/chats`), with Refresh, and stay in memory until you leave the page.
  - History: edit any time, delete within 48 h (Telegram).
- Game page: "📣 Publish to Telegram" pre-fills the game in the agreed Ukrainian format (`gameBlockUk`). "⧉ Next game, same players" (also on the Games list per day) opens a draft of the next game that day with the same seats and players, roles empty.
- Tables: `bot_chats`, `bot_posts`, `bot_post_messages` (message_id per chat, needed for edit/delete). Sends go out in batches of 40 per request (free plan allows 50 outgoing requests).

## Ratings (fair comparison, may be tuned)
- `rating = (wins + K·avg) / (games + K)`, K = 5 (Settings).
- Role ratings use each role's own average.
- "± exp." = wins minus the wins expected from the roles a player received.
- Titles: King (best rating, min games), Best Role Player (above average in 3+ roles), Best Sheriff/Don/Mafia/Citizen/Doctor/Maniac, Sharp Eye, Survivor, Most Loyal, Night Target.

## Day stats post (template built; topic + hidden links still to do)
- Bot page → template "Day stats" + game day → draft to review, then send. Still to do: post into a group topic, links hidden behind text.
- Format, in Ukrainian:
  - header `Mafia BCN · DD/MM/YYYY` and a games score;
  - per game: `Гра #N — перемога мирних 🔴` / `перемога мафії ⚫`. The circle goes only in the header.
  - role lines in this order: Дон, Мафія, Шериф, Лікар, Маніяк, Мирні;
  - "Найкращі гравці дня": everyone with 100% wins that day; skip the block if nobody;
  - rating change: biggest moves, numbers only, no comments; new players on a separate line;
  - top-5 (min games) with ↑↓;
  - links hidden behind text (HTML parse mode), link preview off.
- Topic: the admin types a command in the topic once, and the bot remembers the thread id.

## Ideas / next
- Bot: game sign-up polls, weekly/monthly summaries, open the site as a Telegram Mini App.
- Settings that are still open: rating formula details, which titles to keep.
- Logo images (owner-made) are kept privately in `data/` (tg-logo-full.jpg, tg-logo-bot-full.jpg).
