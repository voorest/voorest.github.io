# Mafia BCN: project memory

Stats website for our weekend Mafia games in Barcelona (Ukrainian-speaking group, Telegram chat).
Owner and game master: @voorest (the only admin). Live: https://mafia-bcn.voorest.workers.dev

## Stack & hosting (all Cloudflare free plan)
- **Worker** `mafia-bcn` (`src/worker.js`) serves `public/` (plain HTML/CSS/JS, no build step) and the API.
- **D1** database `mafia-bcn` (id 44855031-…): the source of truth. Schema lives in `migrations/`.
- **KV** `mafia-bcn-kv`: the public data copy (`public:data`) and backups (`backup:<date>-weekly|manual`).
- **Deploy:** GitHub `voorest/voorest.github.io` → Cloudflare Workers Builds. **Only `master` deploys**; work on `dev`, then fast-forward `master`.
- Secrets live only in Cloudflare (Worker → Variables and Secrets): `TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`. Never commit them.
- The repo is public, so **no real data in git**: `data/` is ignored (xlsx, backups, `import.sql`).
- I (Claude) change the DB through the Cloudflare connector; schema changes are applied by hand. Also insert the migration name into `d1_migrations`.

## Game rules as modelled
- Roles: citizen (МИР), sheriff (Ш), doctor (ЛІК), **maniac (МАН) = citizens' team**, mafia (М), don (ДМ).
- Winner is `town` or `mafia`; every seat on the winning team gets a win.
- 6–16 seats per game, with a variable role pack.
- A round = **Night N first** (mafia shot, don check, sheriff check, maniac shot, doctor heal), **then Day N** (nominations: who → whom + votes received, then voted out / removed for fouls).
- A doctor heal cancels a shot on the same seat.
- Imported spreadsheet games (`source='xls'`) have no night notes. Their "alive at end" is stored per seat and trusted; for app games it is computed.
- Games are numbered per day (`number`) and shown with an **overall #** (running order across all games).
- Game days are Sundays; history imported from `Mafia_stats_v2.xlsx` (14 games, 1 Mar to 3 May 2026). The sheet had day/month swaps, which are fixed.

## People & privacy
- `players`: **nickname is the only public field**. First and last names are private (admin only). Player **No.** = id = join order.
- `accounts`: Telegram logins linked to a player. role `player` (default) or `admin`. Admin is granted only in the DB/admin UI, never by sign-up.
- Linking: the admin enters a player's Telegram @username, and the player is linked on first login. The admin can also link a login by hand.
- Public pages show only the dashboard, games and player stats, by nickname.

## Login
Telegram OpenID Connect (authorization code + PKCE). BotFather → Login Widget:
- redirect URL `/api/auth/telegram/callback`;
- trusted origin = site URL;
- RS256 signing.

Sessions are stored in D1 as SHA-256 hashes; the cookie is HttpOnly.

## Saving & editing
- The admin edits on the live site. **Game edits are a draft**: a "Save changes" bar with a confirm dialog that lists the changes. Leaving the page with unsaved changes asks first.
- Writes need JSON plus a same-origin check. Every successful admin write rebuilds the KV public copy.

## Free-limit protection (decided Oct 2026)
- Visitors never read D1. `/api/data?v=<version>` serves the KV copy or `{unchanged:true}`.
- The browser keeps the data + version in localStorage.
- Client throttle: 3 checks per minute are free, then the device waits 10 s → 30 s → 60 s → 2 min → 5 min, using the saved copy meanwhile.
- Server rate limit: 30 data requests per minute per IP (`RL` binding).
- Admin requests skip the cache (always fresh from D1).

## Backups & alerts
- Cron every **Sunday 07:00 UTC** writes a full backup to KV and keeps 12 weekly + 5 manual.
- Data page (admin): backups list, Download, "Back up now", "Send test message".
- D1 also has 7-day point-in-time restore. The admin downloads a copy into `data/` from time to time.
- Telegram messages go **only to admin accounts** that pressed Start in @mafia_bcn_bot: backup report, error alerts (max 1/hour). The Bot API is free.

## Ratings (fair comparison, may be tuned)
- `rating = (wins + K·avg) / (games + K)`, K = 5 (Settings).
- Role ratings use each role's own average.
- "± exp." = wins minus the wins expected from the roles a player received.
- Titles: King (best rating, min games), Best Role Player (above average in 3+ roles), Best Sheriff/Don/Mafia/Citizen/Doctor/Maniac, Sharp Eye, Survivor, Most Loyal, Night Target.

## Ideas / next
- Bot: publish a game summary to the group, editable or deletable via the stored message_id; game announcements and sign-up; `/mystats`; open the site as a Telegram Mini App.
- Settings that are still open: rating formula details, which titles to keep.
- Logo: `public/img/logo.svg|png` (Ukrainian blue #0057B7 and yellow #FFD700) and bot avatar `public/img/bot.svg|png`.
