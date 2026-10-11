# Mafia BCN — Game Log

A small website for recording our weekend Mafia games in Barcelona and building stats from them:
leaderboard, attendance, role stats and titles (King of the Game, Best Sheriff / Don / Mafia / Citizen, Best Role Player…).

## How to use it (today)

1. Double-click `index.html` and it opens in your browser. No install, no server.
2. **Players**: add everyone (name + optional Telegram @nick).
3. **Games → New game**: pick players for seats 1–10, set roles (or press 🎲 Random roles).
4. During the game, add rounds. Each round is **Day** (who voted for whom, who was voted out) then **Night** (mafia shot, Don check, Sheriff check).
5. At the end, set the winner. The **Dashboard** updates right away.
6. **Data → Download backup** after every game night. Save the file into the `data/` folder.

> ⚠️ For now, data lives in your browser's storage. If you clear browser data or switch browsers, restore from your latest backup.

## Project structure

```
index.html        page shell + navigation
css/style.css     all styling
js/data.js        data layer (storage, players, games) + game rules (who's alive, winner)
js/stats.js       statistics & titles (pure functions)
js/app.js         screens: dashboard, games, game editor, players, player page, data
js/demo.js        random demo data generator
data/             your JSON backups (ignored by git by default; see .gitignore)
```

## Data model (v1)

```jsonc
{
  "players": [{ "id": "…", "name": "Alex", "nick": "@alex" }],
  "games": [{
    "id": "…", "date": "2026-10-04", "number": 1, "winner": "town" | "mafia" | null,
    "seats":  [{ "seat": 1, "playerId": "…", "role": "citizen|sheriff|mafia|don", "fouls": 0 }],
    "rounds": [{
      "day":   { "votes": { "1": 3, "2": 3 }, "eliminated": [3], "removed": [] },
      "night": { "kill": 5, "donCheck": 2, "sheriffCheck": 6 }
    }],
    "notes": ""
  }],
  "settings": { "minGames": 3, "minRoleGames": 2, "defaultSeats": 10 }
}
```

## Publish on GitHub (and GitHub Pages)

```bash
cd D:\_projects\mafia_games
git init
git add .
git commit -m "First version of Mafia BCN game log"
git branch -M main
git remote add origin https://github.com/<your-user>/mafia-games.git
git push -u origin main
```
Then on GitHub, go to **Settings → Pages → Deploy from branch → main / root**, and the site is live at `https://<your-user>.github.io/mafia-games/`.

Note that GitHub Pages on a free account requires a **public** repository. Each visitor's browser has its own storage, so the public site starts empty. Shared data comes with the database step (Supabase) on the roadmap.

## Roadmap (draft)

- [x] v0: local-first site: record games, dashboard, titles, JSON/CSV export
- [ ] Analyse the existing XLS and import its history
- [ ] Agree on scoring rules (points, extra points, best move, etc.)
- [ ] Move data to Supabase (Postgres) with admin login; the public dashboard reads from it
- [ ] Personal player pages (login via Telegram)
- [ ] Telegram bot: announce games, sign-ups, post results
