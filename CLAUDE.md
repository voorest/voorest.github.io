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
- Code and comments are in English. **Telegram bot messages are always in Ukrainian.**
- The site is shown in **Ukrainian by default**, with an **UA / EN** switch in the header (kept per browser in localStorage `mbcn.lang`).
- How: every visible text in the code is written in English inside `t('…')` (`public/js/i18n.js`); the Ukrainian words are in `public/js/lang/uk.js` (English text → Ukrainian; a missing entry shows in English). Placeholders `{n}`; plural forms via `tn(n, 'game')` (PLURALS in i18n.js, Ukrainian has 3 forms). Role names via `roleLabel(r)`, dates via `locale()`. Menu texts in index.html use `data-i18n`.
- When adding a text: wrap it in `t()` and add its Ukrainian line to `uk.js`. Server error messages pass through `t()` too, so common ones are in `uk.js`.

## Local development
`npm run seed:local` (copies the newest `data/mafia-bcn-backup-*.json` into the local D1; without a backup it reloads `data/import.sql`; both empty the tables first, so it can be run again), then `npm run dev`. On localhost with `DEV_LOGIN=true` in `.dev.vars` there is a "Dev login" button ("Вхід (розробка)"). It is disabled in production (needs both the var and the localhost hostname).

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
- `players` names: **nickname** (public, e.g. "Tianaboa") and **name** (player name, e.g. "Tania"), both set by the admin only. Nicks are written in Latin letters and are **unique** (ignoring case): a taken nick is refused with "already taken, choose another". Couples get ♂/♀ after a shared family nick ("Orsini ♀"). Names are in Ukrainian. Everywhere on the site (dashboard too: leaderboard, titles, role leaders) members see "name nick" and guests only the nick, because guests get no names at all (`fullName` in data.js, `displayName` in bot.js; just the nick if there's no name or the nick already contains it). **First and last names** are private: the admin, or the player on their own page ("My details", `PATCH /api/me/profile`).
- **Photos** (`avatar_v`, `avatar_src`): stored in KV `avatar:<player id>` (≤150 KB, 320×320, WebP/JPEG/PNG), served by `GET /api/avatar/<No.>?v=<version>` **only to members** (admin or linked players); everyone else sees the default icon: `public/images/mafia-man.svg` / `mafia-woman.svg` (owner-made, black drawing on a light disc, on a light disc (`.ava-icon`); avatars are 32px in lists (`.ava`), 96px on the player page (`.ava-lg`)) by `players.gender` ('m'/'f', set by the admin on the Players page), or the neutral hat if gender is not set. The Telegram profile photo is taken on first login/Start (if none was set or removed); a player can upload (crop dialog) / take from Telegram / remove their own; the admin can do it for anyone, plus "📷 Load Telegram photos" in bulk (Players page). Player **No.** = `players.number` (join order): a new player gets max+1, so deleting the newest frees its number; deleting an older one leaves a gap and nobody is renumbered.
- `accounts`: Telegram logins linked to a player. role `player` (default) or `admin`. Admin is granted only in the DB/admin UI, never by sign-up. On the Players page every link/role change asks for confirmation (Cancel restores the old value); your own role is shown as "admin · you" and can't be changed there (the server refuses it too).
- Linking: the admin enters a player's Telegram @username, and the player is linked on first login. The admin can also link a login by hand.
- First login (site or bot Start) sends admins a Telegram notice: "✅ … linked automatically to <player>" (matched the pre-filled @username) or "🆕 … not linked yet" with a link to /players. Matching order: known Telegram id → pre-filled @username → new pending account. The admin can also store a Telegram ID in advance (accounts row with provider_uid + player_id, e.g. from a Telegram Desktop group export): the first login/Start then sends "✅ … (за Telegram ID)". Players page chips: green = connected, plain = ID known (waiting), grey = @username waiting.
- **Guests vs members (31 Oct 2026):** a *member* is the admin or a login linked to a player (`isMember` in worker.js; `status='linked'` + `player_id`). Guests get only nicks: the public KV copy has no `name` field. Members get the same copy plus `names` ({player id: short name}) read from D1 in `dataEndpoint`, merged in the browser; nothing is stored twice. Photos are for members too. A Telegram login that is not linked yet counts as a guest.
- Public pages show only the dashboard, games and player stats, by nickname.
- The "Admin mode" banner shows only on game pages (where games are edited).
- Menu links Data, Settings, Bot and My stats are **not in index.html** (crawlers followed them). "My stats" is added to the top menu for members (`syncPrivateNav()`); the admin pages (`ADMIN_NAV`) live only in the side menu under an "Адмін" heading, below the "Сайт" pages. For the admin the burger shows on desktop too (right of Log out; body class `with-admin-menu`), so the header stays short. The pages themselves send others to the dashboard, and all admin data needs an admin session anyway.
- Dashboard: the leaderboard cells are tight (`table.lb` padding .3rem .3rem .3rem 0, no right padding in the last column); role leaders show "середнє N%"; the last day's games are headed "Нещодавні ігри" / "Recent games" (not "Останній", which reads as "final").
- Players page: Edit / Delete are icon buttons (pencil, bin). The logins table column is "Last site login" (UTC): pressing Start in the bot is not a site login, such rows show "лише бот".
- **Phones (≤760px):** the menu and login move into a side panel opened by the burger button right of UA/EN: login info + Log out (or the login button) on top, then the menu items and "About". It closes on a link, ✕, the dark backdrop or Esc.
- **Compare** (menu "Порівняння", also "⇄ Compare" on every player page): two players side by side (rating, place, games, win %, Impact, alive, each role, game facts, titles); green = better in that row, rows like games/shot are neutral. Default: you vs the top player (the 2nd if you are the top); visitors see #1 vs #2. Picking the other side's player swaps them. Only two players for now; no head-to-head (pair stats were dropped).
  - Address: plain `/compare` for the default; once a pair is picked it becomes `/compare/<nick>-vs-<nick>` with nick slugs (Latin, lower case, `♀/♂` → `-f/-m`, e.g. `/compare/orsini-f-vs-micro`). A nick with no usable slug, or one shared with another player, uses `p<No.>`. Not places, because places change. Old `/compare/<No.>/<No.>` links are converted. The slug rules are in both `app.js` and `src/seo.js` (keep them the same).
  - "🔗 Share" button: the phone share sheet on touch devices, otherwise copies the link (`?lang=en` added when the site is in English). Shared links get a Telegram preview title with both nicks.

## Scanner protection (Cloudflare WAF, Oct 2026)
- One custom rule "Block scanners" (Security → WAF → Custom rules, Block), set by the owner in the dashboard. It is an **allowlist**: anything that is not a real page, file or API path is blocked before the Worker runs; also non-GET/HEAD requests outside `/api/`. Chosen after a log check on 27 Oct 2026: 1237 of 2000 requests were scanners (.env, .aws, .git, wp-*, phpinfo, actuator…), mostly from data centres (Google Cloud, TC Datacenter PL, DigitalOcean).
- Allowed: `/`, `/index.html`, `/dashboard`, `/games`, `/players`, `/compare`, `/about`, `/data`, `/settings`, `/bot`, `/me`, `/robots.txt`, `/sitemap.xml`, the favicon/android-chrome/webmanifest files, `/api/data|health|me|telegram/webhook`; prefixes `/game/`, `/player/`, `/compare/`, `/login-error/`, `/js/`, `/css/`, `/images/`, `/apple-touch-icon`, `/cdn-cgi/`, `/api/me/`, `/api/avatar/`, `/api/auth/`, `/api/admin/`.
- **When adding a new page route, a top-level file in `public/` or a new `/api/` branch, tell the owner to add it to the rule**, or it will be blocked.
- Don't enable Bot Fight Mode (it breaks the Telegram webhook).

## Search engines & link previews (open for indexing, Oct 2026)
- `public/robots.txt`: everything allowed except `/api/`; points to the sitemap.
- **Only the home page and `/about` are indexed** (decided Oct 2026, privacy): `/sitemap.xml` (Worker, `src/seo.js`) lists just those two, in uk and en. Every other page gets `noindex, follow` but keeps its own title and link preview for Telegram.
- Every page is index.html; the Worker fills the `<!-- seo -->…<!-- /seo -->` block per page: title, description, canonical, hreflang (uk = plain address, en = `?lang=en`), Open Graph (logo `android-chrome-512x512.png`) and JSON-LD on the home page. Player pages use the nick from the KV copy (for the preview).
- `?lang=en|uk` in the address sets the site language (and is removed when the visitor switches language).
- `/about` ("Про Mafia BCN", footer link): who we are, how the game works, roles, what the site shows, "want to play?" with a "Write to the game master in Telegram" button (t.me/voorest). Visitors also see a one-line intro with a link on the dashboard.
- Google Search Console: the owner verifies the domain himself (Cloudflare one-click), then submits `https://mafiabcn.com/sitemap.xml`.

## Login
Telegram OpenID Connect (authorization code + PKCE). BotFather → Login Widget:
- redirect URL `/api/auth/telegram/callback`;
- trusted origin = site URL;
- RS256 signing.

Sessions are stored in D1 as SHA-256 hashes; the cookie is HttpOnly.

## Saving & editing
- The admin edits on the live site. **Game edits are a draft** (a new game too, see above): a "Save changes" bar with a confirm dialog that lists the changes. Leaving the page with unsaved changes asks first.
- Game editor shortcuts (Oct 2026):
  - **Quick add** above the seats has the same 3 fields as the Players page (name, nick, gender); the new player takes the first empty seat. An empty nick falls back to the name.
  - **Role picker** shows the 3-letter code first: МИР, ШЕР, ЛІК, МАН, МАФ, ДОН (`ROLES[r].code`, English CIT/SHR/DOC/MAN/MAF/DON translated in uk.js). Our own type-to-pick on the player and role pickers: letters typed quickly match the start of any word, in Ukrainian or English ("ми" → МИР, "sh" → Sheriff); the same letter again goes to the next match. A keyboard pick is applied at once and the page is re-drawn on Enter (focus moves to the same picker one seat down) or when leaving the picker. A mouse pick re-draws at once.
  - **"⌨ As text"** in each round's day: a textarea with one nomination per line `who-whom-votes` (`2-5-1`; any non-digit separates; `0-5-3` = revote row with empty "who"). Every edit replaces the round's nominations; the seat that clearly got the most votes in the last vote (the revote rows if there are any) is ticked as voted out; on a tie the admin picks (an auto-ticked seat is unticked). Editing the nomination rows by hand closes the box. Revote logic may still change.
- Writes need JSON plus a same-origin check. Every successful admin write rebuilds the KV public copy.

## Free-limit protection (decided Oct 2026)
- Guests never read D1. `/api/data?v=<version>` serves the KV copy or `{unchanged:true}`. Versions are `g-<v>` (guest copy) and `m-<v>` (member copy: + one D1 query for names, and the session check), so logging in or out swaps the browser's copy.
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
  - **Status**: connection, groups, number of subscribers (`GET /api/admin/bot`, light). Fetched once per visit to the site (kept in memory across Bot page visits), ↻ Refresh to check again.
  - **Commands**: list + preview of the bot's answer as any player or as "not linked" (`POST /api/admin/bot/preview`, nothing is sent). Each command + player is asked once and kept in memory; the key includes a fingerprint of the data, so a saved game refreshes it; ↻ asks again. Replies come from `commandReply()` in bot.js, the same function the webhook uses.
  - **New post**: audience Group / Subscribers / One person (loads the list on demand) / Admins. No "type" field (the kind is still stored: day / game from the template, else announcement).
  - **Templates**: only Day stats (picked game day, built in `dayStatsText`) and Last game (the others were removed 31 Oct 2026).
  - History was cleaned on 31 Oct 2026 (test posts removed from the DB; only the real day post of 27 Oct 2026 kept).
  - Bottom tabs **History** and **Who receives messages** load only on a button press (`/bot/posts`, `/bot/chats`), with Refresh, and stay in memory until you leave the page.
  - History: edit any time, delete within 48 h (Telegram).
- Game page: "📣 Publish to Telegram" pre-fills the game in the agreed Ukrainian format (`gameBlockUk`). "⧉ Next game, same players" (also on the Games list per day) opens a draft of the next game that day with the same seats and players, roles empty.
- Tables: `bot_chats`, `bot_posts`, `bot_post_messages` (message_id per chat, needed for edit/delete). Sends go out in batches of 40 per request (free plan allows 50 outgoing requests).

## Ratings (fair comparison, may be tuned)
- `rating = (wins + K·avg) / (games + K)`, K = 5 (Settings).
- Role ratings use each role's own average.
- **Impact** ("Вплив", was "± exp.") = wins minus the wins expected from the roles a player received.
- Titles: King (best rating, min games), Best Role Player (above average in 3+ roles), Best Sheriff/Don/Mafia/Citizen/Doctor/Maniac, Sharp Eye, Survivor, Most Loyal, Night Target.

## Game and day posts (short format, agreed 31 Oct 2026; topic still to do)
- Bot page → template "Day stats" + game day → draft to review, then send. Game page "📣 Publish to Telegram" / template "Last game" = one game. Built in app.js (`gameBlockUk`, `gameSummaryText`, `dayStatsText`).
- **Links:** post text may contain `[text](https://…)`; posts are sent with HTML parse mode (`postHtml` in bot.js escapes everything else), link preview off. The Bot page shows a live preview under the text box, and History shows the links too.
- Format, in Ukrainian, **nicks only**, `" | "` between groups:
  - header `[Mafia BCN](site) | DD/MM/YYYY`; the day post adds `Мирні N : M Мафія`;
  - per game: `⚫ [Гра N](game link) — перемога мафії` / `🔴 … — перемога мирних`, then `🎩 don | 🕴️ mafia, …` and `⭐ sheriff | 🩺 doctor | 🔪 maniac`. Role emoji come from `ROLES[r].icon` in data.js (also used for the site's titles: 🏠 citizen); one set everywhere. Citizens are not listed;
  - day facts, one line each, skipped if empty: `🏆 Без поразок:` (100% wins that day), `📈` / `📉` biggest rating moves (numbers only), `🆕 Нові:`;
  - `🏅 Топ-3 (від N ігор): 1. nick 64% ↑1 | …`;
  - footer `📊 Твоя статистика: /mystats у @mafia_bcn_bot`.
- Still to do: post into a group topic (the admin types a command in the topic once, and the bot remembers the thread id).

## Ideas / next
- Bot ideas agreed (Oct 2026), all sent by the admin with a button, never automatically on save (archive entry would spam):
  - **Personal day summary** to each linked player: "DD/MM/YYYY: 3 games, 2 wins, rating 58% → 63%, +2 places". Uses the game date, not "today".
  - **Title notices**: a player gained or lost a title (King, Best Sheriff…), from comparing titles before and after the day.
  - **Monthly summary** (personal): games, best role, change vs last month.
- Dropped: pair stats ("with whom you win"), sign-up polls (not planned for now). Postponed: Telegram Mini App (the website with its cached data check is enough).
- Settings that are still open: rating formula details, which titles to keep.
- Logo images (owner-made) are kept privately in `data/` (tg-logo-full.jpg, tg-logo-bot-full.jpg). The site header uses `public/images/logo.png` (180×180), shown round left of "Mafia BCN".
