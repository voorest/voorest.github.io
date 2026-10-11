/* ============================================================
   STATISTICS — pure functions over the data (finished games only)
   ============================================================ */
'use strict';

const Stats = {
  compute(db) {
    const P = {};
    const blankRoles = () => ({ citizen: { g: 0, w: 0 }, sheriff: { g: 0, w: 0 }, mafia: { g: 0, w: 0 }, don: { g: 0, w: 0 } });
    const ensure = id => (P[id] ||= {
      id, name: Store.playerName(id), games: 0, wins: 0, dates: new Set(), byRole: blankRoles(),
      survived: 0, killed: 0, voted: 0, removed: 0, firstKilled: 0, fouls: 0,
      votesTown: 0, votesTownOnMafia: 0,
      sheriffChecks: 0, sheriffBlack: 0, donChecks: 0, donFoundSheriff: 0,
      history: [],
    });

    const finished = db.games.filter(g => g.winner);
    const dates = new Set();
    let townWins = 0, mafiaWins = 0;

    for (const g of finished) {
      dates.add(g.date);
      if (g.winner === 'town') townWins++; else mafiaWins++;
      const tl = GameLogic.timeline(g);
      const bySeat = Object.fromEntries(g.seats.map(s => [s.seat, s]));
      const teamOf = n => (bySeat[n] && bySeat[n].role ? ROLES[bySeat[n].role].team : null);

      for (const s of g.seats) {
        if (!s.playerId || !s.role) continue;
        const p = ensure(s.playerId);
        const won = ROLES[s.role].team === g.winner;
        const fate = tl.fates[s.seat] || null;
        p.games++; if (won) p.wins++;
        p.dates.add(g.date);
        p.byRole[s.role].g++; if (won) p.byRole[s.role].w++;
        if (fate) p[fate.type]++; else p.survived++;
        p.fouls += +s.fouls || 0;
        p.history.push({ gameId: g.id, date: g.date, number: g.number, seat: s.seat, role: s.role, won, fate });
      }

      // First player shot at night
      const firstKill = Object.entries(tl.fates).filter(([, f]) => f.type === 'killed').sort((a, b) => a[1].round - b[1].round)[0];
      if (firstKill && bySeat[firstKill[0]] && bySeat[firstKill[0]].playerId && bySeat[firstKill[0]].role) ensure(bySeat[firstKill[0]].playerId).firstKilled++;

      const sheriff = g.seats.find(s => s.role === 'sheriff' && s.playerId);
      const don = g.seats.find(s => s.role === 'don' && s.playerId);

      g.rounds.forEach(r => {
        // Votes of town players: how often they voted for a mafia member
        Object.entries(r.day.votes || {}).forEach(([voter, target]) => {
          const vs = bySeat[voter];
          if (!vs || !vs.playerId || teamOf(voter) !== 'town' || !teamOf(target)) return;
          const p = ensure(vs.playerId);
          p.votesTown++;
          if (teamOf(target) === 'mafia') p.votesTownOnMafia++;
        });
        if (sheriff && r.night.sheriffCheck && teamOf(r.night.sheriffCheck)) {
          const p = ensure(sheriff.playerId);
          p.sheriffChecks++;
          if (teamOf(r.night.sheriffCheck) === 'mafia') p.sheriffBlack++;
        }
        if (don && r.night.donCheck && bySeat[r.night.donCheck]) {
          const p = ensure(don.playerId);
          p.donChecks++;
          if (bySeat[r.night.donCheck].role === 'sheriff') p.donFoundSheriff++;
        }
      });
    }

    const players = Object.values(P).map(p => ({
      ...p,
      winRate: p.games ? p.wins / p.games : 0,
      days: p.dates.size,
      lastPlayed: [...p.dates].sort().pop() || null,
      voteAcc: p.votesTown ? p.votesTownOnMafia / p.votesTown : null,
    }));

    return {
      players,
      totals: {
        games: finished.length,
        inProgress: db.games.length - finished.length,
        days: dates.size,
        townWins, mafiaWins,
        players: players.length,
      },
    };
  },

  roleRate(p, r) { return p.byRole[r].g ? p.byRole[r].w / p.byRole[r].g : 0; },

  /** Titles page. Win-rate titles need a minimum number of games (see Data → Settings). */
  titles(st, settings) {
    const minG = +settings.minGames || 3, minR = +settings.minRoleGames || 2;
    const P = st.players;
    const best = (list, score, tie) => {
      let top = null;
      for (const p of list) {
        if (!top || score(p) > score(top) || (score(p) === score(top) && tie(p) > tie(top))) top = p;
      }
      return top;
    };
    const T = [];
    const add = (icon, title, desc, p, detail, rule) => T.push({ icon, title, desc, player: p, detail: p ? detail(p) : '', rule });

    add('👑', 'King of the Game', 'Most wins overall',
      best(P.filter(p => p.wins > 0), p => p.wins, p => p.winRate),
      p => `${p.wins} wins in ${p.games} games`, 'most wins');
    add('🎭', 'Best Role Player', 'Highest win rate across all roles',
      best(P.filter(p => p.games >= minG), p => p.winRate, p => p.games),
      p => `${pct(p.winRate)} · ${p.wins}/${p.games}`, `min ${minG} games`);

    const roleIcons = { sheriff: '⭐', don: '🎩', mafia: '🕶️', citizen: '🏠' };
    ['sheriff', 'don', 'mafia', 'citizen'].forEach(r => {
      const label = ROLES[r].label;
      add(roleIcons[r], `Best ${label}`, `Highest win rate as ${label}`,
        best(P.filter(p => p.byRole[r].g >= minR && p.byRole[r].w > 0), p => this.roleRate(p, r), p => p.byRole[r].g),
        p => `${pct(this.roleRate(p, r))} · ${p.byRole[r].w}/${p.byRole[r].g}`, `min ${minR} games as ${label}`);
    });

    add('🎯', 'Sharpshooter', 'As town, votes for mafia most often',
      best(P.filter(p => p.votesTown >= 5), p => p.voteAcc, p => p.votesTown),
      p => `${pct(p.voteAcc)} of ${p.votesTown} votes`, 'min 5 votes as town');
    add('🛡️', 'Survivor', 'Most often alive at the end',
      best(P.filter(p => p.survived > 0), p => p.survived, p => p.survived / p.games),
      p => `${p.survived} of ${p.games} games`, 'most games survived');
    add('📅', 'Most Loyal', 'Most games played',
      best(P, p => p.games, p => p.days),
      p => `${p.games} games · ${p.days} days`, 'attendance');
    add('🌙', 'Night Target', 'Shot first by the mafia most often',
      best(P.filter(p => p.firstKilled > 0), p => p.firstKilled, p => -p.games),
      p => `${p.firstKilled}× first shot`, 'fun stat');
    return T;
  },
};
