# Mafia BCN — Game Log

Games, stats and titles for our weekend Mafia games in Barcelona.

**Live site:** https://mafia-bcn.voorest.workers.dev (Cloudflare: website + API + D1 database)

## How it fits together

```
GitHub (this repo)  ──push to master──▶  Cloudflare Workers Builds  ──deploys──▶  mafia-bcn.voorest.workers.dev
                                                                                        │
                                                                     Cloudflare D1 database "mafia-bcn"
```

- `public/`: the website (plain HTML/CSS/JS, no build step)
- `src/worker.js`: the Cloudflare Worker. It serves `public/` and the API (`GET /api/data`)
- `migrations/`: database schema (SQL)
- `scripts/import_xls.py`: one-off import of the old spreadsheet
- `data/`: **private** files (spreadsheets, backups, generated SQL). They're ignored by git, so they never reach this public repo.
- `wrangler.jsonc`: Cloudflare config (Worker name, database binding)

The website has two modes:
- **Live** (on Cloudflare): reads from the database. Read-only until the admin login is added.
- **Local** (opening `public/index.html` directly, or on GitHub Pages): data stays in your browser. You can edit it, and it has a demo data button.

## Branches and deploys

- `master` = production. Every push to `master` deploys automatically.
- `dev` = work in progress. Do the work here, then merge into `master` when it's ready.

```bash
git checkout dev        # work here
git push origin dev     # does NOT deploy
git checkout master && git merge dev && git push   # deploys
```

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
- [ ] Telegram login (@mafia_bcn_bot), admin role
- [ ] Admin: add/edit games, players and nicknames from the website
- [ ] Linking players to Telegram accounts (admin sets it; optional "that's me" request)
- [ ] Personal "my stats" page
- [ ] Automatic JSON backups, announcements, notifications
