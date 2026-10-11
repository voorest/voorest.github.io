/* ============================================================
   UI — tiny hash router + views
   #/dashboard  #/games  #/game/:id  #/players  #/player/:id  #/data
   ============================================================ */
'use strict';

const $app = document.getElementById('app');
const $ = sel => $app.querySelector(sel);
const $$ = sel => [...$app.querySelectorAll(sel)];
const UI = { lbSort: { key: 'wins', dir: -1 } };

/* ---------- helpers ---------- */
const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T12:00:00');
  return isNaN(dt) ? d : dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
const roleChip = role => role ? `<span class="chip role-${role}">${ROLES[role].label}</span>` : '<span class="chip muted">no role</span>';
const winnerChip = w => w ? `<span class="chip team-${w}">${w === 'town' ? 'Town won' : 'Mafia won'}</span>` : '<span class="chip warn">In progress</span>';
function bar(value, max, cls = '') {
  const w = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return `<span class="bar ${cls}"><span style="width:${w.toFixed(1)}%"></span></span>`;
}
function fateText(f) {
  if (!f) return 'Survived';
  return { killed: `Shot · night ${f.round}`, voted: `Voted out · day ${f.round}`, removed: `Removed · day ${f.round}` }[f.type];
}
function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function loadDemo() {
  const db = Store.get();
  if ((db.players.length || db.games.length) && !confirm('Replace ALL current data with demo data?')) return;
  Store.replace(makeDemoData());
  toast('Demo data loaded');
  route();
}

/* ---------- router ---------- */
function route() {
  const parts = (location.hash || '#/dashboard').replace(/^#\/?/, '').split('/');
  const view = parts[0] || 'dashboard', id = parts[1];
  const navKey = { game: 'games', player: 'players' }[view] || view;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === navKey));
  document.getElementById('banner').innerHTML = Store.get().demo
    ? `<div class="demo-banner">You are looking at <b>demo data</b>. Go to <a href="#/data">Data</a> and press “Clear all data” before recording real games.</div>` : '';
  const views = {
    dashboard: viewDashboard, games: viewGames, game: () => viewGame(id),
    players: viewPlayers, player: () => viewPlayer(id), data: viewData,
  };
  (views[view] || viewDashboard)();
}
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

/* ============================================================
   DASHBOARD
   ============================================================ */
const LB_COLS = [
  { key: 'name', label: 'Player', get: p => p.name.toLowerCase() },
  { key: 'games', label: 'Games', get: p => p.games },
  { key: 'wins', label: 'Wins', get: p => p.wins },
  { key: 'winRate', label: 'Win %', get: p => p.winRate },
  { key: 'days', label: 'Days', get: p => p.days },
  ...ROLE_ORDER.map(r => ({ key: r, label: ROLES[r].label, get: p => Stats.roleRate(p, r) + p.byRole[r].g / 1000, role: r })),
  { key: 'survived', label: 'Survived', get: p => p.survived },
  { key: 'voteAcc', label: 'Vote acc.', get: p => p.voteAcc ?? -1, title: 'As town: share of votes cast on mafia players' },
];

function viewDashboard() {
  const db = Store.get();
  const st = Stats.compute(db);
  const T = st.totals;

  if (!T.games) {
    $app.innerHTML = `
      <section class="hero">
        <h1>Your Mafia game log</h1>
        <p>No finished games yet. Add players, record a game, mark the winner — and leaderboards, role stats and titles will appear here.</p>
        <div class="row gap wrap">
          <a class="btn primary" href="#/games">Record a game</a>
          <a class="btn" href="#/players">Add players</a>
          <button class="btn ghost" id="demoBtn">Load demo data</button>
        </div>
        ${T.inProgress ? `<p class="muted">${T.inProgress} game(s) in progress — set a winner to include them in stats.</p>` : ''}
      </section>`;
    $('#demoBtn').onclick = loadDemo;
    return;
  }

  const titles = Stats.titles(st, db.settings);
  const { key, dir } = UI.lbSort;
  const col = LB_COLS.find(c => c.key === key) || LB_COLS[2];
  const sorted = [...st.players].sort((a, b) => {
    const va = col.get(a), vb = col.get(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return b.wins - a.wins || b.winRate - a.winRate;
  });
  const maxGames = Math.max(...st.players.map(p => p.games));
  const minR = +db.settings.minRoleGames || 2;
  const recent = Store.sortedGames().filter(g => g.winner).slice(0, 6);

  $app.innerHTML = `
    <div class="page-head"><h1>Dashboard</h1><a class="btn primary" href="#/games">+ Record a game</a></div>

    <section class="kpis">
      <div class="kpi"><span class="kpi-val">${T.games}</span><span class="kpi-lbl">Games played</span></div>
      <div class="kpi"><span class="kpi-val">${T.days}</span><span class="kpi-lbl">Game days</span></div>
      <div class="kpi"><span class="kpi-val">${T.players}</span><span class="kpi-lbl">Players</span></div>
      <div class="kpi"><span class="kpi-val town-text">${pct(T.townWins / T.games)}</span><span class="kpi-lbl">Town wins (${T.townWins})</span></div>
      <div class="kpi"><span class="kpi-val mafia-text">${pct(T.mafiaWins / T.games)}</span><span class="kpi-lbl">Mafia wins (${T.mafiaWins})</span></div>
    </section>
    <div class="split" title="Town vs Mafia wins">
      <span class="split-town" style="flex:${T.townWins}">${T.townWins ? 'Town ' + T.townWins : ''}</span>
      <span class="split-mafia" style="flex:${T.mafiaWins}">${T.mafiaWins ? 'Mafia ' + T.mafiaWins : ''}</span>
    </div>

    <h2 class="section-title">Titles</h2>
    <section class="titles">
      ${titles.map(t => `
        <div class="title-card ${t.player ? '' : 'empty-title'}">
          <div class="title-icon">${t.icon}</div>
          <div class="title-body">
            <div class="title-name">${h(t.title)}</div>
            ${t.player
              ? `<a class="title-holder" href="#/player/${t.player.id}">${h(t.player.name)}</a><div class="title-detail">${h(t.detail)}</div>`
              : `<div class="title-detail">Nobody yet (${h(t.rule)})</div>`}
            <div class="title-desc">${h(t.desc)}</div>
          </div>
        </div>`).join('')}
    </section>

    <h2 class="section-title">Leaderboard</h2>
    <section class="card">
      <div class="table-wrap">
        <table class="lb">
          <thead><tr><th>#</th>${LB_COLS.map(c => `<th data-sort="${c.key}" class="sortable ${c.key === key ? 'sorted' : ''}" ${c.title ? `title="${h(c.title)}"` : ''}>${c.label}${c.key === key ? (dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('')}</tr></thead>
          <tbody>
            ${sorted.map((p, i) => `
              <tr>
                <td class="muted">${i + 1}</td>
                <td><a href="#/player/${p.id}">${h(p.name)}</a></td>
                <td>${p.games}</td>
                <td><b>${p.wins}</b></td>
                <td class="wr">${pct(p.winRate)} ${bar(p.winRate, 1)}</td>
                <td>${p.days}</td>
                ${ROLE_ORDER.map(r => `<td class="rolecell">${p.byRole[r].g ? `${p.byRole[r].w}/${p.byRole[r].g}` : '<span class="muted">–</span>'}</td>`).join('')}
                <td>${p.survived}</td>
                <td>${pct(p.voteAcc)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="muted small">Role columns show wins/games in that role. Click a column header to sort.</p>
    </section>

    <div class="grid-2">
      <section class="card">
        <h2>Role leaders</h2>
        <p class="muted small">Win rate in each role (min ${minR} games in that role).</p>
        <div class="role-leaders">
          ${ROLE_ORDER.map(r => {
            const list = st.players.filter(p => p.byRole[r].g >= minR)
              .sort((a, b) => Stats.roleRate(b, r) - Stats.roleRate(a, r) || b.byRole[r].g - a.byRole[r].g).slice(0, 5);
            return `<div class="role-block">
              <h4>${roleChip(r)}</h4>
              ${list.length ? list.map(p => `
                <div class="bar-row"><a href="#/player/${p.id}">${h(p.name)}</a>${bar(Stats.roleRate(p, r), 1, 'role-' + r)}<span class="num">${pct(Stats.roleRate(p, r))} <span class="muted">${p.byRole[r].w}/${p.byRole[r].g}</span></span></div>`).join('')
                : '<p class="muted small">Not enough games yet.</p>'}
            </div>`;
          }).join('')}
        </div>
      </section>

      <section class="card">
        <h2>Attendance</h2>
        <p class="muted small">Games played (and number of game days).</p>
        ${[...st.players].sort((a, b) => b.games - a.games || b.days - a.days).slice(0, 20).map(p => `
          <div class="bar-row"><a href="#/player/${p.id}">${h(p.name)}</a>${bar(p.games, maxGames, 'accent')}<span class="num">${p.games} <span class="muted">· ${p.days}d</span></span></div>`).join('')}
      </section>
    </div>

    <h2 class="section-title">Recent games</h2>
    <section class="card game-list">${recent.map(gameRow).join('')}</section>
  `;

  $$('th[data-sort]').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    UI.lbSort = { key: k, dir: UI.lbSort.key === k ? -UI.lbSort.dir : (k === 'name' ? 1 : -1) };
    viewDashboard();
  });
}

function gameRow(g) {
  const filled = g.seats.filter(s => s.playerId).length;
  return `<a class="game-row" href="#/game/${g.id}">
    <span class="gnum">#${g.number}</span>
    <span class="gdate">${fmtDate(g.date)}</span>
    <span class="muted">${filled} players · ${g.rounds.length} round${g.rounds.length === 1 ? '' : 's'}</span>
    <span class="spacer"></span>
    ${winnerChip(g.winner)}
  </a>`;
}

/* ============================================================
   GAMES LIST
   ============================================================ */
function viewGames() {
  const games = Store.sortedGames();
  const groups = {};
  games.forEach(g => (groups[g.date] ||= []).push(g));

  $app.innerHTML = `
    <div class="page-head">
      <h1>Games</h1>
      <div class="row gap wrap">
        <input type="date" id="newDate" value="${localToday()}">
        <button class="btn primary" id="newGame">+ New game</button>
      </div>
    </div>
    ${games.length ? Object.entries(groups).map(([date, list]) => `
      <section class="card">
        <h3>${fmtDate(date)} <span class="muted">· ${list.length} game${list.length > 1 ? 's' : ''}</span></h3>
        <div class="game-list">${list.sort((a, b) => a.number - b.number).map(gameRow).join('')}</div>
      </section>`).join('')
      : `<div class="empty">No games yet. Pick a date and press <b>New game</b>.</div>`}
  `;
  $('#newGame').onclick = () => {
    const g = Store.newGame($('#newDate').value || localToday());
    location.hash = '#/game/' + g.id;
  };
}

/* ============================================================
   GAME EDITOR (used live during the game — every change is saved)
   ============================================================ */
function viewGame(id) {
  const g = Store.game(id);
  if (!g) { $app.innerHTML = `<div class="empty">Game not found. <a href="#/games">Back to games</a></div>`; return; }
  const db = Store.get();
  const tl = GameLogic.timeline(g);
  const seatBy = n => g.seats.find(s => s.seat === +n);
  const name = n => { const s = seatBy(n); return s && s.playerId ? Store.playerName(s.playerId) : '—'; };
  const lbl = n => `${n}. ${name(n)}`;
  const seatOpts = (list, selected, emptyLabel) =>
    `<option value="">${emptyLabel}</option>` + list.map(n => `<option value="${n}" ${+selected === n ? 'selected' : ''}>${h(lbl(n))}</option>`).join('');
  const players = [...db.players].sort((a, b) => a.name.localeCompare(b.name));
  const used = {};
  g.seats.forEach(s => { if (s.playerId) used[s.playerId] = (used[s.playerId] || 0) + 1; });
  const need = roleSetup(g.seats.length), have = GameLogic.roleCounts(g);
  const warnings = GameLogic.validate(g);
  const suggested = GameLogic.suggestWinner(g);

  const seatRows = g.seats.map(s => {
    const f = tl.fates[s.seat];
    return `<tr class="${f ? 'dead' : ''}">
      <td class="seatno">${s.seat}</td>
      <td><select data-act="seat-player" data-seat="${s.seat}" class="${s.playerId && used[s.playerId] > 1 ? 'bad' : ''}">
        <option value="">— pick player —</option>
        ${players.map(p => `<option value="${p.id}" ${p.id === s.playerId ? 'selected' : ''}>${h(p.name)}${used[p.id] && p.id !== s.playerId ? ' (seated)' : ''}</option>`).join('')}
      </select></td>
      <td><select data-act="seat-role" data-seat="${s.seat}" class="role-select ${s.role ? 'role-' + s.role : ''}">
        <option value="">—</option>
        ${ROLE_ORDER.map(r => `<option value="${r}" ${s.role === r ? 'selected' : ''}>${ROLES[r].label}</option>`).join('')}
      </select></td>
      <td><input type="number" min="0" max="4" value="${s.fouls || 0}" data-act="seat-fouls" data-seat="${s.seat}" class="fouls ${s.fouls >= 3 ? 'warnf' : ''}"></td>
      <td class="fate">${f ? fateText(f) : '<span class="alive">alive</span>'}</td>
    </tr>`;
  }).join('');

  const checkResult = (seat, kind) => {
    if (!seat) return '';
    const s = seatBy(seat);
    if (!s || !s.role) return '<span class="muted small">role not set</span>';
    if (kind === 'sheriff') return ROLES[s.role].team === 'mafia' ? '<span class="chip team-mafia">Black</span>' : '<span class="chip team-town">Red</span>';
    return s.role === 'sheriff' ? '<span class="chip role-sheriff">Sheriff found!</span>' : '<span class="chip muted">Not the sheriff</span>';
  };

  const roundsHtml = g.rounds.map((r, i) => {
    const n = i + 1;
    const dayAlive = [...tl.phases.find(p => p.round === n && p.phase === 'day').alive].sort((a, b) => a - b);
    const nightAlive = [...tl.phases.find(p => p.round === n && p.phase === 'night').alive].sort((a, b) => a - b);
    const votes = r.day.votes || {};
    const tally = {};
    Object.entries(votes).forEach(([v, t]) => { if (dayAlive.includes(+v)) tally[t] = (tally[t] || 0) + 1; });
    const picks = (field, list) => list.map(s => {
      const on = (r.day[field] || []).includes(s);
      return `<label class="pick ${on ? 'on' : ''}"><input type="checkbox" data-act="day-${field}" data-round="${i}" data-seat="${s}" ${on ? 'checked' : ''}>${h(lbl(s))}</label>`;
    }).join('');
    const nightSel = (field, label, kind) => `
      <label class="field"><span>${label}</span>
        <select data-act="night" data-field="${field}" data-round="${i}">${seatOpts(nightAlive, r.night[field], field === 'kill' ? 'miss / no shot' : '—')}</select>
        ${kind ? checkResult(r.night[field], kind) : ''}
      </label>`;
    return `
      <div class="card round" id="round-${n}">
        <div class="round-head">
          <h3>Round ${n}</h3>
          ${i === g.rounds.length - 1 ? `<button class="btn small ghost" data-act="del-round" data-round="${i}">Remove round</button>` : ''}
        </div>
        <div class="phase day">
          <h4>☀ Day ${n} — votes</h4>
          <div class="votes">
            ${dayAlive.map(v => `<div class="vote-row"><span class="voter">${h(lbl(v))}</span><span class="arrow">→</span>
              <select data-act="vote" data-round="${i}" data-voter="${v}">${seatOpts(dayAlive.filter(x => x !== v), votes[v], 'no vote')}</select></div>`).join('')}
          </div>
          <div class="tally">${Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([t, c]) => `<span class="chip">${h(lbl(t))}: <b>${c}</b></span>`).join(' ') || '<span class="muted small">No votes recorded</span>'}</div>
          <div class="picks"><span class="lbl">Voted out:</span>${picks('eliminated', dayAlive)}</div>
          <details ${(r.day.removed || []).length ? 'open' : ''}><summary>Removed for fouls</summary><div class="picks">${picks('removed', dayAlive)}</div></details>
        </div>
        <div class="phase night">
          <h4>☾ Night ${n}</h4>
          <div class="night-grid">
            ${nightSel('kill', 'Mafia shot')}
            ${nightSel('donCheck', 'Don checked', 'don')}
            ${nightSel('sheriffCheck', 'Sheriff checked', 'sheriff')}
          </div>
        </div>
      </div>`;
  }).join('');

  $app.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/games" class="back">← Games</a>
        <h1>Game #${g.number} <span class="muted">· ${fmtDate(g.date)}</span></h1>
      </div>
      <div class="row gap wrap">
        <label class="field inline"><span>Date</span><input type="date" data-act="date" value="${g.date}"></label>
        <label class="field inline"><span>Game #</span><input type="number" min="1" data-act="number" value="${g.number}" class="num-input"></label>
        <button class="btn danger" data-act="del-game">Delete</button>
      </div>
    </div>

    <section class="card">
      <div class="section-head">
        <h2>Seats & roles</h2>
        <div class="row gap wrap">
          <label class="field inline"><span>Seats</span><select data-act="seat-count">${[6, 7, 8, 9, 10, 11, 12].map(n => `<option ${n === g.seats.length ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <button class="btn small" data-act="random-roles">🎲 Random roles</button>
          <button class="btn small ghost" data-act="clear-roles">Clear roles</button>
        </div>
      </div>
      <div class="row gap quick-add">
        <input id="qaName" placeholder="New player name → goes to the first empty seat">
        <button class="btn small" data-act="quick-add">+ Add player</button>
      </div>
      <div class="role-count">${ROLE_ORDER.map(r => `<span class="chip role-${r} ${have[r] !== need[r] ? 'mismatch' : ''}">${ROLES[r].label} ${have[r]}/${need[r]}</span>`).join('')}</div>
      ${warnings.length ? `<ul class="warnings">${warnings.map(w => `<li>${h(w)}</li>`).join('')}</ul>` : ''}
      <div class="table-wrap">
        <table class="seats">
          <thead><tr><th>#</th><th>Player</th><th>Role</th><th>Fouls</th><th>Status</th></tr></thead>
          <tbody>${seatRows}</tbody>
        </table>
      </div>
    </section>

    <div class="section-head"><h2>Rounds</h2><span class="muted small">Each round = Day (votes) → Night (shot & checks). Everything saves automatically.</span></div>
    ${roundsHtml}
    <button class="btn primary add-round" data-act="add-round">+ Add round ${g.rounds.length + 1}</button>

    <section class="card result">
      <h2>Result</h2>
      <div class="alive-list"><span class="lbl">Alive at the end:</span>
        ${tl.alive.map(n => { const s = seatBy(n); return `<span class="alive-chip">${h(lbl(n))} ${s.role ? roleChip(s.role) : ''}</span>`; }).join('') || '<span class="muted">nobody</span>'}
      </div>
      ${suggested && suggested !== g.winner ? `<p class="hint">By the rules it looks like <b>${suggested === 'town' ? 'Town' : 'Mafia'}</b> won. <button class="btn small" data-act="winner" data-val="${suggested}">Set ${suggested === 'town' ? 'Town' : 'Mafia'} as winner</button></p>` : ''}
      <div class="seg">
        <button class="seg-town ${g.winner === 'town' ? 'on' : ''}" data-act="winner" data-val="town">Town (red) won</button>
        <button class="seg-mafia ${g.winner === 'mafia' ? 'on' : ''}" data-act="winner" data-val="mafia">Mafia (black) won</button>
        <button class="${!g.winner ? 'on' : ''}" data-act="winner" data-val="">Not finished</button>
      </div>
      <label class="field block"><span>Notes</span><textarea data-act="notes" rows="3" placeholder="Anything worth remembering about this game">${h(g.notes)}</textarea></label>
    </section>
  `;

  const commit = () => { Store.save(); viewGame(id); };

  function handle(act, el) {
    const seat = +el.dataset.seat, ri = +el.dataset.round;
    const s = seat ? g.seats.find(x => x.seat === seat) : null;
    switch (act) {
      case 'seat-player': s.playerId = el.value || null; break;
      case 'seat-role': s.role = el.value || null; break;
      case 'seat-fouls': s.fouls = Math.max(0, Math.min(4, +el.value || 0)); if (s.fouls >= 4) toast('4 fouls — mark the player as removed in the current round'); break;
      case 'vote': {
        const v = g.rounds[ri].day.votes;
        if (el.value) v[el.dataset.voter] = +el.value; else delete v[el.dataset.voter];
        break;
      }
      case 'day-eliminated':
      case 'day-removed': {
        const field = act.slice(4);
        const arr = (g.rounds[ri].day[field] ||= []);
        const at = arr.indexOf(seat);
        if (el.checked && at < 0) arr.push(seat);
        if (!el.checked && at >= 0) arr.splice(at, 1);
        break;
      }
      case 'night': g.rounds[ri].night[el.dataset.field] = el.value ? +el.value : null; break;
      case 'add-round': {
        g.rounds.push(GameLogic.emptyRound());
        commit();
        const el2 = document.getElementById('round-' + g.rounds.length);
        if (el2) el2.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      case 'del-round':
        if (!confirm(`Remove round ${ri + 1} and everything recorded in it?`)) return;
        g.rounds.splice(ri, 1);
        break;
      case 'random-roles': {
        if (g.seats.some(x => x.role) && !confirm('Overwrite the current roles with a random distribution?')) return;
        const pool = Object.entries(roleSetup(g.seats.length)).flatMap(([r, c]) => Array(c).fill(r));
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        g.seats.forEach((x, i) => { x.role = pool[i]; });
        break;
      }
      case 'clear-roles':
        if (!confirm('Clear all roles?')) return;
        g.seats.forEach(x => { x.role = null; });
        break;
      case 'seat-count': {
        const n = +el.value;
        if (n < g.seats.length && g.seats.slice(n).some(x => x.playerId) && !confirm(`Remove seats ${n + 1}–${g.seats.length}?`)) { viewGame(id); return; }
        if (n < g.seats.length) g.seats = g.seats.slice(0, n);
        while (g.seats.length < n) g.seats.push({ seat: g.seats.length + 1, playerId: null, role: null, fouls: 0 });
        break;
      }
      case 'quick-add': {
        const inp = $('#qaName');
        const p = Store.addPlayer(inp.value);
        if (!p) { toast('Type a name first'); return; }
        const free = g.seats.find(x => !x.playerId);
        if (free && !g.seats.some(x => x.playerId === p.id)) { free.playerId = p.id; toast(`${p.name} → seat ${free.seat}`); }
        else toast(`${p.name} added to roster`);
        break;
      }
      case 'winner': g.winner = el.dataset.val || null; if (g.winner) toast('Result saved'); break;
      case 'notes': g.notes = el.value; Store.save(); toast('Notes saved'); return;
      case 'date': if (el.value) g.date = el.value; break;
      case 'number': g.number = Math.max(1, +el.value || 1); break;
      case 'del-game':
        if (!confirm('Delete this game permanently?')) return;
        Store.deleteGame(id);
        location.hash = '#/games';
        return;
    }
    commit();
  }

  $$('[data-act]').forEach(el => {
    const evt = el.tagName === 'BUTTON' ? 'click' : 'change';
    el.addEventListener(evt, () => handle(el.dataset.act, el));
  });
  $('#qaName').addEventListener('keydown', e => { if (e.key === 'Enter') handle('quick-add', e.target); });
}

/* ============================================================
   PLAYERS
   ============================================================ */
function viewPlayers() {
  const db = Store.get();
  const st = Stats.compute(db);
  const byId = Object.fromEntries(st.players.map(p => [p.id, p]));
  const list = [...db.players].sort((a, b) => a.name.localeCompare(b.name));

  $app.innerHTML = `
    <div class="page-head"><h1>Players <span class="muted">· ${list.length}</span></h1></div>
    <section class="card">
      <form id="addForm" class="row gap wrap">
        <input name="name" placeholder="Name" required>
        <input name="nick" placeholder="Telegram @nick (optional)">
        <button class="btn primary">+ Add player</button>
      </form>
    </section>
    <section class="card">
      <input id="filter" class="filter" placeholder="Search players…">
      <div class="table-wrap">
        <table class="players">
          <thead><tr><th>Name</th><th>Telegram</th><th>Games</th><th>Win %</th><th>Last played</th><th></th></tr></thead>
          <tbody>
            ${list.map(p => { const s = byId[p.id]; return `
              <tr data-name="${h((p.name + ' ' + (p.nick || '')).toLowerCase())}">
                <td><a href="#/player/${p.id}">${h(p.name)}</a></td>
                <td class="muted">${h(p.nick || '')}</td>
                <td>${s ? s.games : 0}</td>
                <td>${s ? pct(s.winRate) : '—'}</td>
                <td>${s && s.lastPlayed ? fmtDate(s.lastPlayed) : '—'}</td>
                <td class="actions"><button class="btn small ghost" data-edit="${p.id}">Edit</button><button class="btn small ghost danger-text" data-del="${p.id}">Delete</button></td>
              </tr>`; }).join('') || '<tr><td colspan="6" class="muted">No players yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
  `;

  $('#addForm').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    const p = Store.addPlayer(f.name.value, f.nick.value);
    if (p) { toast(`${p.name} added`); viewPlayers(); $('#addForm input[name=name]').focus(); }
  };
  $('#filter').oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    $$('tbody tr[data-name]').forEach(tr => { tr.style.display = tr.dataset.name.includes(q) ? '' : 'none'; });
  };
  $$('[data-edit]').forEach(b => b.onclick = () => editPlayer(b.dataset.edit, viewPlayers));
  $$('[data-del]').forEach(b => b.onclick = () => {
    const p = Store.player(b.dataset.del);
    if (Store.playerInUse(p.id)) { toast(`${p.name} has played games — can't delete (rename instead)`); return; }
    if (confirm(`Delete ${p.name}?`)) { Store.deletePlayer(p.id); viewPlayers(); }
  });
}

function editPlayer(id, after) {
  const p = Store.player(id);
  const name = prompt('Player name', p.name);
  if (name === null) return;
  const nick = prompt('Telegram @nick', p.nick || '');
  Store.updatePlayer(id, { name: name.trim() || p.name, nick: (nick ?? p.nick ?? '').trim() });
  after();
}

/* ---------- player profile (future "my stats" page) ---------- */
function viewPlayer(id) {
  const p0 = Store.player(id);
  if (!p0) { $app.innerHTML = `<div class="empty">Player not found. <a href="#/players">Back</a></div>`; return; }
  const st = Stats.compute(Store.get());
  const p = st.players.find(x => x.id === id);
  const rank = [...st.players].sort((a, b) => b.wins - a.wins || b.winRate - a.winRate).findIndex(x => x.id === id) + 1;

  const head = `
    <div class="page-head">
      <div><a href="#/players" class="back">← Players</a>
      <h1>${h(p0.name)} ${p0.nick ? `<span class="muted">${h(p0.nick)}</span>` : ''}</h1></div>
      <button class="btn ghost" id="editBtn">Edit</button>
    </div>`;

  if (!p) {
    $app.innerHTML = head + `<div class="empty">No finished games yet for ${h(p0.name)}.</div>`;
    $('#editBtn').onclick = () => editPlayer(id, () => viewPlayer(id));
    return;
  }

  $app.innerHTML = head + `
    <section class="kpis">
      <div class="kpi"><span class="kpi-val">#${rank}</span><span class="kpi-lbl">Rank (by wins)</span></div>
      <div class="kpi"><span class="kpi-val">${p.games}</span><span class="kpi-lbl">Games</span></div>
      <div class="kpi"><span class="kpi-val">${p.wins}</span><span class="kpi-lbl">Wins</span></div>
      <div class="kpi"><span class="kpi-val">${pct(p.winRate)}</span><span class="kpi-lbl">Win rate</span></div>
      <div class="kpi"><span class="kpi-val">${p.days}</span><span class="kpi-lbl">Game days</span></div>
    </section>

    <div class="grid-2">
      <section class="card">
        <h2>By role</h2>
        ${ROLE_ORDER.map(r => `
          <div class="bar-row">${roleChip(r)}${bar(Stats.roleRate(p, r), 1, 'role-' + r)}<span class="num">${p.byRole[r].g ? pct(Stats.roleRate(p, r)) : '—'} <span class="muted">${p.byRole[r].w}/${p.byRole[r].g}</span></span></div>`).join('')}
      </section>
      <section class="card">
        <h2>How the games went</h2>
        <dl class="facts">
          <dt>Survived to the end</dt><dd>${p.survived} (${pct(p.survived / p.games)})</dd>
          <dt>Shot at night</dt><dd>${p.killed}</dd>
          <dt>Shot first</dt><dd>${p.firstKilled}</dd>
          <dt>Voted out</dt><dd>${p.voted}</dd>
          <dt>Removed for fouls</dt><dd>${p.removed}</dd>
          <dt>Total fouls</dt><dd>${p.fouls}</dd>
          <dt>Votes on mafia (as town)</dt><dd>${p.votesTown ? `${p.votesTownOnMafia}/${p.votesTown} (${pct(p.voteAcc)})` : '—'}</dd>
          <dt>Sheriff checks found black</dt><dd>${p.sheriffChecks ? `${p.sheriffBlack}/${p.sheriffChecks}` : '—'}</dd>
          <dt>Don found the sheriff</dt><dd>${p.donChecks ? `${p.donFoundSheriff}/${p.donChecks} checks` : '—'}</dd>
        </dl>
      </section>
    </div>

    <section class="card">
      <h2>Game history</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Game</th><th>Seat</th><th>Role</th><th>Result</th><th>Fate</th></tr></thead>
          <tbody>
            ${[...p.history].sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number).map(x => `
              <tr>
                <td>${fmtDate(x.date)}</td>
                <td><a href="#/game/${x.gameId}">#${x.number}</a></td>
                <td>${x.seat}</td>
                <td>${roleChip(x.role)}</td>
                <td>${x.won ? '<span class="chip win">Win</span>' : '<span class="chip loss">Loss</span>'}</td>
                <td class="muted">${fateText(x.fate)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
  $('#editBtn').onclick = () => editPlayer(id, () => viewPlayer(id));
}

/* ============================================================
   DATA: backup / import / CSV / settings
   ============================================================ */
function toCSV(db, sep) {
  const cols = ['date', 'game_no', 'game_id', 'seat', 'player', 'telegram', 'role', 'team', 'winner', 'won', 'fate', 'fate_round', 'fouls'];
  const esc = v => { v = String(v ?? ''); return /["\n\r;,]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const rows = [cols.join(sep)];
  [...db.games].sort((a, b) => a.date.localeCompare(b.date) || a.number - b.number).forEach(g => {
    const tl = GameLogic.timeline(g);
    g.seats.forEach(s => {
      const p = Store.player(s.playerId) || {};
      const f = tl.fates[s.seat];
      const team = s.role ? ROLES[s.role].team : '';
      rows.push([g.date, g.number, g.id, s.seat, p.name || '', p.nick || '', s.role || '', team, g.winner || '',
        g.winner && team ? (team === g.winner ? 1 : 0) : '', f ? f.type : (g.winner ? 'survived' : ''), f ? f.round : '', s.fouls || 0].map(esc).join(sep));
    });
  });
  return '﻿' + rows.join('\r\n');
}

function viewData() {
  const db = Store.get();
  const s = db.settings;
  $app.innerHTML = `
    <div class="page-head"><h1>Data</h1></div>
    <div class="callout">Your data is stored <b>in this browser only</b>. Clearing browser data or switching browser/computer means it's gone — so <b>download a backup after every game night</b> and keep it in your <code>mafia_games/data</code> folder.</div>
    <div class="grid-2">
      <section class="card">
        <h2>Backup</h2>
        <p class="muted small">${db.players.length} players · ${db.games.length} games · last saved ${db.updatedAt ? new Date(db.updatedAt).toLocaleString('en-GB') : 'never'}</p>
        <div class="row gap wrap">
          <button class="btn primary" id="exportJson">⬇ Download backup (JSON)</button>
          <label class="btn">⬆ Restore from backup<input type="file" id="importJson" accept=".json,application/json" hidden></label>
        </div>
      </section>
      <section class="card">
        <h2>Export for Excel</h2>
        <p class="muted small">One row per player per game — easy to pivot in Excel.</p>
        <div class="row gap wrap">
          <button class="btn" id="csvSemi">CSV for Excel (EU, “;”)</button>
          <button class="btn ghost" id="csvComma">CSV (“,”)</button>
        </div>
      </section>
      <section class="card">
        <h2>Settings</h2>
        <form id="settings" class="settings">
          <label class="field"><span>Min games for “Best Role Player”</span><input type="number" min="1" name="minGames" value="${s.minGames}"></label>
          <label class="field"><span>Min games in a role for role titles</span><input type="number" min="1" name="minRoleGames" value="${s.minRoleGames}"></label>
          <label class="field"><span>Default seats in a new game</span><input type="number" min="6" max="12" name="defaultSeats" value="${s.defaultSeats}"></label>
        </form>
      </section>
      <section class="card">
        <h2>Demo & reset</h2>
        <div class="row gap wrap">
          <button class="btn" id="demo">Load demo data</button>
          <button class="btn danger" id="clear">Clear all data</button>
        </div>
      </section>
    </div>
  `;

  const stamp = localToday();
  $('#exportJson').onclick = () => download(`mafia-bcn-backup-${stamp}.json`, JSON.stringify(Store.get(), null, 2), 'application/json');
  $('#csvSemi').onclick = () => download(`mafia-bcn-${stamp}.csv`, toCSV(Store.get(), ';'), 'text/csv;charset=utf-8');
  $('#csvComma').onclick = () => download(`mafia-bcn-${stamp}.csv`, toCSV(Store.get(), ','), 'text/csv;charset=utf-8');
  $('#importJson').onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.players) || !Array.isArray(data.games)) throw new Error('This file is not a Mafia BCN backup');
        if (!confirm(`Replace current data with the backup (${data.players.length} players, ${data.games.length} games)?`)) return;
        Store.replace(data);
        toast('Backup restored');
        route();
      } catch (err) { alert('Could not read backup: ' + err.message); }
    };
    reader.readAsText(file);
  };
  $('#settings').onchange = e => {
    const f = e.currentTarget;
    db.settings.minGames = Math.max(1, +f.minGames.value || 3);
    db.settings.minRoleGames = Math.max(1, +f.minRoleGames.value || 2);
    db.settings.defaultSeats = Math.min(12, Math.max(6, +f.defaultSeats.value || 10));
    Store.save();
    toast('Settings saved');
  };
  $('#demo').onclick = loadDemo;
  $('#clear').onclick = () => {
    if (!confirm('Delete ALL players and games from this browser?')) return;
    if (!confirm('Really? Make sure you downloaded a backup.')) return;
    Store.clear();
    toast('All data cleared');
    route();
  };
}

/* ---------- start ---------- */
Store.load();
route();
