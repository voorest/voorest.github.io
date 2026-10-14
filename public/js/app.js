/* ============================================================
   UI — tiny hash router + views
   #/dashboard  #/games  #/game/:id  #/players  #/player/:id  #/data  #/settings  #/me
   ============================================================ */
'use strict';

const $app = document.getElementById('app');
const $ = sel => $app.querySelector(sel);
const $$ = sel => [...$app.querySelectorAll(sel)];
const UI = { lbSort: { key: 'rating', dir: -1 }, plSort: { key: 'number', dir: -1 }, editingPlayer: null };

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
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}
async function attempt(fn) {
  try { return await fn(); } catch (e) { toast('⚠ ' + e.message); return undefined; }
}
const roleChip = role => role ? `<span class="chip role-${role}" title="${ROLES[role].short}">${ROLES[role].label}</span>` : '<span class="chip muted">no role</span>';
const winnerChip = w => w ? `<span class="chip team-${w}">${w === 'town' ? 'Citizens won' : 'Mafia won'}</span>` : '<span class="chip warn">In progress</span>';
const signed = x => (x >= 0 ? '+' : '') + x.toFixed(1);
function bar(value, max, cls = '') {
  const w = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return `<span class="bar ${cls}"><span style="width:${w.toFixed(1)}%"></span></span>`;
}
function fateText(f) {
  if (!f) return 'Survived';
  return {
    killed: `Shot by mafia · night ${f.round}`, maniac: `Killed by maniac · night ${f.round}`,
    voted: `Voted out · day ${f.round}`, removed: `Removed (fouls) · day ${f.round}`, died: 'Out',
  }[f.type] || 'Out';
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
/** Save a text file. Chrome/Edge: a "Save as" window that remembers your folder (e.g. mafia_games\\data). Others: normal download. */
async function saveFile(filename, text) {
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({ id: 'mafia-backups', suggestedName: filename, types: [{ description: 'JSON backup', accept: { 'application/json': ['.json'] } }] });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      toast('Backup saved');
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn(e);
    }
  }
  download(filename, text, 'application/json');
}

function loadDemo() {
  const db = Store.get();
  if ((db.players.length || db.games.length) && !confirm('Replace ALL current data with demo data?')) return;
  Store.replace(makeDemoData());
  toast('Demo data loaded');
  route();
}

/* ---------- top bar: login + save status ---------- */
function renderAuth() {
  const el = document.getElementById('auth');
  const me = document.getElementById('navMe');
  const u = Store.user();
  me.hidden = !(u && u.playerId);
  if (!Store.isLive()) { el.innerHTML = '<span class="chip muted">local mode</span>'; return; }
  if (u) {
    el.innerHTML = `<span class="who">${h(u.nickname || (u.username ? '@' + u.username : u.name || 'you'))}${u.role === 'admin' ? ' <span class="chip admin">admin</span>' : ''}</span>
      <button class="btn small ghost" id="logoutBtn">Log out</button>`;
    document.getElementById('logoutBtn').onclick = () => attempt(() => Store.logout());
  } else if (Store.loginAvailable()) {
    el.innerHTML = `<a class="btn small tg" href="/api/auth/telegram/start?back=${encodeURIComponent('/' + (location.hash || ''))}">Log in with Telegram</a>`;
  } else {
    el.innerHTML = '';
  }
}
Store.onSaveState((s, msg) => {
  const el = document.getElementById('saveState');
  el.className = 'save-state ' + s;
  el.textContent = { saving: 'Saving…', saved: 'Saved ✓', error: 'Save failed' }[s] || '';
  el.title = msg || '';
  if (s === 'error') toast('⚠ Not saved: ' + msg);
  if (s === 'saved') { clearTimeout(el._t); el._t = setTimeout(() => { el.textContent = ''; }, 2500); }
});

/* ---------- router ---------- */
function route() {
  const parts = (location.hash || '#/dashboard').replace(/^#\/?/, '').split('/');
  const view = parts[0] || 'dashboard', id = parts[1];
  const navKey = { game: 'games', player: 'players' }[view] || view;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === navKey));
  const db = Store.get();
  let banner = '';
  if (!Store.isLive()) {
    banner = db.demo
      ? `<div class="demo-banner">Local mode with <b>demo data</b>. Real data lives on the live site.</div>`
      : `<div class="demo-banner subtle">Local mode — data is stored in this browser only.</div>`;
  } else if (Store.throttleWait()) {
    banner = `<div class="demo-banner subtle">Showing your saved copy of the data — too many refreshes, the next update check is possible in ${Store.throttleWait()} s.</div>`;
  } else if (Store.isAdmin()) {
    banner = `<div class="demo-banner subtle">Admin mode — game changes are stored only when you press <b>Save changes</b>.</div>`;
  }
  document.getElementById('banner').innerHTML = banner;
  renderAuth();
  const views = {
    dashboard: viewDashboard, games: viewGames, game: () => viewGame(id),
    players: viewPlayers, player: () => viewPlayer(id), data: viewData, settings: viewSettings,
    me: () => { const u = Store.user(); if (u && u.playerId) viewPlayer(u.playerId); else viewDashboard(); },
    'login-error': () => { $app.innerHTML = `<div class="empty"><h2>Login didn't work</h2><p>${h(decodeURIComponent(id || ''))}</p><p><a class="btn" href="/api/auth/telegram/start">Try again</a></p></div>`; },
  };
  (views[view] || viewDashboard)();
}
let currentHash = location.hash;
window.addEventListener('hashchange', () => {
  if (UI.skipHash) { UI.skipHash = false; return; }
  const stillHere = UI.draft && location.hash === '#/game/' + UI.draft.id;
  if (!stillHere && gameDirty()) {
    if (!confirm('You have unsaved changes in this game. Leave without saving?')) {
      UI.skipHash = true;
      location.hash = currentHash;
      return;
    }
  }
  if (!stillHere) { UI.draft = null; renderSaveBar(); }
  currentHash = location.hash;
  route();
  window.scrollTo(0, 0);
});
window.addEventListener('beforeunload', e => { if (gameDirty()) { e.preventDefault(); e.returnValue = ''; } });

/* ============================================================
   DASHBOARD
   ============================================================ */
const LB_COLS = [
  { key: 'number', label: 'No.', get: p => p.number, title: 'Player number = order in which players joined our stats' },
  { key: 'name', label: 'Player', get: p => p.name.toLowerCase() },
  { key: 'games', label: 'Games', get: p => p.games },
  { key: 'wins', label: 'Wins', get: p => p.wins },
  { key: 'winRate', label: 'Win %', get: p => p.winRate },
  { key: 'rating', label: 'Rating', get: p => p.rating, title: 'Win rate adjusted for number of games (see Settings)' },
  { key: 'aboveExpected', label: '± exp.', get: p => p.aboveExpected, title: 'Wins above/below what is expected for the roles this player got' },
  { key: 'days', label: 'Days', get: p => p.days },
  ...ROLE_ORDER.map(r => ({ key: r, label: ROLES[r].label, get: p => p.roleRating[r] + p.byRole[r].g / 1e4 })),
  { key: 'survived', label: 'Alive', get: p => p.survived, title: 'Games alive at the end' },
  { key: 'nomAcc', label: 'Nom. acc.', get: p => p.nomAcc ?? -1, title: 'As a citizen: share of nominations against mafia' },
];

function viewDashboard() {
  const db = Store.get();
  const st = Stats.compute(db);
  const T = st.totals;

  if (!T.games) {
    $app.innerHTML = `
      <section class="hero">
        <h1>Mafia BCN game log</h1>
        <p>No finished games yet.</p>
        ${Store.canEdit() ? `<div class="row gap wrap">
          <a class="btn primary" href="#/games">Record a game</a>
          ${Store.isLive() ? '' : '<button class="btn ghost" id="demoBtn">Load demo data</button>'}
        </div>` : ''}
      </section>`;
    if ($('#demoBtn')) $('#demoBtn').onclick = loadDemo;
    return;
  }

  const titles = Stats.titles(st, db.settings);
  const { key, dir } = UI.lbSort;
  const col = LB_COLS.find(c => c.key === key) || LB_COLS[5];
  const sorted = [...st.players].sort((a, b) => {
    const va = col.get(a), vb = col.get(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return b.rating - a.rating;
  });
  const maxGames = Math.max(...st.players.map(p => p.games));
  const recent = Store.sortedGames().filter(g => g.winner).slice(0, 6);

  $app.innerHTML = `
    <div class="page-head"><h1>Dashboard</h1>${Store.canEdit() ? '<a class="btn primary" href="#/games">+ Record a game</a>' : ''}</div>

    <section class="kpis">
      <div class="kpi"><span class="kpi-val">${T.games}</span><span class="kpi-lbl">Games played</span></div>
      <div class="kpi"><span class="kpi-val">${T.days}</span><span class="kpi-lbl">Game days</span></div>
      <div class="kpi"><span class="kpi-val">${T.players}</span><span class="kpi-lbl">Players</span></div>
      <div class="kpi"><span class="kpi-val town-text">${pct(T.townWins / T.games)}</span><span class="kpi-lbl">Citizens won (${T.townWins})</span></div>
      <div class="kpi"><span class="kpi-val mafia-text">${pct(T.mafiaWins / T.games)}</span><span class="kpi-lbl">Mafia won (${T.mafiaWins})</span></div>
    </section>
    <div class="split" title="Citizens vs Mafia wins">
      <span class="split-town" style="flex:${T.townWins}">${T.townWins ? 'Citizens ' + T.townWins : ''}</span>
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
                <td class="muted">${p.number}</td>
                <td><a href="#/player/${p.id}">${h(p.name)}</a></td>
                <td>${p.games}</td>
                <td>${p.wins}</td>
                <td>${pct(p.winRate)}</td>
                <td class="wr"><b>${pct(p.rating)}</b> ${bar(p.rating, 1)}</td>
                <td class="${p.aboveExpected >= 0 ? 'pos' : 'neg'}">${signed(p.aboveExpected)}</td>
                <td>${p.days}</td>
                ${ROLE_ORDER.map(r => `<td class="rolecell">${p.byRole[r].g ? `${p.byRole[r].w}/${p.byRole[r].g}` : '<span class="muted">–</span>'}</td>`).join('')}
                <td>${p.survived}</td>
                <td>${pct(p.nomAcc)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="muted small"><b>No.</b> = player number in order of joining (new players get the next number). <b>Rating</b> = win rate adjusted for number of games, see <a href="#/settings">Settings</a>.
      <b>± exp.</b> = wins above what the roles a player got would normally give. Role columns: wins/games. Click a header to sort.</p>
    </section>

    <div class="grid-2">
      <section class="card">
        <h2>Role leaders</h2>
        <p class="muted small">Role rating (same adjustment, using each role's own average).</p>
        <div class="role-leaders">
          ${ROLE_ORDER.map(r => {
            const list = st.players.filter(p => p.byRole[r].g > 0)
              .sort((a, b) => b.roleRating[r] - a.roleRating[r] || b.byRole[r].g - a.byRole[r].g).slice(0, 5);
            return `<div class="role-block">
              <h4>${roleChip(r)} <span class="muted small">avg ${pct(st.baseline[r])} · ${st.roleTotals[r].g} games</span></h4>
              ${list.length ? list.map(p => `
                <div class="bar-row"><a href="#/player/${p.id}">${h(p.name)}</a>${bar(p.roleRating[r], 1, 'role-' + r)}<span class="num">${pct(p.roleRating[r])} <span class="muted">${p.byRole[r].w}/${p.byRole[r].g}</span></span></div>`).join('')
                : '<p class="muted small">No games yet.</p>'}
            </div>`;
          }).join('')}
        </div>
      </section>

      <section class="card">
        <h2>Attendance</h2>
        <p class="muted small">Games played (and number of game days).</p>
        ${[...st.players].sort((a, b) => b.games - a.games || b.days - a.days).slice(0, 30).map(p => `
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
    <span class="muted small">overall #${Store.overallNumber(g)}</span>
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
      <h1>Games <span class="muted">· ${games.length}</span></h1>
      ${Store.canEdit() ? `<div class="row gap wrap">
        <input type="date" id="newDate" value="${localToday()}">
        <button class="btn primary" id="newGame">+ New game</button>
      </div>` : ''}
    </div>
    ${games.length ? Object.entries(groups).map(([date, list]) => `
      <section class="card">
        <h3>${fmtDate(date)} <span class="muted">· ${list.length} game${list.length > 1 ? 's' : ''}</span></h3>
        <div class="game-list">${list.sort((a, b) => a.number - b.number).map(gameRow).join('')}</div>
      </section>`).join('')
      : `<div class="empty">No games yet.</div>`}
  `;
  if ($('#newGame')) $('#newGame').onclick = () => attempt(async () => {
    $('#newGame').disabled = true;
    const g = await Store.newGame($('#newDate').value || localToday());
    location.hash = '#/game/' + g.id;
  }).finally(() => { if ($('#newGame')) $('#newGame').disabled = false; });
}

/* ============================================================
   GAME SCREEN — editor for the admin (and in local mode), read-only otherwise
   ============================================================ */
function viewGame(id) {
  const orig = Store.game(id);
  if (!orig) { $app.innerHTML = `<div class="empty">Game not found. <a href="#/games">Back to games</a></div>`; return; }
  const ro = !Store.canEdit();
  // Editing works on a draft copy; nothing is stored until "Save changes".
  if (!ro && (!UI.draft || UI.draft.id !== orig.id)) UI.draft = { id: orig.id, g: JSON.parse(JSON.stringify(orig)), base: JSON.stringify(orig) };
  const g = ro ? orig : UI.draft.g;
  const dis = ro ? 'disabled' : '';
  const db = Store.get();
  const imported = g.source === 'xls';
  const tl = GameLogic.timeline(g);
  const seatBy = n => g.seats.find(s => s.seat === +n);
  const name = n => { const s = seatBy(n); return s && s.playerId ? Store.playerName(s.playerId) : '—'; };
  const lbl = n => `${n}. ${name(n)}`;
  const seatOpts = (list, selected, emptyLabel) =>
    `<option value="">${emptyLabel}</option>` + list.map(n => `<option value="${n}" ${+selected === n ? 'selected' : ''}>${h(lbl(n))}</option>`).join('');
  const players = [...db.players].sort((a, b) => a.nickname.localeCompare(b.nickname));
  const used = {};
  g.seats.forEach(s => { if (s.playerId) used[s.playerId] = (used[s.playerId] || 0) + 1; });
  const counts = GameLogic.roleCounts(g);
  const warnings = ro ? [] : GameLogic.validate(g);
  const suggested = ro ? null : GameLogic.suggestWinner(g);
  const has = r => GameLogic.hasRole(g, r);

  const seatRows = g.seats.map(s => {
    const alive = tl.alive.includes(s.seat);
    const f = alive ? null : tl.fates[s.seat];
    return `<tr class="${alive ? '' : 'dead'}">
      <td class="seatno">${s.seat}</td>
      <td>${ro ? (s.playerId ? `<a href="#/player/${s.playerId}">${h(name(s.seat))}</a>` : '—') : `<select data-act="seat-player" data-seat="${s.seat}" class="${s.playerId && used[s.playerId] > 1 ? 'bad' : ''}">
        <option value="">— pick player —</option>
        ${players.map(p => `<option value="${p.id}" ${p.id === s.playerId ? 'selected' : ''}>${h(p.nickname)}${used[p.id] && p.id !== s.playerId ? ' (seated)' : ''}</option>`).join('')}
      </select>`}</td>
      <td>${ro ? roleChip(s.role) : `<select data-act="seat-role" data-seat="${s.seat}" class="role-select ${s.role ? 'role-' + s.role : ''}">
        <option value="">—</option>
        ${ROLE_ORDER.map(r => `<option value="${r}" ${s.role === r ? 'selected' : ''}>${ROLES[r].label} (${ROLES[r].short})</option>`).join('')}
      </select>`}</td>
      ${ro ? '' : `<td><input type="number" min="0" max="4" value="${s.fouls || 0}" data-act="seat-fouls" data-seat="${s.seat}" class="fouls ${s.fouls >= 3 ? 'warnf' : ''}"></td>`}
      ${!ro && imported ? `<td><label class="pick ${s.alive === 1 ? 'on-ok' : ''}"><input type="checkbox" data-act="seat-alive" data-seat="${s.seat}" ${s.alive === 1 ? 'checked' : ''}> alive</label></td>` : ''}
      <td class="fate">${alive ? '<span class="alive">alive at the end</span>' : fateText(f)}</td>
    </tr>`;
  }).join('');

  const checkResult = (seat, kind) => {
    if (!seat) return '';
    const s = seatBy(seat);
    if (!s || !s.role) return '';
    if (kind === 'sheriff') return ROLES[s.role].team === 'mafia' ? '<span class="chip team-mafia">Black ✓</span>' : '<span class="chip team-town">Red ✗</span>';
    if (kind === 'don') return s.role === 'sheriff' ? '<span class="chip role-sheriff">Sheriff ✓</span>' : '<span class="chip muted">Not sheriff ✗</span>';
    return '';
  };

  const roundsHtml = g.rounds.map((r, i) => {
    const n = i + 1;
    const dayAlive = [...tl.phases.find(p => p.round === n && p.phase === 'day').alive].sort((a, b) => a - b);
    const nightAlive = [...tl.phases.find(p => p.round === n && p.phase === 'night').alive].sort((a, b) => a - b);
    const picks = (field, list) => list.map(s => {
      const on = (r[field] || []).includes(s);
      return `<label class="pick ${on ? 'on' : ''}"><input type="checkbox" data-act="pick-${field}" data-round="${i}" data-seat="${s}" ${on ? 'checked' : ''} ${dis}>${h(lbl(s))}</label>`;
    }).join('');
    // nominations may reference seats that are out (imported data) → offer all seats then
    const nomSeats = imported ? g.seats.map(s => s.seat) : dayAlive;
    const noms = (r.nominations || []).map((nm, j) => ro
      ? `<div class="nom-row ro"><span class="nom-by">${nm.by ? h(lbl(nm.by)) : '—'}</span><span class="arrow">→</span><span class="nom-target">${h(lbl(nm.target))}</span><span class="nom-votes">${nm.votes ?? '–'} votes</span></div>`
      : `<div class="nom-row">
          <select data-act="nom-by" data-round="${i}" data-idx="${j}">${seatOpts(nomSeats, nm.by, 'who')}</select>
          <span class="arrow">→</span>
          <select data-act="nom-target" data-round="${i}" data-idx="${j}">${seatOpts(nomSeats, nm.target, 'whom')}</select>
          <input type="number" min="0" max="20" value="${nm.votes ?? ''}" placeholder="votes" data-act="nom-votes" data-round="${i}" data-idx="${j}" class="votes-input">
          <button class="btn small ghost" data-act="nom-del" data-round="${i}" data-idx="${j}" title="Remove">✕</button>
        </div>`).join('');
    const nt = r.night || {};
    const nightField = (field, label, show, kind) => {
      if (!show) return '';
      if (ro) {
        if (!nt[field]) return '';
        return `<div class="night-ro"><span class="lbl">${label}</span> <b>${h(lbl(nt[field]))}</b> ${kind ? checkResult(nt[field], kind) : ''}${field === 'doctorHeal' && (nt.doctorHeal === nt.mafiaKill || nt.doctorHeal === nt.maniacKill) ? ' <span class="chip win">saved!</span>' : ''}</div>`;
      }
      return `<label class="field"><span>${label}</span>
        <select data-act="night" data-field="${field}" data-round="${i}">${seatOpts(nightAlive, nt[field], field.endsWith('Kill') ? 'miss / none' : '—')}</select>
        ${kind ? checkResult(nt[field], kind) : ''}
      </label>`;
    };
    const anyMafia = has('mafia') || has('don') || !g.seats.some(s => s.role);
    const nightHtml = nightField('mafiaKill', 'Mafia shot', anyMafia) + nightField('donCheck', 'Don checked', has('don'), 'don') +
      nightField('sheriffCheck', 'Sheriff checked', has('sheriff'), 'sheriff') + nightField('maniacKill', 'Maniac shot', has('maniac')) +
      nightField('doctorHeal', 'Doctor healed', has('doctor'));
    const elimRo = (r.eliminated || []).length ? (r.eliminated || []).map(s => `<span class="chip team-town">${h(lbl(s))}</span>`).join(' ') : '<span class="muted small">nobody</span>';
    return `
      <div class="card round" id="round-${n}">
        <div class="round-head">
          <h3>Round ${n}</h3>
          ${!ro && i === g.rounds.length - 1 ? `<button class="btn small ghost" data-act="del-round" data-round="${i}">Remove round</button>` : ''}
        </div>
        ${ro && !nightHtml.trim() ? '' : `<div class="phase night">
          <h4>☾ Night ${n}</h4>
          <div class="night-grid">${nightHtml || '<span class="muted small">No night notes</span>'}</div>
        </div>`}
        <div class="phase day">
          <h4>☀ Day ${n} — nominations</h4>
          <div class="noms">${noms || '<span class="muted small">No nominations recorded</span>'}</div>
          ${ro ? '' : `<button class="btn small" data-act="nom-add" data-round="${i}">+ Nomination</button>`}
          <div class="picks"><span class="lbl">Voted out:</span>${ro ? elimRo : picks('eliminated', dayAlive)}</div>
          ${ro ? ((r.removed || []).length ? `<div class="picks"><span class="lbl">Removed for fouls:</span>${r.removed.map(s => `<span class="chip warn">${h(lbl(s))}</span>`).join(' ')}</div>` : '')
               : `<details ${(r.removed || []).length ? 'open' : ''}><summary>Removed for fouls</summary><div class="picks">${picks('removed', dayAlive)}</div></details>`}
        </div>
      </div>`;
  }).join('');

  $app.innerHTML = `
    <div class="page-head">
      <div>
        <a href="#/games" class="back">← Games</a>
        <h1>Game #${g.number} <span class="muted">· ${fmtDate(g.date)} · overall #${Store.overallNumber(orig)}</span></h1>
        <div class="row gap wrap">${winnerChip(g.winner)}${imported ? '<span class="chip muted">imported from spreadsheet</span>' : ''}</div>
      </div>
      ${ro ? '' : `<div class="row gap wrap">
        <label class="field inline"><span>Date</span><input type="date" data-act="date" value="${g.date}"></label>
        <label class="field inline"><span>Game #</span><input type="number" min="1" data-act="number" value="${g.number}" class="num-input"></label>
        <button class="btn danger" data-act="del-game">Delete</button>
      </div>`}
    </div>

    <section class="card">
      <div class="section-head">
        <h2>Seats & roles</h2>
        ${ro ? '' : `<div class="row gap wrap">
          <label class="field inline"><span>Seats</span><select data-act="seat-count">${Array.from({ length: 11 }, (_, k) => k + 6).map(n => `<option ${n === g.seats.length ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <button class="btn small" data-act="random-roles">🎲 Random roles</button>
          <button class="btn small ghost" data-act="clear-roles">Clear roles</button>
        </div>`}
      </div>
      ${ro ? '' : `<div class="row gap quick-add">
        <input id="qaName" placeholder="New player nickname → goes to the first empty seat">
        <button class="btn small" data-act="quick-add">+ Add player</button>
      </div>`}
      <div class="role-count">${ROLE_ORDER.filter(r => counts[r]).map(r => `<span class="chip role-${r}">${ROLES[r].label} × ${counts[r]}</span>`).join('')}</div>
      ${warnings.length ? `<ul class="warnings">${warnings.map(w => `<li>${h(w)}</li>`).join('')}</ul>` : ''}
      <div class="table-wrap">
        <table class="seats">
          <thead><tr><th>#</th><th>Player</th><th>Role</th>${ro ? '' : '<th>Fouls</th>'}${!ro && imported ? '<th>End</th>' : ''}<th>Status</th></tr></thead>
          <tbody>${seatRows}</tbody>
        </table>
      </div>
      ${!ro && imported ? '<p class="muted small">Imported game: there are no night notes, so "alive at the end" is set by hand.</p>' : ''}
    </section>

    <div class="section-head"><h2>Rounds</h2>${ro ? '' : '<span class="muted small">Each round = Night (shots, checks, heal) → Day (nominations, vote-out). Nothing is saved until you press <b>Save changes</b>.</span>'}</div>
    ${roundsHtml || '<div class="card muted">No rounds recorded.</div>'}
    ${ro ? '' : `<button class="btn primary add-round" data-act="add-round">+ Add round ${g.rounds.length + 1}</button>`}

    <section class="card result">
      <h2>Result</h2>
      <div class="alive-list"><span class="lbl">Alive at the end (${tl.alive.length}):</span>
        ${tl.alive.map(n => { const s = seatBy(n); return `<span class="alive-chip">${h(lbl(n))} ${s && s.role ? roleChip(s.role) : ''}</span>`; }).join('') || '<span class="muted">nobody</span>'}
      </div>
      ${ro ? (g.notes ? `<p class="notes">${h(g.notes)}</p>` : '') : `
      ${suggested && suggested !== g.winner ? `<p class="hint">By the rules it looks like <b>${TEAM_LABEL[suggested]}</b> won. <button class="btn small" data-act="winner" data-val="${suggested}">Set ${TEAM_LABEL[suggested]} as winner</button></p>` : ''}
      <div class="seg">
        <button class="seg-town ${g.winner === 'town' ? 'on' : ''}" data-act="winner" data-val="town">Citizens (МИР) won</button>
        <button class="seg-mafia ${g.winner === 'mafia' ? 'on' : ''}" data-act="winner" data-val="mafia">Mafia (МАФ) won</button>
        <button class="${!g.winner ? 'on' : ''}" data-act="winner" data-val="">Not finished</button>
      </div>
      <label class="field block"><span>Notes</span><textarea data-act="notes" rows="3" placeholder="Anything worth remembering about this game">${h(g.notes)}</textarea></label>`}
    </section>
  `;
  if (ro) return;
  renderSaveBar();

  const commit = () => viewGame(id);

  async function handle(act, el) {
    const seat = +el.dataset.seat, ri = +el.dataset.round, idx = +el.dataset.idx;
    const s = seat ? g.seats.find(x => x.seat === seat) : null;
    const r = Number.isInteger(ri) ? g.rounds[ri] : null;
    switch (act) {
      case 'seat-player': s.playerId = el.value || null; break;
      case 'seat-role': s.role = el.value || null; break;
      case 'seat-alive': s.alive = el.checked ? 1 : 0; break;
      case 'seat-fouls': s.fouls = Math.max(0, Math.min(4, +el.value || 0)); if (s.fouls >= 4) toast('4 fouls — mark the player as removed in the current round'); break;
      case 'nom-add': r.nominations.push({ by: null, target: null, votes: null }); break;
      case 'nom-del': r.nominations.splice(idx, 1); break;
      case 'nom-by': r.nominations[idx].by = el.value ? +el.value : null; break;
      case 'nom-target': r.nominations[idx].target = el.value ? +el.value : null; break;
      case 'nom-votes': r.nominations[idx].votes = el.value === '' ? null : +el.value; renderSaveBar(); return;
      case 'pick-eliminated':
      case 'pick-removed': {
        const field = act.slice(5);
        const arr = (r[field] ||= []);
        const at = arr.indexOf(seat);
        if (el.checked && at < 0) arr.push(seat);
        if (!el.checked && at >= 0) arr.splice(at, 1);
        break;
      }
      case 'night': r.night[el.dataset.field] = el.value ? +el.value : null; break;
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
        const pool = Object.entries(roleSetup(g.seats.length)).flatMap(([rr, c]) => Array(c).fill(rr));
        for (let k = pool.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [pool[k], pool[j]] = [pool[j], pool[k]]; }
        g.seats.forEach((x, k) => { x.role = pool[k]; });
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
        while (g.seats.length < n) g.seats.push({ seat: g.seats.length + 1, playerId: null, role: null, alive: null, fouls: 0 });
        break;
      }
      case 'quick-add': {
        const inp = $('#qaName');
        const p = await attempt(() => Store.addPlayer(inp.value));
        if (!p) { if (!inp.value.trim()) toast('Type a nickname first'); return; }
        const free = g.seats.find(x => !x.playerId);
        if (free && !g.seats.some(x => x.playerId === p.id)) { free.playerId = p.id; toast(`${p.nickname} (No. ${p.number}) → seat ${free.seat}`); }
        else toast(`${p.nickname} added`);
        break;
      }
      case 'winner': g.winner = el.dataset.val || null; if (g.winner) toast('Result saved'); break;
      case 'notes': g.notes = el.value; renderSaveBar(); return;
      case 'date': if (el.value) g.date = el.value; break;
      case 'number': g.number = Math.max(1, +el.value || 1); break;
      case 'del-game':
        if (!confirm('Delete this game permanently?')) return;
        if (await attempt(() => Store.deleteGame(id).then(() => true))) { UI.draft = null; location.hash = '#/games'; }
        return;
    }
    commit();
  }

  $$('[data-act]').forEach(el => {
    const evt = el.tagName === 'BUTTON' ? 'click' : 'change';
    el.addEventListener(evt, () => handle(el.dataset.act, el));
  });
  $('#qaName').addEventListener('keydown', e => { if (e.key === 'Enter') handle('quick-add', e.target); });
  $$('textarea[data-act="notes"], input[data-act="nom-votes"]').forEach(el => el.addEventListener('input', () => handle(el.dataset.act, el)));
}

/* ---------- unsaved changes: bar, summary, save/discard ---------- */
function gameDirty() { return !!(UI.draft && JSON.stringify(UI.draft.g) !== UI.draft.base); }

function changeSummary(base, g) {
  const out = [];
  const label = w => (w ? TEAM_LABEL[w] + ' won' : 'not finished');
  if (base.date !== g.date) out.push(`Date: ${base.date} → ${g.date}`);
  if (base.number !== g.number) out.push(`Game #: ${base.number} → ${g.number}`);
  if (base.winner !== g.winner) out.push(`Result: ${label(base.winner)} → ${label(g.winner)}`);
  if ((base.notes || '') !== (g.notes || '')) out.push('Notes changed');
  if (base.seats.length !== g.seats.length) out.push(`Seats: ${base.seats.length} → ${g.seats.length}`);
  g.seats.forEach(s => {
    const b = base.seats.find(x => x.seat === s.seat);
    if (!b) return;
    if (b.playerId !== s.playerId) out.push(`Seat ${s.seat}: ${b.playerId ? Store.playerName(b.playerId) : '—'} → ${s.playerId ? Store.playerName(s.playerId) : '—'}`);
    if (b.role !== s.role) out.push(`Seat ${s.seat}: role ${b.role ? ROLES[b.role].label : '—'} → ${s.role ? ROLES[s.role].label : '—'}`);
    if (b.alive !== s.alive && g.source === 'xls') out.push(`Seat ${s.seat}: ${s.alive ? 'alive' : 'out'} at the end`);
    if ((b.fouls || 0) !== (s.fouls || 0)) out.push(`Seat ${s.seat}: fouls ${b.fouls || 0} → ${s.fouls || 0}`);
  });
  if (base.rounds.length !== g.rounds.length) out.push(`Rounds: ${base.rounds.length} → ${g.rounds.length}`);
  g.rounds.forEach((r, i) => {
    const b = base.rounds[i];
    if (!b) return;
    if (JSON.stringify(b.night) !== JSON.stringify(r.night)) out.push(`Round ${i + 1}: night changed`);
    if (JSON.stringify([b.nominations, b.eliminated, b.removed]) !== JSON.stringify([r.nominations, r.eliminated, r.removed])) out.push(`Round ${i + 1}: day changed`);
  });
  return out;
}

function renderSaveBar() {
  let bar = document.getElementById('savebar');
  if (!gameDirty()) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'savebar';
    bar.className = 'savebar';
    document.body.appendChild(bar);
  }
  const changes = changeSummary(JSON.parse(UI.draft.base), UI.draft.g);
  bar.innerHTML = `<div class="savebar-inner">
      <span class="dot"></span><b>Unsaved changes</b><span class="muted small">${changes.length} change${changes.length === 1 ? '' : 's'}: ${h(changes.slice(0, 3).join(' · '))}${changes.length > 3 ? ' …' : ''}</span>
      <span class="spacer"></span>
      <button class="btn ghost small" id="discardBtn">Discard</button>
      <button class="btn primary" id="saveBtn">Save changes</button>
    </div>`;
  document.getElementById('discardBtn').onclick = () => {
    if (!confirm('Discard all unsaved changes in this game?')) return;
    const id = UI.draft.id;
    UI.draft = null;
    renderSaveBar();
    viewGame(id);
  };
  document.getElementById('saveBtn').onclick = async () => {
    const list = changeSummary(JSON.parse(UI.draft.base), UI.draft.g);
    const text = list.slice(0, 15).map(x => '• ' + x).join('\n') + (list.length > 15 ? `\n… and ${list.length - 15} more` : '');
    if (!confirm(`Save these changes to Game #${UI.draft.g.number} (${UI.draft.g.date})?\n\n${text}`)) return;
    const btn = document.getElementById('saveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    const saved = await attempt(() => Store.saveGame(UI.draft.g));
    if (saved) {
      UI.draft = { id: saved.id, g: JSON.parse(JSON.stringify(saved)), base: JSON.stringify(saved) };
      toast('Game saved');
      renderSaveBar();
      viewGame(saved.id);
    } else { btn.disabled = false; btn.textContent = 'Save changes'; }
  };
}

/* ============================================================
   PLAYERS
   ============================================================ */
function viewPlayers() {
  const db = Store.get();
  const st = Stats.compute(db);
  const byId = Object.fromEntries(st.players.map(p => [p.id, p]));
  const edit = Store.canEdit();
  const adminLive = Store.isAdmin();
  const priv = adminLive ? Object.fromEntries(Store.adminData().players.map(p => [p.id, p])) : {};
  const accounts = adminLive ? Store.adminData().accounts : [];
  const tgFor = pid => accounts.filter(a => a.player_id === pid && a.provider === 'telegram');

  const cols = [
    { key: 'number', label: 'No.', get: p => p.number },
    { key: 'nickname', label: 'Nickname', get: p => p.nickname.toLowerCase() },
    { key: 'games', label: 'Games', get: p => (byId[p.id] || {}).games || 0 },
    { key: 'wins', label: 'Wins', get: p => (byId[p.id] || {}).wins || 0 },
    { key: 'rating', label: 'Rating', get: p => (byId[p.id] || {}).rating || 0 },
    { key: 'last', label: 'Last played', get: p => (byId[p.id] || {}).lastPlayed || '' },
  ];
  const { key, dir } = UI.plSort;
  const col = cols.find(c => c.key === key) || cols[0];
  const list = [...db.players].sort((a, b) => { const va = col.get(a), vb = col.get(b); return va < vb ? -dir : va > vb ? dir : a.number - b.number; });

  const row = p => {
    const s = byId[p.id];
    const pv = priv[p.id] || {};
    const tg = tgFor(p.id);
    if (UI.editingPlayer === p.id) {
      const pre = tg.find(a => !a.linked) || tg[0];
      return `<tr class="editing"><td class="muted">${p.number}</td><td colspan="${adminLive ? 8 : 6}">
        <form class="edit-player row gap wrap" data-id="${p.id}">
          <label class="field"><span>Nickname (public)</span><input name="nickname" value="${h(p.nickname)}" required></label>
          ${adminLive ? `
          <label class="field"><span>First name (private)</span><input name="first_name" value="${h(pv.first_name || '')}"></label>
          <label class="field"><span>Last name (private)</span><input name="last_name" value="${h(pv.last_name || '')}"></label>
          <label class="field"><span>Telegram @username</span><input name="telegram" value="${h(pre ? pre.username || '' : '')}" placeholder="@username"></label>` : ''}
          <div class="row gap"><button class="btn primary small">Save</button><button type="button" class="btn ghost small" data-cancel>Cancel</button></div>
        </form></td></tr>`;
    }
    return `<tr data-name="${h((p.nickname + ' ' + (pv.first_name || '') + ' ' + (pv.last_name || '') + ' ' + tg.map(a => a.username).join(' ')).toLowerCase())}">
      <td class="muted">${p.number}</td>
      <td><a href="#/player/${p.id}">${h(p.nickname)}</a></td>
      ${adminLive ? `<td>${h([pv.first_name, pv.last_name].filter(Boolean).join(' ')) || '<span class="muted">—</span>'}</td>
        <td>${tg.length ? tg.map(a => `<span class="chip ${a.linked ? 'win' : 'muted'}" title="${a.linked ? 'linked: has logged in' : 'waiting for first login'}">@${h(a.username || a.display_name || '?')}</span>`).join(' ') : '<span class="muted">—</span>'}</td>` : ''}
      <td>${s ? s.games : 0}</td>
      <td>${s ? s.wins : 0}</td>
      <td>${s ? pct(s.rating) : '—'}</td>
      <td>${s && s.lastPlayed ? fmtDate(s.lastPlayed) : '—'}</td>
      ${edit ? `<td class="actions"><button class="btn small ghost" data-edit="${p.id}">Edit</button><button class="btn small ghost danger-text" data-del="${p.id}">Delete</button></td>` : ''}
    </tr>`;
  };

  const loggedIn = accounts.filter(a => a.linked);
  $app.innerHTML = `
    <div class="page-head"><h1>Players <span class="muted">· ${list.length}</span></h1></div>
    ${edit ? `<section class="card">
      <form id="addForm" class="row gap wrap">
        <input name="nickname" placeholder="Nickname" required>
        <button class="btn primary">+ Add player</button>
        <span class="muted small">New players get the next number (No. ${Math.max(0, ...db.players.map(p => p.number)) + 1}).</span>
      </form>
    </section>` : ''}
    <section class="card">
      <input id="filter" class="filter" placeholder="Search players…">
      <div class="table-wrap">
        <table class="players">
          <thead><tr>
            ${cols.slice(0, 2).map(c => `<th data-sort="${c.key}" class="sortable ${c.key === key ? 'sorted' : ''}">${c.label}${c.key === key ? (dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('')}
            ${adminLive ? '<th>Name</th><th>Telegram</th>' : ''}
            ${cols.slice(2).map(c => `<th data-sort="${c.key}" class="sortable ${c.key === key ? 'sorted' : ''}">${c.label}${c.key === key ? (dir < 0 ? ' ↓' : ' ↑') : ''}</th>`).join('')}
            ${edit ? '<th></th>' : ''}
          </tr></thead>
          <tbody>${list.map(row).join('') || '<tr><td colspan="9" class="muted">No players yet.</td></tr>'}</tbody>
        </table>
      </div>
      ${adminLive ? '<p class="muted small">Name and Telegram are private (only you see them). If you add someone\'s Telegram @username, they are linked to this player automatically the first time they log in.</p>' : ''}
    </section>
    ${adminLive ? `
    <section class="card">
      <h2>Telegram logins</h2>
      <p class="muted small">Everyone who has logged in. Link an account to a player so they see "My stats"; make someone admin if they should help with data.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Telegram</th><th>Last login</th><th>Player</th><th>Role</th></tr></thead>
        <tbody>${loggedIn.map(a => `<tr>
          <td>${h(a.display_name || '')} ${a.username ? `<span class="muted">@${h(a.username)}</span>` : ''}</td>
          <td class="muted">${a.last_login_at ? h(a.last_login_at.slice(0, 16)) : '—'}</td>
          <td><select data-acc-player="${a.id}"><option value="">— not linked —</option>${[...db.players].sort((x, y) => x.nickname.localeCompare(y.nickname)).map(p => `<option value="${p.id}" ${a.player_id === p.id ? 'selected' : ''}>${h(p.nickname)}</option>`).join('')}</select></td>
          <td><select data-acc-role="${a.id}"><option value="player" ${a.role === 'player' ? 'selected' : ''}>player</option><option value="admin" ${a.role === 'admin' ? 'selected' : ''}>admin</option></select></td>
        </tr>`).join('') || '<tr><td colspan="4" class="muted">Nobody has logged in yet.</td></tr>'}</tbody>
      </table></div>
    </section>` : ''}
  `;

  $('#filter').oninput = e => {
    const q = e.target.value.trim().toLowerCase();
    $$('tbody tr[data-name]').forEach(tr => { tr.style.display = tr.dataset.name.includes(q) ? '' : 'none'; });
  };
  $$('th[data-sort]').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    UI.plSort = { key: k, dir: UI.plSort.key === k ? -UI.plSort.dir : (k === 'nickname' ? 1 : -1) };
    viewPlayers();
  });
  if (!edit) return;
  $('#addForm').onsubmit = e => {
    e.preventDefault();
    attempt(async () => {
      const p = await Store.addPlayer(e.target.nickname.value);
      if (p) { toast(`${p.nickname} added as No. ${p.number}`); viewPlayers(); $('#addForm input').focus(); }
    });
  };
  $$('[data-edit]').forEach(b => b.onclick = () => { UI.editingPlayer = b.dataset.edit; viewPlayers(); });
  $$('[data-cancel]').forEach(b => b.onclick = () => { UI.editingPlayer = null; viewPlayers(); });
  $$('form.edit-player').forEach(f => f.onsubmit = e => {
    e.preventDefault();
    const patch = { nickname: f.nickname.value.trim() };
    if (f.first_name) Object.assign(patch, { first_name: f.first_name.value, last_name: f.last_name.value, telegram: f.telegram.value });
    attempt(async () => { await Store.updatePlayer(f.dataset.id, patch); UI.editingPlayer = null; toast('Saved'); viewPlayers(); });
  });
  $$('[data-del]').forEach(b => b.onclick = () => {
    const p = Store.player(b.dataset.del);
    if (Store.playerInUse(p.id)) { toast(`${p.nickname} has played games — edit instead`); return; }
    if (confirm(`Delete ${p.nickname}?`)) attempt(async () => { await Store.deletePlayer(p.id); viewPlayers(); });
  });
  $$('[data-acc-player]').forEach(s => s.onchange = () => attempt(async () => { await Store.updateAccount(s.dataset.accPlayer, { player_id: s.value || null }); toast('Saved'); viewPlayers(); }));
  $$('[data-acc-role]').forEach(s => s.onchange = () => attempt(async () => { await Store.updateAccount(s.dataset.accRole, { role: s.value }); toast('Saved'); viewPlayers(); }));
}

/* ---------- player profile ("My stats") ---------- */
function viewPlayer(id) {
  const p0 = Store.player(id);
  if (!p0) { $app.innerHTML = `<div class="empty">Player not found. <a href="#/players">Back</a></div>`; return; }
  const st = Stats.compute(Store.get());
  const p = st.players.find(x => x.id === p0.id);
  const ranked = [...st.players].sort((a, b) => b.rating - a.rating);
  const rank = ranked.findIndex(x => x.id === p0.id) + 1;
  const mine = Store.user() && Store.user().playerId === p0.id;

  const head = `
    <div class="page-head">
      <div><a href="#/players" class="back">← Players</a><h1>${h(p0.nickname)} <span class="muted">No. ${p0.number}</span>${mine ? ' <span class="chip win">you</span>' : ''}</h1></div>
    </div>`;

  if (!p) { $app.innerHTML = head + `<div class="empty">No finished games yet for ${h(p0.nickname)}.</div>`; return; }

  const facts = [
    ['Alive at the end', `${p.survived} (${pct(p.survived / p.games)})`],
    ['Voted out', p.voted],
    ['Shot by mafia', p.killed],
    ['Killed by maniac', p.maniac],
    ['Shot first at night', p.firstKilled],
    ['Removed for fouls', p.removed],
    ['Nominations made', p.noms],
    ['Nominations on mafia (as citizen)', p.nomsAsTown ? `${p.nomsOnMafia}/${p.nomsAsTown} (${pct(p.nomAcc)})` : '—'],
    ['Sheriff checks found black', p.sheriffChecks ? `${p.sheriffBlack}/${p.sheriffChecks}` : '—'],
    ['Don found the sheriff', p.donChecks ? `${p.donFoundSheriff}/${p.donChecks}` : '—'],
    ['Doctor saves', p.byRole.doctor.g ? p.doctorSaves : '—'],
    ['Maniac kills (on mafia)', p.byRole.maniac.g ? `${p.maniacKills} (${p.maniacKillsMafia})` : '—'],
  ];

  $app.innerHTML = head + `
    <section class="kpis">
      <div class="kpi"><span class="kpi-val">#${rank}</span><span class="kpi-lbl">Rank of ${ranked.length}</span></div>
      <div class="kpi"><span class="kpi-val">${pct(p.rating)}</span><span class="kpi-lbl">Rating</span></div>
      <div class="kpi"><span class="kpi-val">${p.wins}/${p.games}</span><span class="kpi-lbl">Wins / games (${pct(p.winRate)})</span></div>
      <div class="kpi"><span class="kpi-val ${p.aboveExpected >= 0 ? 'pos' : 'neg'}">${signed(p.aboveExpected)}</span><span class="kpi-lbl">Wins vs expected</span></div>
      <div class="kpi"><span class="kpi-val">${p.days}</span><span class="kpi-lbl">Game days</span></div>
    </section>

    <div class="grid-2">
      <section class="card">
        <h2>By role</h2>
        ${ROLE_ORDER.map(r => `
          <div class="bar-row">${roleChip(r)}${bar(p.byRole[r].g ? p.roleRating[r] : 0, 1, 'role-' + r)}<span class="num">${p.byRole[r].g ? pct(p.roleRating[r]) : '—'} <span class="muted">${p.byRole[r].w}/${p.byRole[r].g}</span></span></div>`).join('')}
        <p class="muted small">Bars show the role rating (role average: ${ROLE_ORDER.map(r => `${ROLES[r].label} ${pct(st.baseline[r])}`).join(', ')}).</p>
      </section>
      <section class="card">
        <h2>How the games went</h2>
        <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
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
}

/* ============================================================
   DATA: backup / import / CSV
   ============================================================ */
function toCSV(db, sep) {
  const cols = ['date', 'game_no', 'game_id', 'seat', 'player_no', 'player', 'role', 'team', 'winner', 'won', 'alive_end', 'fate', 'fate_round', 'fouls'];
  const esc = v => { v = String(v ?? ''); return /["\n\r;,]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const rows = [cols.join(sep)];
  [...db.games].sort((a, b) => a.date.localeCompare(b.date) || a.number - b.number).forEach(g => {
    const tl = GameLogic.timeline(g);
    g.seats.forEach(s => {
      const alive = tl.alive.includes(s.seat);
      const f = alive ? null : tl.fates[s.seat];
      const team = s.role ? ROLES[s.role].team : '';
      const p = Store.player(s.playerId) || {};
      rows.push([g.date, g.number, g.id, s.seat, p.number || '', p.nickname || '', s.role || '', team, g.winner || '',
        g.winner && team ? (team === g.winner ? 1 : 0) : '', alive ? 1 : 0, f ? f.type : '', f && f.round ? f.round : '', s.fouls || 0].map(esc).join(sep));
    });
  });
  return '﻿' + rows.join('\r\n');
}

function viewData() {
  const db = Store.get();
  const live = Store.isLive();
  const stamp = localToday();
  $app.innerHTML = `
    <div class="page-head"><h1>Data</h1></div>
    ${live ? `<div class="callout">Live site: data comes from the database${Store.isAdmin() ? ' — you are admin, so you can edit games and players and download a full backup.' : '. Downloads contain public data only (nicknames).'}</div>`
           : `<div class="callout">Local mode: data is stored <b>in this browser only</b>. Download a backup after every game night.</div>`}
    <div class="grid-2">
      <section class="card">
        <h2>Backup</h2>
        <p class="muted small">${db.players.length} players · ${db.games.length} games</p>
        <div class="row gap wrap">
          ${Store.isAdmin() ? '<button class="btn primary" id="fullBackup">⬇ Full backup (private, JSON)</button>' : ''}
          <button class="btn ${Store.isAdmin() ? '' : 'primary'}" id="exportJson">⬇ Public data (JSON)</button>
          ${live ? '' : '<label class="btn">⬆ Restore from backup<input type="file" id="importJson" accept=".json,application/json" hidden></label>'}
        </div>
        ${Store.isAdmin() ? '<p class="muted small">The full backup includes private names and Telegram accounts. Keep it in your private <code>data</code> folder.</p>' : ''}
      </section>
      <section class="card">
        <h2>Export for Excel</h2>
        <p class="muted small">One row per player per game — easy to pivot in Excel.</p>
        <div class="row gap wrap">
          <button class="btn" id="csvSemi">CSV for Excel (EU, “;”)</button>
          <button class="btn ghost" id="csvComma">CSV (“,”)</button>
        </div>
      </section>
      ${Store.isAdmin() ? `<section class="card">
        <h2>Backups in Cloudflare</h2>
        <p class="muted small">Every Sunday at 09:00 (08:00 in winter) a full backup is stored automatically; the last 12 are kept, plus the last 5 manual ones. You get a Telegram message each time.</p>
        <div class="row gap wrap">
          <button class="btn" id="backupNow">Back up now</button>
          <button class="btn ghost" id="notifyTest">Send test message to my Telegram</button>
        </div>
        <div id="backupList" class="backup-list"><p class="muted small">Loading…</p></div>
      </section>` : ''}
      ${live ? '' : `<section class="card">
        <h2>Demo & reset</h2>
        <div class="row gap wrap">
          <button class="btn" id="demo">Load demo data</button>
          <button class="btn danger" id="clear">Clear all data</button>
        </div>
      </section>`}
    </div>
  `;

  if ($('#fullBackup')) $('#fullBackup').onclick = () => attempt(async () => {
    const res = await fetch('/api/admin/backup', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Backup failed (' + res.status + ')');
    await saveFile(`mafia-bcn-backup-${stamp}.json`, await res.text());
  });
  $('#exportJson').onclick = () => download(`mafia-bcn-${live ? 'public' : 'local'}-${stamp}.json`, JSON.stringify(Store.get(), null, 2), 'application/json');
  $('#csvSemi').onclick = () => download(`mafia-bcn-${stamp}.csv`, toCSV(Store.get(), ';'), 'text/csv;charset=utf-8');
  $('#csvComma').onclick = () => download(`mafia-bcn-${stamp}.csv`, toCSV(Store.get(), ','), 'text/csv;charset=utf-8');
  if (Store.isAdmin()) {
    const renderBackups = async () => {
      const box = $('#backupList');
      const res = await attempt(() => Store.listBackups());
      if (!res || !box) return;
      box.innerHTML = res.backups.length ? `<table><thead><tr><th>When</th><th>Type</th><th>Games</th><th>Players</th><th>Size</th><th></th></tr></thead><tbody>${res.backups.map(b => `
        <tr><td>${h(new Date(b.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</td><td>${h(b.kind)}</td><td>${b.games}</td><td>${b.players}</td><td>${Math.round(b.size / 1024)} KB</td>
        <td><button class="btn small" data-dl="${h(b.name)}">⬇ Download</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="muted small">No backups yet — the first weekly one runs on Sunday, or press “Back up now”.</p>';
      $$('[data-dl]').forEach(btn => btn.onclick = () => attempt(async () => {
        const r = await fetch('/api/admin/backups/' + encodeURIComponent(btn.dataset.dl), { credentials: 'same-origin' });
        if (!r.ok) throw new Error('Download failed (' + r.status + ')');
        await saveFile(`mafia-bcn-backup-${btn.dataset.dl}.json`, await r.text());
      }));
    };
    renderBackups();
    $('#backupNow').onclick = () => attempt(async () => { const b = await Store.backupNow(); toast(`Backup saved (${b.games} games, ${Math.round(b.size / 1024)} KB)`); renderBackups(); });
    $('#notifyTest').onclick = () => attempt(async () => {
      const r = await Store.notifyTest();
      const bad = r.results.filter(x => !x.ok);
      if (!r.results.length) toast('No admin Telegram account found');
      else if (bad.length) toast('⚠ ' + bad.map(x => `@${x.to}: ${x.error}`).join('; ') + ' — open @mafia_bcn_bot and press Start');
      else toast('Sent! Check Telegram');
    });
  }
  if (live) return;
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
  $('#demo').onclick = loadDemo;
  $('#clear').onclick = () => {
    if (!confirm('Delete ALL players and games from this browser?')) return;
    if (!confirm('Really? Make sure you downloaded a backup.')) return;
    Store.clear();
    toast('All data cleared');
    route();
  };
}

/* ============================================================
   SETTINGS — rating rules (group-wide on the live site, admin edits)
   ============================================================ */
function viewSettings() {
  const db = Store.get();
  const s = db.settings;
  const edit = Store.canEdit();
  const dis = edit ? '' : 'disabled';
  const st = Stats.compute(db);
  $app.innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <div class="grid-2">
      <section class="card">
        <h2>Rating rules</h2>
        <form id="settings" class="settings">
          <label class="field"><span>Confidence weight K — how many “average games” every player starts with</span><input type="number" min="0" max="50" name="priorWeight" value="${s.priorWeight}" ${dis}></label>
          <label class="field"><span>Minimum games for “King of the Game”</span><input type="number" min="1" max="50" name="minGames" value="${s.minGames}" ${dis}></label>
          <label class="field"><span>Seats in a new game</span><input type="number" min="6" max="16" name="defaultSeats" value="${s.defaultSeats}" ${dis}></label>
          ${edit ? '<div><button class="btn primary" type="submit">Save settings</button></div>' : '<p class="muted small">Only the admin can change these.</p>'}
        </form>
      </section>
      <section class="card">
        <h2>How ratings work</h2>
        <p><b>Rating</b> = (wins + K × average) ÷ (games + K)</p>
        <p class="muted">Now: K = ${st.K}, average win rate per seat = ${pct(st.overallRate)}. A new player starts at the average; every game moves the rating towards their real win rate. So 8 wins of 10 games ranks higher than 2 of 2.</p>
        <p><b>Role rating</b> — same formula, but with that role's own average:</p>
        <p class="muted">${ROLE_ORDER.map(r => `${ROLES[r].label} ${pct(st.baseline[r])}`).join(' · ')}</p>
        <p><b>± exp.</b> — wins minus the wins expected from the roles a player received (mafia wins less often, so a mafia win counts for more).</p>
      </section>
    </div>
  `;
  if (!edit) return;
  $('#settings').onsubmit = e => {
    e.preventDefault();
    const f = e.currentTarget;
    const patch = {
      priorWeight: Math.max(0, Math.min(50, +f.priorWeight.value || 0)),
      minGames: Math.max(1, Math.min(50, +f.minGames.value || 3)),
      defaultSeats: Math.min(16, Math.max(6, +f.defaultSeats.value || 10)),
    };
    if (!confirm(`Save settings?\n\nK = ${patch.priorWeight}, min games for King = ${patch.minGames}, seats in a new game = ${patch.defaultSeats}`)) return;
    attempt(async () => { await Store.saveSettings(patch); toast('Settings saved'); viewSettings(); });
  };
}

/* ---------- start ---------- */
(async () => {
  $app.innerHTML = '<div class="empty">Loading…</div>';
  await Store.init();
  route();
})();
