/* Demo data generator — random but rule-consistent games so you can see the dashboard. */
'use strict';

function makeDemoData() {
  const uid = Store.uid;
  const names = ['Alex', 'Marta', 'Pau', 'Ivan', 'Olga', 'Jordi', 'Nadia', 'Sergio', 'Lena', 'Dmitry', 'Carla', 'Max', 'Yulia', 'Oriol', 'Kate', 'Andrei'];
  const now = new Date().toISOString();
  const players = names.map(n => ({ id: uid() + n, name: n, nick: '@' + n.toLowerCase(), createdAt: now }));
  const rnd = a => a[Math.floor(Math.random() * a.length)];
  const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // Last 6 weekends (Saturday, sometimes Sunday too)
  const today = new Date(); today.setHours(12, 0, 0, 0);
  const dates = [];
  for (let w = 0; w < 6; w++) {
    const sat = new Date(today); sat.setDate(today.getDate() - ((today.getDay() + 1) % 7) - 7 * w);
    dates.push(iso(sat));
    const sun = new Date(sat); sun.setDate(sat.getDate() + 1);
    if (Math.random() < 0.5 && sun <= today) dates.push(iso(sun));
  }

  const games = [];
  for (const date of dates.sort()) {
    const count = 2 + (Math.random() < 0.5 ? 1 : 0);
    for (let k = 1; k <= count; k++) {
      const seated = shuffle(players).slice(0, 10);
      const roles = shuffle(Object.entries(roleSetup(10)).flatMap(([r, c]) => Array(c).fill(r)));
      const seats = seated.map((p, i) => ({ seat: i + 1, playerId: p.id, role: roles[i], fouls: Math.random() < 0.15 ? 1 + Math.floor(Math.random() * 2) : 0 }));
      const team = n => ROLES[seats[n - 1].role].team;
      let alive = seats.map(s => s.seat);
      const rounds = [];
      let winner = null;
      const check = () => {
        const m = alive.filter(n => team(n) === 'mafia').length;
        if (m === 0) return 'town';
        if (m >= alive.length - m) return 'mafia';
        return null;
      };

      for (let r = 1; r <= 9 && !winner; r++) {
        const round = GameLogic.emptyRound();
        const mafiaAlive = alive.filter(n => team(n) === 'mafia');
        alive.forEach(v => {
          if (r === 1 && Math.random() < 0.4) return;
          let t;
          if (team(v) === 'town' && mafiaAlive.length && Math.random() < 0.62) t = rnd(mafiaAlive);
          else t = rnd(alive.filter(x => x !== v && (team(v) === 'mafia' ? team(x) === 'town' : true)));
          if (t) round.day.votes[v] = t;
        });
        const tally = {};
        Object.values(round.day.votes).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
        const top = Object.entries(tally).sort((a, b) => b[1] - a[1]);
        if (top.length && !(r === 1 && Math.random() < 0.5) && (top.length === 1 || top[0][1] > top[1][1])) {
          const out = +top[0][0];
          round.day.eliminated = [out];
          alive = alive.filter(x => x !== out);
        }
        winner = check();
        if (winner) { rounds.push(round); break; }

        const town = alive.filter(n => team(n) === 'town');
        if (Math.random() > 0.1) round.night.kill = rnd(town);
        if (alive.some(n => seats[n - 1].role === 'don')) round.night.donCheck = rnd(town);
        const sh = alive.find(n => seats[n - 1].role === 'sheriff');
        if (sh) round.night.sheriffCheck = rnd(alive.filter(x => x !== sh));
        if (round.night.kill) alive = alive.filter(x => x !== round.night.kill);
        rounds.push(round);
        winner = check();
      }
      games.push({ id: uid(), date, number: k, seats, rounds, winner: winner || 'town', notes: '', createdAt: now });
    }
  }
  return { schema: 1, demo: true, players, games, settings: { minGames: 3, minRoleGames: 2, defaultSeats: 10 } };
}
