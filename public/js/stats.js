/* ============================================================
   STATISTICS — pure functions over finished games.

   Fair ratings (so 2/2 doesn't beat 8/10):
   every win rate is "shrunk" towards the average with a Bayesian prior:

        rating = (wins + K × average) / (games + K)

   K = "confidence weight" (Data → Settings, default 5). A player with few
   games stays close to the average; the more games, the more their own
   results count. Role ratings use that role's own average win rate.
   ============================================================ */
'use strict';

const Stats = {
  adjusted(w, g, prior, K) { return (w + K * prior) / (g + K); },

  compute(db) {
    const K = +db.settings.priorWeight || 5;
    const P = {};
    const blankRoles = () => Object.fromEntries(ROLE_ORDER.map(r => [r, { g: 0, w: 0 }]));
    const ensure = id => (P[id] ||= {
      id, name: Store.playerName(id), number: (Store.player(id) || {}).number || 0, games: 0, wins: 0, dates: new Set(), byRole: blankRoles(),
      survived: 0, voted: 0, removed: 0, killed: 0, maniac: 0, died: 0, firstKilled: 0, fouls: 0,
      noms: 0, nomsOnMafia: 0, nomsAsTown: 0,
      sheriffChecks: 0, sheriffBlack: 0, donChecks: 0, donFoundSheriff: 0,
      doctorSaves: 0, maniacKills: 0, maniacKillsMafia: 0,
      expected: 0, history: [],
    });

    const finished = db.games.filter(g => g.winner);
    const dates = new Set();
    let townWins = 0, mafiaWins = 0;
    const roleTotals = blankRoles();

    // pass 1: role baselines (how often each role wins in our group)
    for (const g of finished) {
      for (const s of g.seats) {
        if (!s.playerId || !s.role) continue;
        roleTotals[s.role].g++;
        if (ROLES[s.role].team === g.winner) roleTotals[s.role].w++;
      }
    }
    const allSeats = ROLE_ORDER.reduce((a, r) => a + roleTotals[r].g, 0);
    const allWins = ROLE_ORDER.reduce((a, r) => a + roleTotals[r].w, 0);
    const overallRate = allSeats ? allWins / allSeats : 0.5;
    const baseline = Object.fromEntries(ROLE_ORDER.map(r => [r, roleTotals[r].g ? roleTotals[r].w / roleTotals[r].g : overallRate]));

    // pass 2: per player
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
        const alive = tl.alive.includes(s.seat);
        const fate = alive ? null : (tl.fates[s.seat] || { type: 'died', round: null });
        p.games++; if (won) p.wins++;
        p.expected += baseline[s.role];
        p.dates.add(g.date);
        p.byRole[s.role].g++; if (won) p.byRole[s.role].w++;
        if (alive) p.survived++; else p[fate.type]++;
        p.fouls += +s.fouls || 0;
        p.history.push({ gameId: g.id, date: g.date, number: g.number, seat: s.seat, role: s.role, won, fate });
      }

      // first night death (only for games with night notes)
      const firstNight = Object.entries(tl.fates).filter(([, f]) => (f.type === 'killed' || f.type === 'maniac') && f.round)
        .sort((a, b) => a[1].round - b[1].round)[0];
      if (firstNight && bySeat[firstNight[0]] && bySeat[firstNight[0]].playerId) ensure(bySeat[firstNight[0]].playerId).firstKilled++;

      const holder = role => g.seats.find(s => s.role === role && s.playerId);
      const sheriff = holder('sheriff'), don = holder('don'), doctor = holder('doctor'), maniac = holder('maniac');

      g.rounds.forEach((r, ri) => {
        (r.nominations || []).forEach(nm => {
          const by = bySeat[nm.by];
          if (!by || !by.playerId || !teamOf(nm.target)) return;
          const p = ensure(by.playerId);
          p.noms++;
          if (teamOf(nm.by) === 'town') { p.nomsAsTown++; if (teamOf(nm.target) === 'mafia') p.nomsOnMafia++; }
        });
        // night actions of a role that is already out are ignored (same rule as the timeline)
        const atNight = (tl.phases.find(ph => ph.round === ri + 1 && ph.phase === 'night') || { alive: [] }).alive;
        const raw = r.night || {};
        const n = Object.fromEntries(Object.entries(raw).map(([f, v]) => [f, GameLogic.canAct(g, f, atNight) ? v : null]));
        if (sheriff && n.sheriffCheck && teamOf(n.sheriffCheck)) {
          const p = ensure(sheriff.playerId); p.sheriffChecks++; if (teamOf(n.sheriffCheck) === 'mafia') p.sheriffBlack++;
        }
        if (don && n.donCheck && bySeat[n.donCheck]) {
          const p = ensure(don.playerId); p.donChecks++; if (bySeat[n.donCheck].role === 'sheriff') p.donFoundSheriff++;
        }
        if (doctor && n.doctorHeal && (n.doctorHeal === n.mafiaKill || n.doctorHeal === n.maniacKill)) ensure(doctor.playerId).doctorSaves++;
        if (maniac && n.maniacKill && n.maniacKill !== n.doctorHeal) {
          const p = ensure(maniac.playerId); p.maniacKills++; if (teamOf(n.maniacKill) === 'mafia') p.maniacKillsMafia++;
        }
      });
    }

    const players = Object.values(P).map(p => {
      const roleRating = Object.fromEntries(ROLE_ORDER.map(r => [r, this.adjusted(p.byRole[r].w, p.byRole[r].g, baseline[r], K)]));
      return {
        ...p,
        winRate: p.games ? p.wins / p.games : 0,
        rating: this.adjusted(p.wins, p.games, overallRate, K),
        aboveExpected: p.wins - p.expected,
        roleRating,
        days: p.dates.size,
        lastPlayed: [...p.dates].sort().pop() || null,
        nomAcc: p.nomsAsTown ? p.nomsOnMafia / p.nomsAsTown : null,
      };
    });

    return {
      players, baseline, roleTotals, overallRate, K,
      totals: { games: finished.length, inProgress: db.games.length - finished.length, days: dates.size, townWins, mafiaWins, players: players.length },
    };
  },

  roleRate(p, r) { return p.byRole[r].g ? p.byRole[r].w / p.byRole[r].g : 0; },

  titles(st, settings) {
    const minG = +settings.minGames || 3;
    const P = st.players;
    const best = (list, score, tie) => {
      let top = null;
      for (const p of list) if (!top || score(p) > score(top) || (score(p) === score(top) && tie(p) > tie(top))) top = p;
      return top;
    };
    const T = [];
    const add = (icon, title, desc, p, detail, rule) => T.push({ icon, title, desc, player: p, detail: p ? detail(p) : '', rule });

    add('👑', 'King of the Game', 'Best overall rating (win rate adjusted for number of games)',
      best(P.filter(p => p.games >= minG), p => p.rating, p => p.games),
      p => `rating ${pct(p.rating)} · ${p.wins}/${p.games} wins`, `min ${minG} games`);

    // Role player: good in many roles → average of (role rating − role average) over roles played
    add('🎭', 'Best Role Player', 'Above average in the most roles (3+ different roles)',
      best(P.filter(p => ROLE_ORDER.filter(r => p.byRole[r].g).length >= 3),
        p => { const rs = ROLE_ORDER.filter(r => p.byRole[r].g); return rs.reduce((a, r) => a + p.roleRating[r] - st.baseline[r], 0) / rs.length; },
        p => p.games),
      p => { const rs = ROLE_ORDER.filter(r => p.byRole[r].g); const v = rs.reduce((a, r) => a + p.roleRating[r] - st.baseline[r], 0) / rs.length; return `${v >= 0 ? '+' : ''}${Math.round(v * 100)} pts across ${rs.length} roles`; },
      'played 3+ roles');

    const icons = { sheriff: '⭐', don: '🎩', mafia: '🕶️', citizen: '🏠', doctor: '💊', maniac: '🔪' };
    ['sheriff', 'don', 'mafia', 'citizen', 'doctor', 'maniac'].forEach(r => {
      const label = ROLES[r].label;
      add(icons[r], `Best ${label}`, `Highest ${label} rating (role average ${pct(st.baseline[r])})`,
        best(P.filter(p => p.byRole[r].g > 0 && p.byRole[r].w > 0), p => p.roleRating[r], p => p.byRole[r].g),
        p => `rating ${pct(p.roleRating[r])} · ${p.byRole[r].w}/${p.byRole[r].g} wins`, `a win as ${label}`);
    });

    add('🎯', 'Sharp Eye', 'As a citizen, nominates mafia most often',
      best(P.filter(p => p.nomsAsTown >= 5), p => this.adjusted(p.nomsOnMafia, p.nomsAsTown, 0.3, st.K), p => p.nomsAsTown),
      p => `${pct(p.nomAcc)} of ${p.nomsAsTown} nominations`, 'min 5 nominations as citizen');
    add('🛡️', 'Survivor', 'Most often alive at the end',
      best(P.filter(p => p.survived > 0), p => p.survived, p => p.survived / p.games),
      p => `${p.survived} of ${p.games} games`, 'most games survived');
    add('📅', 'Most Loyal', 'Most games played',
      best(P, p => p.games, p => p.days), p => `${p.games} games · ${p.days} days`, 'attendance');
    add('🌙', 'Night Target', 'Shot first at night most often',
      best(P.filter(p => p.firstKilled > 0), p => p.firstKilled, p => -p.games),
      p => `${p.firstKilled}× first shot`, 'needs night notes');
    return T;
  },
};
