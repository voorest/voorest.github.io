/* Demo data generator — random but rule-consistent games (local mode only). */
'use strict';

function makeDemoData() {
  const uid = Store.uid;
  const names = ['Alex', 'Marta', 'Pau', 'Ivan', 'Olga', 'Jordi', 'Nadia', 'Sergio', 'Lena', 'Dmitry', 'Carla', 'Max', 'Yulia', 'Oriol', 'Kate', 'Andrei'];
  const now = new Date().toISOString();
  const players = names.map(n => ({ id: uid() + n, nickname: n, createdAt: now }));
  const rnd = a => a[Math.floor(Math.random() * a.length)];
  const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const today = new Date(); today.setHours(12, 0, 0, 0);
  const dates = [];
  for (let w = 0; w < 6; w++) {
    const sun = new Date(today); sun.setDate(today.getDate() - today.getDay() - 7 * w);
    dates.push(iso(sun));
  }

  const games = [];
  for (const date of dates.sort()) {
    const count = 2 + (Math.random() < 0.5 ? 1 : 0);
    for (let k = 1; k <= count; k++) {
      const n = 8 + Math.floor(Math.random() * 5);
      const seated = shuffle(players).slice(0, n);
      const roles = shuffle(Object.entries(roleSetup(n)).flatMap(([r, c]) => Array(c).fill(r)));
      const seats = seated.map((p, i) => ({ seat: i + 1, playerId: p.id, role: roles[i], alive: null, fouls: 0 }));
      const role = s => seats[s - 1].role;
      const team = s => ROLES[role(s)].team;
      let alive = seats.map(s => s.seat);
      const rounds = [];
      let winner = null;
      const check = () => {
        const m = alive.filter(s => team(s) === 'mafia').length;
        if (m === 0) return 'town';
        if (m >= alive.length - m) return 'mafia';
        return null;
      };
      for (let r = 1; r <= 9 && !winner; r++) {
        const round = GameLogic.emptyRound();
        // Night first
        const town = alive.filter(s => team(s) === 'town');
        const nt = round.night;
        nt.mafiaKill = Math.random() > 0.1 ? rnd(town) : null;
        if (alive.some(s => role(s) === 'don')) nt.donCheck = rnd(town);
        const sh = alive.find(s => role(s) === 'sheriff'); if (sh) nt.sheriffCheck = rnd(alive.filter(x => x !== sh));
        const doc = alive.find(s => role(s) === 'doctor'); if (doc) nt.doctorHeal = rnd(alive);
        const man = alive.find(s => role(s) === 'maniac'); if (man && Math.random() < 0.6) nt.maniacKill = rnd(alive.filter(x => x !== man));
        GameLogic.nightDeaths(nt).forEach(d => { alive = alive.filter(x => x !== d.seat); });
        winner = check();
        if (winner) { rounds.push(round); break; }
        // Then the day
        const mafiaAlive = alive.filter(s => team(s) === 'mafia');
        const nominators = shuffle(alive).slice(0, 2 + Math.floor(Math.random() * 3));
        nominators.forEach(by => {
          const target = team(by) === 'town' && Math.random() < 0.55 && mafiaAlive.length ? rnd(mafiaAlive) : rnd(alive.filter(x => x !== by));
          round.nominations.push({ by, target, votes: Math.floor(Math.random() * (alive.length / 2 + 1)) });
        });
        const top = [...round.nominations].sort((a, b) => b.votes - a.votes)[0];
        if (top && top.votes > 0) {
          round.eliminated = [top.target];
          alive = alive.filter(x => x !== top.target);
        }
        rounds.push(round);
        winner = check();
      }
      games.push({ id: uid(), date, number: k, seats, rounds, winner: winner || 'town', notes: '', source: 'app', createdAt: now });
    }
  }
  return { schema: 2, demo: true, players, games, settings: { ...DEFAULT_SETTINGS } };
}
