# Mafia BCN — Game Log

Games, stats and titles for our weekend Mafia games in Barcelona.

**Live site:** https://mafiabcn.com (Cloudflare: website + API + D1 database).

## How it fits together

```
GitHub (this repo)  ──push to master──▶  Cloudflare Workers Builds  ──deploys──▶  mafiabcn.com
                                                                                        │
                                                                     Cloudflare D1 database "mafia-bcn"
```

- `public/`: the website (plain HTML/CSS/JS, no build step)
- `src/worker.js`: the Cloudflare Worker. It serves `public/` and the API (`GET /api/data`)
- `migrations/`: database schema (SQL)
- `scripts/import_xls.py`: one-off import of the old spreadsheet
- `data/`: **private** files (spreadsheets, backups, generated SQL). They're ignored by git, so they never reach this public repo.
- `wrangler.jsonc`: Cloudflare config (Worker name, database binding)

Pages have plain addresses (`/games`, `/game/17-05-2026/1`, `/player/27`); the Worker serves `index.html` for all of them.
To run it on your computer use `npm run dev` (see below). Opening `public/index.html` directly no longer works.

## Branches and deploys

- `master` = production. Every push to `master` deploys automatically.
- `dev` = work in progress. Do the work here, then merge into `master` when it's ready.

```bash
git checkout dev        # work here
git push origin dev     # does NOT deploy
git checkout master && git merge dev && git push   # deploys
```

## Cloudflare firewall rule (read before adding pages or files)

The site sits behind a Cloudflare WAF custom rule, **"Block scanners"** (dashboard → mafiabcn.com → Security → WAF → Custom rules, action *Block*).
It is an **allowlist**: every address that is not one of our pages, files or API paths is blocked before it reaches the Worker. This stops the bots that probe for `.env`, `.git`, `wp-admin`, `*.php` and the like.

The exact expression is kept in [`cloudflare/waf-block-scanners.txt`](cloudflare/waf-block-scanners.txt). It is set by hand in the dashboard, so the file and the dashboard must be kept the same.

**Update the rule (file + dashboard) before releasing** when you add:
- a new page address (a new first part such as `/stats`, or a new pattern under `/game/`, `/player/`, `/compare/` that contains a dot);
- a new file in the root of `public/`, a new folder in `public/`, or a new file type in `js/`, `css/` or `images/` (only `.js`, `.css`, `.png` and `.svg` are allowed there now);
- a new `/api/…` branch that is not under `/api/me/`, `/api/avatar/`, `/api/auth/` or `/api/admin/`;
- a POST/PATCH/DELETE outside `/api/` (all of them are blocked).

Otherwise the new page or file shows Cloudflare's "Sorry, you have been blocked" page. Blocked requests are listed in Security → Events.
Note: Cloudflare merges `//` into `/` before the rule runs. Don't turn on Bot Fight Mode, because it breaks the Telegram webhook.

## Run it on your computer (before releasing)

Needs [Node.js LTS](https://nodejs.org). It runs a **local copy**; the real database is never touched.

```bash
npm install                 # once: installs wrangler (Cloudflare's tool)
copy .dev.vars.example .dev.vars    # once (Windows; on Mac/Linux use cp): enables "Dev login"
# Live site → Data → "Full backup" → save into data/   (any time you want fresh data locally)
npm run seed:local          # loads the newest data/mafia-bcn-backup-*.json into the local database
npm run dev                 # open http://localhost:8787 → "Dev login (local admin)"
```
`seed:local` also creates the tables. Without a backup in `data/` it loads `data/import.sql` (the original spreadsheet import).
To try the Sunday backup job locally, run `npm run dev`, then open http://127.0.0.1:8787/cdn-cgi/local/scheduled.

## Login & admin

Secrets live in Cloudflare (Worker → Settings → Variables and Secrets), never in this repo:
`TELEGRAM_CLIENT_ID`, `TELEGRAM_CLIENT_SECRET` (from @BotFather → Login Widget) and `TELEGRAM_BOT_TOKEN`.
Telegram redirects back to `/api/auth/telegram/callback`. Sessions are stored in D1 (`sessions`), and the cookie holds a random token.
Admins are accounts with `role = 'admin'`.

## Database

Tables: `players` (public nickname + private names), `accounts` (Telegram/Google logins linked to a player),
`games`, `game_seats` (seat, player, role, alive at end), `nominations` (who → whom, votes),
`round_events` (voted out, removed, mafia/maniac shot, don/sheriff check, doctor heal).

Roles: citizen, sheriff, doctor, maniac (all on the citizens' team), mafia, don.

## Ratings (fair comparison)

```
rating = (wins + K × average win rate) / (games + K)       K = 5 by default
```
A player with few games stays close to the average, and the more they play, the more their own results count.
Role ratings use the same formula with each role's own average. "± exp." = wins minus the wins you'd
expect from the roles a player got (mafia wins less often than citizens in our group).

## Roadmap

- [x] Local prototype
- [x] Cloudflare Worker + D1 database, spreadsheet imported (14 games, 26 players)
- [x] Game model matching the paper notes (nominations, night actions, doctor, maniac)
- [x] Telegram login (@mafia_bcn_bot, OpenID Connect), admin role
- [x] Admin: add/edit games, players, nicknames, private names and settings from the website
- [x] Linking players to Telegram accounts (admin pre-fills @username, or links a login by hand)
- [x] Personal "My stats" page
- [x] Public data cached in KV + browser copy with version check; throttling and rate limits
- [x] Weekly backups to KV (Sundays) with Telegram reports to admins
- [x] Bot page: posts to the group / subscribers with edit & delete, game summaries, /mystats
- [ ] Game sign-up polls, Mini App
