/* ============================================================
   UI — tiny hash router + views
   /dashboard  /games  /game/DD-MM-YYYY/N  /game/new  /players  /player/:no  /data  /settings  /bot  /me
   Plain paths (History API); old #/… links are converted on load.
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
/* Date fields always show DD/MM/YYYY (the browser's own date input follows the OS locale).
   A text input holds the value; the 📅 button opens the native picker. */
const isoToDmy = iso => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('/') : '');
function dmyToIso(v) {
  const m = String(v || '').trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(iso + 'T12:00:00');
  return !isNaN(d) && d.getDate() === +m[1] ? iso : null;
}
function dateField(iso, attrs = '') {
  return `<span class="date-field"><input type="text" inputmode="numeric" placeholder="DD/MM/YYYY" maxlength="10" value="${isoToDmy(iso)}" ${attrs}>` +
    `<button type="button" class="date-pick" title="Pick a date" tabindex="-1">📅</button><input type="date" class="date-native" tabindex="-1" aria-hidden="true" value="${iso}"></span>`;
}
function wireDateFields(root) {
  root.querySelectorAll('.date-field').forEach(box => {
    const text = box.querySelector('input[type=text]'), native = box.querySelector('.date-native');
    text.addEventListener('input', e => {
      if (e.inputType && e.inputType.startsWith('delete')) return;
      const digits = text.value.replace(/\D/g, '').slice(0, 8);
      text.value = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/');
    });
    text.addEventListener('change', () => { const iso = dmyToIso(text.value); if (iso) native.value = iso; });
    box.querySelector('.date-pick').addEventListener('click', () => {
      try { native.showPicker(); } catch { native.focus(); native.click(); }
    });
    native.addEventListener('change', () => {
      if (!native.value) return;
      text.value = isoToDmy(native.value);
      text.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}
/* Addresses use our own numbers, never database ids:
   games  /game/17-05-2026/1  (date + game number of that day), players  /player/27  (player No.) */
const gameHref = g => (g.id === 'new' ? '/game/new' : `/game/${isoToDmy(g.date).replace(/\//g, '-')}/${g.number}`);
const playerHref = pOrId => {
  const p = typeof pOrId === 'object' && pOrId ? pOrId : Store.player(pOrId);
  return `/player/${p && p.number ? p.number : pOrId}`;
};
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
  } else if (Store.devLogin()) {
    el.innerHTML = `<a class="btn small" href="/api/auth/dev-login">Dev login (local admin)</a>`;
  } else if (Store.loginAvailable()) {
    el.innerHTML = `<a class="btn small tg" href="/api/auth/telegram/start?back=${encodeURIComponent(location.pathname)}">Log in with Telegram</a>`;
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
  const parts = location.pathname.replace(/^\/+|\/+$/g, '').replace(/^index\.html$/, '').split('/').map(decodeURIComponent);
  const view = parts[0] || 'dashboard';
  let id = parts[1];
  if (view === 'game' && id && id !== 'new') {
    const iso = /^\d{2}-\d{2}-\d{4}$/.test(id) ? dmyToIso(id.replace(/-/g, '/')) : null;
    const g = iso ? Store.gameByDay(iso, parts[2]) : Store.game(id); // old links used the database id
    if (g && !iso) { history.replaceState(null, '', gameHref(g)); currentPath = location.pathname; }
    id = g ? g.id : '-';
  }
  if (view === 'player' && id) { const p = Store.playerByNumber(id); id = p ? p.id : '-'; }
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
  // Data and Settings are for the admin only (in local mode they stay available for editing).
  const adminPages = Store.canEdit();
  document.querySelectorAll('#nav [data-admin]').forEach(a => { a.hidden = !adminPages; });
  document.querySelectorAll('#nav [data-admin-live]').forEach(a => { a.hidden = !Store.isAdmin(); });
  if ((!adminPages && (view === 'data' || view === 'settings')) || (view === 'bot' && !Store.isAdmin())) { go('/dashboard', { replace: true }); return; }
  if (view !== 'bot') UI.botTabs = null; // loaded bot lists live only while you stay on the Bot page
  const views = {
    dashboard: viewDashboard, games: viewGames, game: () => viewGame(id),
    players: viewPlayers, player: () => viewPlayer(id), data: viewData, settings: viewSettings, bot: viewBot,
    me: () => { const u = Store.user(); if (u && u.playerId) viewPlayer(u.playerId); else viewDashboard(); },
    'login-error': () => { $app.innerHTML = `<div class="empty"><h2>Login didn't work</h2><p>${h(decodeURIComponent(id || ''))}</p><p><a class="btn" href="/api/auth/telegram/start">Try again</a></p></div>`; },
  };
  (views[view] || viewDashboard)();
}
let currentPath = location.pathname;
/** Leaving a game with unsaved changes asks first. Returns false if the person wants to stay. */
function confirmLeave(path) {
  const stillHere = UI.draft && path === UI.draft.path;
  if (!stillHere && gameDirty() && !confirm(UI.draft.id === 'new' ? 'This new game is not saved yet. Leave and discard it?' : 'You have unsaved changes in this game. Leave without saving?')) return false;
  if (!stillHere && UI.draft) { UI.draft = null; renderSaveBar(); }
  return true;
}
/** In-app navigation without reloading the page. */
function go(path, { replace = false } = {}) {
  if (path !== location.pathname && !confirmLeave(path)) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  currentPath = location.pathname;
  route();
  if (!replace) window.scrollTo(0, 0);
}
// Internal links (<a href="/...">) are handled here instead of reloading the page
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
  const href = a.getAttribute('href');
  if (href.startsWith('/api/') || href.startsWith('//')) return;
  e.preventDefault();
  go(href);
});
window.addEventListener('popstate', () => {
  if (location.pathname === currentPath) return;
  if (!confirmLeave(location.pathname)) { history.pushState(null, '', currentPath); return; }
  currentPath = location.pathname;
  route();
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
  { key: 'rating', label: 'Rating', get: p => p.rating, title: 'Win rate adjusted for number of games (see the note below the table)' },
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
          <a class="btn primary" href="/games">Record a game</a>
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
  // Recent games = the last game day only (all its finished games, in order)
  const finishedGames = Store.sortedGames().filter(g => g.winner);
  const lastDay = finishedGames.length ? finishedGames[0].date : null;
  const recent = finishedGames.filter(g => g.date === lastDay).sort((a, b) => a.number - b.number);

  $app.innerHTML = `
    <div class="page-head"><h1>Dashboard</h1>${Store.canEdit() ? '<a class="btn primary" href="/games">+ Record a game</a>' : ''}</div>

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
              ? `<a class="title-holder" href="${playerHref(t.player)}">${h(t.player.name)}</a><div class="title-detail">${h(t.detail)}</div>`
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
                <td><a href="${playerHref(p)}">${h(p.name)}</a></td>
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
      <p class="muted small"><b>No.</b> = player number in order of joining (new players get the next number). <b>Rating</b> = win rate adjusted for number of games: (wins + ${st.K} × ${pct(st.overallRate)}) ÷ (games + ${st.K}), so few games stay close to the average.
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
                <div class="bar-row"><a href="${playerHref(p)}">${h(p.name)}</a>${bar(p.roleRating[r], 1, 'role-' + r)}<span class="num">${pct(p.roleRating[r])} <span class="muted">${p.byRole[r].w}/${p.byRole[r].g}</span></span></div>`).join('')
                : '<p class="muted small">No games yet.</p>'}
            </div>`;
          }).join('')}
        </div>
      </section>

      <section class="card">
        <h2>Attendance</h2>
        <p class="muted small">Games played (and number of game days).</p>
        ${[...st.players].sort((a, b) => b.games - a.games || b.days - a.days).slice(0, 30).map(p => `
          <div class="bar-row"><a href="${playerHref(p)}">${h(p.name)}</a>${bar(p.games, maxGames, 'accent')}<span class="num">${p.games} <span class="muted">· ${p.days}d</span></span></div>`).join('')}
      </section>
    </div>

    <h2 class="section-title">Last game day <span class="muted small">· ${fmtDate(lastDay)} · <a href="/games">all games</a></span></h2>
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
  return `<a class="game-row" href="${gameHref(g)}">
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
/** Start the next game of the same day with the same players in the same seats (roles empty). Draft only. */
function draftNextGame(src) {
  const g = Store.draftGame(src.date, src.seats.length);
  g.seats.forEach((s, i) => { s.playerId = src.seats[i] ? src.seats[i].playerId : null; });
  UI.draft = { id: 'new', g, base: JSON.stringify(g), path: '/game/new' };
  go('/game/new');
  toast(`Game #${g.number}: same players, now set the roles`);
}

function viewGames() {
  const games = Store.sortedGames();
  const groups = {};
  games.forEach(g => (groups[g.date] ||= []).push(g));

  $app.innerHTML = `
    <div class="page-head">
      <h1>Games <span class="muted">· ${games.length}</span></h1>
      ${Store.canEdit() ? `<div class="row gap wrap">
        ${dateField(localToday(), 'id="newDate" aria-label="Game date"')}
        <label class="field inline"><span>Players</span><select id="newSeats">${seatOptions().map(n => `<option ${n === (+Store.get().settings.defaultSeats || 10) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <button class="btn primary" id="newGame">+ New game</button>
      </div>` : ''}
    </div>
    ${games.length ? Object.entries(groups).map(([date, list]) => `
      <section class="card">
        <div class="section-head"><h3>${fmtDate(date)} <span class="muted">· ${list.length} game${list.length > 1 ? 's' : ''}</span></h3>
          ${Store.canEdit() ? `<button class="btn small ghost icon-btn" data-next-day="${date}" title="Next game on this day with the same players (saved only when you press Save changes)" aria-label="Next game, same players">⧉</button>` : ''}</div>
        <div class="game-list">${list.sort((a, b) => a.number - b.number).map(gameRow).join('')}</div>
      </section>`).join('')
      : `<div class="empty">No games yet.</div>`}
  `;
  wireDateFields($app);
  $$('[data-next-day]').forEach(b => b.onclick = () => {
    const last = games.filter(g => g.date === b.dataset.nextDay).sort((a, b2) => b2.number - a.number)[0];
    if (last) draftNextGame(last);
  });
  if ($('#newGame')) $('#newGame').onclick = () => attempt(async () => {
    const date = dmyToIso($('#newDate').value);
    if (!date) { toast('Enter the date as DD/MM/YYYY'); $('#newDate').focus(); return; }
    // Nothing is stored yet: the game is created on its first "Save changes"
    const g = Store.draftGame(date, +$('#newSeats').value);
    UI.draft = { id: 'new', g, base: JSON.stringify(g), path: '/game/new' };
    go('/game/new');
  }).finally(() => { if ($('#newGame')) $('#newGame').disabled = false; });
}

/* ============================================================
   GAME SCREEN — editor for the admin (and in local mode), read-only otherwise
   ============================================================ */
function viewGame(id) {
  const isNew = id === 'new';
  const orig = isNew ? (UI.draft && UI.draft.id === 'new' && Store.canEdit() ? UI.draft.g : null) : Store.game(id);
  if (!orig) { $app.innerHTML = `<div class="empty">Game not found. <a href="/games">Back to games</a></div>`; return; }
  const ro = !Store.canEdit();
  // Editing works on a draft copy; nothing is stored until "Save changes".
  if (!ro && (!UI.draft || UI.draft.id !== orig.id)) UI.draft = { id: orig.id, g: JSON.parse(JSON.stringify(orig)), base: JSON.stringify(orig), path: location.pathname };
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
  const outcome = ro ? null : GameLogic.outcome(g);
  const suggested = outcome && outcome.winner;
  const has = r => GameLogic.hasRole(g, r);

  const seatRows = g.seats.map(s => {
    const alive = tl.alive.includes(s.seat);
    const f = alive ? null : tl.fates[s.seat];
    return `<tr class="${alive ? '' : 'dead'}">
      <td class="seatno">${s.seat}</td>
      <td>${ro ? (s.playerId ? `<a href="${playerHref(s.playerId)}">${h(name(s.seat))}</a>` : '—') : `<select data-act="seat-player" data-seat="${s.seat}" class="${s.playerId && used[s.playerId] > 1 ? 'bad' : ''}">
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
      // Once the role is out, its night action disappears (an old value stays visible with a note)
      const canAct = GameLogic.canAct(g, field, nightAlive);
      if (!show || (!canAct && !nt[field])) return '';
      const outNote = canAct ? '' : ' <span class="chip warn">role is out: ignored</span>';
      if (ro) {
        if (!nt[field]) return '';
        return `<div class="night-ro"><span class="lbl">${label}</span> <b>${h(lbl(nt[field]))}</b> ${kind ? checkResult(nt[field], kind) : ''}${outNote}${field === 'doctorHeal' && (nt.doctorHeal === nt.mafiaKill || nt.doctorHeal === nt.maniacKill) ? ' <span class="chip win">saved!</span>' : ''}</div>`;
      }
      return `<label class="field"><span>${label}</span>
        <select data-act="night" data-field="${field}" data-round="${i}">${seatOpts(nightAlive, nt[field], field.endsWith('Kill') ? 'miss / none' : '—')}</select>
        ${kind ? checkResult(nt[field], kind) : ''}${outNote}
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
        <a href="/games" class="back">← Games</a>
        <h1>Game #${g.number} <span class="muted">· ${fmtDate(g.date)} · overall #${Store.overallNumber(g)}</span></h1>
        <div class="row gap wrap">${isNew ? '<span class="chip warn">New — not saved yet</span>' : winnerChip(g.winner)}${imported ? '<span class="chip muted">imported from spreadsheet</span>' : ''}</div>
      </div>
      ${ro ? '' : `<div class="row gap wrap">
        ${!isNew ? '<button class="btn icon-btn" id="nextSameBtn" title="Next game on this day with the same players (saved only when you press Save changes)" aria-label="Next game, same players">⧉</button>' : ''}
        ${Store.isAdmin() && orig.winner && !isNew ? '<button class="btn" id="publishBtn" title="Prepare a summary post for the Telegram group">📣 Publish to Telegram</button>' : ''}
        <label class="field inline"><span>Date</span>${dateField(g.date, 'data-act="date"')}</label>
        <label class="field inline"><span>Game #</span><input type="number" min="1" data-act="number" value="${g.number}" class="num-input"></label>
        <button class="btn danger" data-act="del-game">Delete</button>
      </div>`}
    </div>

    <section class="card">
      <div class="section-head">
        <h2>Seats & roles</h2>
        ${ro ? '' : `<div class="row gap wrap">
          <label class="field inline"><span>Players</span><select data-act="seat-count">${seatOptions().map(n => `<option ${n === g.seats.length ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
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
      ${suggested && suggested !== g.winner ? `<p class="hint">By the rules it looks like <b>${TEAM_LABEL[suggested]}</b> won <span class="muted">(${h(outcome.reason)})</span>. <button class="btn small" data-act="winner" data-val="${suggested}">Set ${TEAM_LABEL[suggested]} as winner</button></p>` : ''}
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
      case 'winner': g.winner = el.dataset.val || null; break; // stored with Save changes, like everything else
      case 'notes': g.notes = el.value; renderSaveBar(); return;
      case 'date': {
        const iso = dmyToIso(el.value);
        if (!iso) { toast('Enter the date as DD/MM/YYYY'); el.value = isoToDmy(g.date); return; }
        g.date = iso;
        break;
      }
      case 'number': g.number = Math.max(1, +el.value || 1); break;
      case 'del-game':
        if (isNew) {
          if (!confirm('Discard this new game? Nothing has been saved yet.')) return;
          UI.draft = null; renderSaveBar(); go('/games');
          return;
        }
        if (!confirm('Delete this game permanently?')) return;
        if (await attempt(() => Store.deleteGame(id).then(() => true))) { UI.draft = null; go('/games'); }
        return;
    }
    commit();
  }

  wireDateFields($app);
  $$('[data-act]').forEach(el => {
    const evt = el.tagName === 'BUTTON' ? 'click' : 'change';
    el.addEventListener(evt, () => handle(el.dataset.act, el));
  });
  $('#qaName').addEventListener('keydown', e => { if (e.key === 'Enter') handle('quick-add', e.target); });
  if ($('#nextSameBtn')) $('#nextSameBtn').onclick = () => {
    if (gameDirty()) { toast('Save your changes first'); return; }
    draftNextGame(orig);
  };
  if ($('#publishBtn')) $('#publishBtn').onclick = () => {
    if (gameDirty()) { toast('Save your changes first'); return; }
    UI.botDraft = { text: gameSummaryText(orig), kind: 'game', gameId: orig.id, audience: 'group' };
    go('/bot');
  };
  $$('textarea[data-act="notes"], input[data-act="nom-votes"]').forEach(el => el.addEventListener('input', () => handle(el.dataset.act, el)));
}

/* ---------- unsaved changes: bar, summary, save/discard ---------- */
function gameDirty() { return !!(UI.draft && (UI.draft.id === 'new' || JSON.stringify(UI.draft.g) !== UI.draft.base)); }

function changeSummary(base, g) {
  const out = [];
  const label = w => (w ? TEAM_LABEL[w] + ' won' : 'not finished');
  if (base.date !== g.date) out.push(`Date: ${isoToDmy(base.date)} → ${isoToDmy(g.date)}`);
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
  const isNew = UI.draft.id === 'new';
  const changes = isNew ? ['nothing is stored until you save'] : changeSummary(JSON.parse(UI.draft.base), UI.draft.g);
  bar.innerHTML = `<div class="savebar-inner">
      <span class="dot"></span><b>${isNew ? 'New game' : 'Unsaved changes'}</b><span class="muted small">${isNew ? '' : `${changes.length} change${changes.length === 1 ? '' : 's'}: `}${h(changes.slice(0, 3).join(' · '))}${changes.length > 3 ? ' …' : ''}</span>
      <span class="spacer"></span>
      <button class="btn ghost small" id="discardBtn">Discard</button>
      <button class="btn primary" id="saveBtn">Save changes</button>
    </div>`;
  document.getElementById('discardBtn').onclick = () => {
    if (!confirm(isNew ? 'Discard this new game? Nothing has been saved yet.' : 'Discard all unsaved changes in this game?')) return;
    const id = UI.draft.id;
    UI.draft = null;
    renderSaveBar();
    if (id === 'new') go('/games'); else viewGame(id);
  };
  document.getElementById('saveBtn').onclick = async () => {
    const dg = UI.draft.g;
    if (isNew) {
      const filled = dg.seats.filter(x => x.playerId).length;
      if (!confirm(`Save new Game #${dg.number} (${isoToDmy(dg.date)})?\n\n${filled} of ${dg.seats.length} seats filled · ${dg.rounds.length} round(s) · ${dg.winner ? TEAM_LABEL[dg.winner] + ' won' : 'not finished'}`)) return;
    } else {
      const list = changeSummary(JSON.parse(UI.draft.base), dg);
      const text = list.slice(0, 15).map(x => '• ' + x).join('\n') + (list.length > 15 ? `\n… and ${list.length - 15} more` : '');
      if (!confirm(`Save these changes to Game #${dg.number} (${isoToDmy(dg.date)})?\n\n${text}`)) return;
    }
    const btn = document.getElementById('saveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    const saved = await attempt(() => Store.saveGame(UI.draft.g));
    if (saved) {
      // The address follows the date and game number (they may have changed, or the game is new)
      const href = gameHref(saved);
      if (location.pathname !== href) { history.replaceState(null, '', href); currentPath = href; }
      UI.draft = { id: saved.id, g: JSON.parse(JSON.stringify(saved)), base: JSON.stringify(saved), path: href };
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
      <td><a href="${playerHref(p)}">${h(p.nickname)}</a></td>
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
          <td>${String(a.id) === String((Store.user() || {}).accountId)
            ? '<span class="chip admin" title="Your own admin role can\'t be removed here (protection against locking yourself out)">admin · you</span>'
            : `<select data-acc-role="${a.id}"><option value="player" ${a.role === 'player' ? 'selected' : ''}>player</option><option value="admin" ${a.role === 'admin' ? 'selected' : ''}>admin</option></select>`}</td>
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
  // Changes to logins apply at once, so each one asks first; Cancel puts the old value back.
  const accName = id => { const a = accounts.find(x => String(x.id) === String(id)) || {}; return a.username ? '@' + a.username : (a.display_name || 'this login'); };
  $$('[data-acc-player]').forEach(s => s.onchange = () => {
    const to = s.value ? Store.playerName(s.value) : null;
    if (!confirm(to ? `Link ${accName(s.dataset.accPlayer)} to player ${to}?\n\nThey will see "${to}" as their own stats (/mystats, My stats). You can change it back here.` : `Unlink ${accName(s.dataset.accPlayer)} from its player?`)) { viewPlayers(); return; }
    attempt(async () => { await Store.updateAccount(s.dataset.accPlayer, { player_id: s.value || null }); toast('Saved'); viewPlayers(); });
  });
  $$('[data-acc-role]').forEach(s => s.onchange = () => {
    const msg = s.value === 'admin'
      ? `Make ${accName(s.dataset.accRole)} an ADMIN?\n\nAdmins can edit and delete games, players, settings and send bot messages.`
      : `Remove admin rights from ${accName(s.dataset.accRole)}?`;
    if (!confirm(msg)) { viewPlayers(); return; }
    attempt(async () => { await Store.updateAccount(s.dataset.accRole, { role: s.value }); toast('Saved'); viewPlayers(); });
  });
}

/* ---------- player profile ("My stats") ---------- */
function viewPlayer(id) {
  const p0 = Store.player(id);
  if (!p0) { $app.innerHTML = `<div class="empty">Player not found. <a href="/players">Back</a></div>`; return; }
  const st = Stats.compute(Store.get());
  const p = st.players.find(x => x.id === p0.id);
  const ranked = [...st.players].sort((a, b) => b.rating - a.rating);
  const rank = ranked.findIndex(x => x.id === p0.id) + 1;
  const mine = Store.user() && Store.user().playerId === p0.id;

  const head = `
    <div class="page-head">
      <div><a href="/players" class="back">← Players</a><h1>${h(p0.nickname)} <span class="muted">No. ${p0.number}</span>${mine ? ' <span class="chip win">you</span>' : ''}</h1></div>
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
                <td><a href="${Store.game(x.gameId) ? gameHref(Store.game(x.gameId)) : '/games'}">#${x.number}</a></td>
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
    <div class="grid-2 cols-2">
      <section class="card">
        <h2>Backup</h2>
        <p class="muted small">${db.players.length} players · ${db.games.length} games</p>
        <div class="row gap wrap">
          ${Store.isAdmin() ? '<button class="btn primary" id="fullBackup">⬇ Full backup (private, JSON)</button>' : ''}
          ${Store.isAdmin() ? '' : '<button class="btn primary" id="exportJson">⬇ Download JSON</button>'}
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
      ${Store.isAdmin() ? `<section class="card wide">
        <h2>Backups in Cloudflare</h2>
        <p class="muted small">Every Sunday at 09:00 (08:00 in winter) a full backup is stored automatically; the last 12 are kept, plus the last 5 manual ones. You get a Telegram message each time.</p>
        <div class="row gap wrap">
          <button class="btn" id="backupNow">Back up now</button>
        </div>
        <div id="backupList" class="backup-list"><div class="row gap wrap"><span class="muted small">The list is not loaded yet.</span><button class="btn small" id="loadBackups">Show backups</button></div></div>
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
  if ($('#exportJson')) $('#exportJson').onclick = () => download(`mafia-bcn-${live ? 'public' : 'local'}-${stamp}.json`, JSON.stringify(Store.get(), null, 2), 'application/json');
  $('#csvSemi').onclick = () => download(`mafia-bcn-${stamp}.csv`, toCSV(Store.get(), ';'), 'text/csv;charset=utf-8');
  $('#csvComma').onclick = () => download(`mafia-bcn-${stamp}.csv`, toCSV(Store.get(), ','), 'text/csv;charset=utf-8');
  if (Store.isAdmin()) {
    const renderBackups = async () => {
      const box = $('#backupList');
      const res = await attempt(() => Store.listBackups());
      if (!res || !box) return;
      box.innerHTML = `<div class="row gap"><span class="spacer"></span><button class="btn small ghost" id="refreshBackups">↻ Refresh</button></div>` + (res.backups.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Games</th><th>Players</th><th>Size</th><th></th></tr></thead><tbody>${res.backups.map(b => `
        <tr><td>${h(new Date(b.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</td><td>${h(b.kind)}</td><td>${b.games}</td><td>${b.players}</td><td>${Math.round(b.size / 1024)} KB</td>
        <td class="actions"><button class="btn small" data-dl="${h(b.name)}">⬇ Download</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted small">No backups yet — the first weekly one runs on Sunday, or press “Back up now”.</p>');
      $('#refreshBackups').onclick = renderBackups;
      $$('[data-dl]').forEach(btn => btn.onclick = () => attempt(async () => {
        const r = await fetch('/api/admin/backups/' + encodeURIComponent(btn.dataset.dl), { credentials: 'same-origin' });
        if (!r.ok) throw new Error('Download failed (' + r.status + ')');
        await saveFile(`mafia-bcn-backup-${btn.dataset.dl}.json`, await r.text());
      }));
    };
    // The list is loaded only on request (saves a storage read every time the page opens)
    $('#loadBackups').onclick = renderBackups;
    $('#backupNow').onclick = () => attempt(async () => { const b = await Store.backupNow(); toast(`Backup saved (${b.games} games, ${Math.round(b.size / 1024)} KB)`); if (!$('#loadBackups')) renderBackups(); });
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
          <label class="field"><span>Seats in a new game</span><input type="number" min="${SEATS_MIN}" max="${SEATS_MAX}" name="defaultSeats" value="${s.defaultSeats}" ${dis}></label>
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
      defaultSeats: Math.min(SEATS_MAX, Math.max(SEATS_MIN, +f.defaultSeats.value || 10)),
    };
    if (!confirm(`Save settings?\n\nK = ${patch.priorWeight}, min games for King = ${patch.minGames}, seats in a new game = ${patch.defaultSeats}`)) return;
    attempt(async () => { await Store.saveSettings(patch); toast('Settings saved'); viewSettings(); });
  };
}

/* ============================================================
   BOT — posts to the Telegram group / subscribers, history with edit & delete
   ============================================================ */
/* Telegram texts are in Ukrainian (the site itself stays in English). */
const UK_ROLE_LINES = [['don', 'Дон'], ['mafia', 'Мафія'], ['sheriff', 'Шериф'], ['doctor', 'Лікар'], ['maniac', 'Маніяк'], ['citizen', 'Мирні']];
/** One game as text lines: header with the result circle, then players by role. Reused by the day stats post. */
function gameBlockUk(g) {
  const result = g.winner === 'town' ? 'перемога мирних 🔴' : g.winner === 'mafia' ? 'перемога мафії ⚫' : 'не завершена';
  const lines = [`Гра #${g.number} — ${result}`];
  for (const [role, label] of UK_ROLE_LINES) {
    const names = g.seats.filter(s => s.role === role && s.playerId).map(s => Store.playerName(s.playerId));
    if (names.length) lines.push(`${label}: ${names.join(', ')}`);
  }
  return lines;
}
function gameSummaryText(g) {
  return [
    `Mafia BCN · ${isoToDmy(g.date)}`,
    '',
    ...gameBlockUk(g),
    '',
    `Деталі гри: ${location.origin}${gameHref(g)}`,
  ].join('\n');
}

/** All finished games of one day as a Telegram post (the agreed "day stats" format). */
function dayStatsText(date) {
  const db = Store.get();
  const games = db.games.filter(g => g.date === date && g.winner).sort((a, b) => a.number - b.number);
  if (!games.length) return '';
  const town = games.filter(g => g.winner === 'town').length;
  const out = [`Mafia BCN · ${isoToDmy(date)}`, `Ігор: ${games.length} · Мирні ${town} : ${games.length - town} Мафія`, ''];
  games.forEach(g => out.push(...gameBlockUk(g), ''));

  // Best players of the day: everyone who won all their games that day
  const day = {};
  games.forEach(g => g.seats.forEach(s => {
    if (!s.playerId || !s.role) return;
    const d = (day[s.playerId] ||= { g: 0, w: 0 });
    d.g++; if (ROLES[s.role].team === g.winner) d.w++;
  }));
  const best = Object.entries(day).filter(([, d]) => d.w === d.g).sort((a, b) => b[1].g - a[1].g);
  if (best.length) out.push('Найкращі гравці дня (100% перемог)', best.map(([id, d]) => `${Store.playerName(id)} ${d.w}/${d.g}`).join(' · '), '');

  // Rating before this day vs after it (later games are left out, so an old day reads the same later)
  const before = Stats.compute({ ...db, games: db.games.filter(g => g.date < date) });
  const after = Stats.compute({ ...db, games: db.games.filter(g => g.date <= date) });
  const was = Object.fromEntries(before.players.map(p => [p.id, p]));
  const pts = x => Math.round(x * 100);
  const moves = after.players.filter(p => day[p.id] && was[p.id]).map(p => ({ p, from: pts(was[p.id].rating), to: pts(p.rating) }))
    .map(m => ({ ...m, d: m.to - m.from })).filter(m => m.d !== 0);
  const ups = moves.filter(m => m.d > 0).sort((a, b) => b.d - a.d).slice(0, 3);
  const downs = moves.filter(m => m.d < 0).sort((a, b) => a.d - b.d).slice(0, 3);
  const newbies = after.players.filter(p => day[p.id] && !was[p.id]);
  if (ups.length || downs.length || newbies.length) {
    out.push('Зміна рейтингу');
    [...ups, ...downs].forEach(m => out.push(`${m.p.name}: ${m.from}% → ${m.to}% (${m.d > 0 ? '+' : '−'}${Math.abs(m.d)})`));
    if (newbies.length) out.push(`Нові гравці: ${newbies.map(p => `${p.name} ${pts(p.rating)}%`).join(', ')}`);
    out.push('');
  }

  // Top 5 among players with enough games, with places gained/lost since before the day
  const minG = +db.settings.minGames || 3;
  const rank = st => st.players.filter(p => p.games >= minG).sort((a, b) => b.rating - a.rating);
  const oldPlace = Object.fromEntries(rank(before).map((p, i) => [p.id, i + 1]));
  const top = rank(after).slice(0, 5);
  if (top.length) {
    out.push(`Топ-5 (від ${minG} ігор)`);
    top.forEach((p, i) => {
      const o = oldPlace[p.id];
      const mark = !o ? ' нов.' : o > i + 1 ? ` ↑${o - i - 1}` : o < i + 1 ? ` ↓${i + 1 - o}` : '';
      out.push(`${i + 1}. ${p.name} — ${pts(p.rating)}%${mark}`);
    });
    out.push('');
  }
  out.push(`Уся статистика: ${location.origin}`, 'Твоя статистика: /mystats у @mafia_bcn_bot');
  return out.join('\n');
}

/* Post templates (Ukrainian). `day` is the game day picked next to the templates. */
const BOT_TEMPLATES = [
  { key: 'day', label: 'Day stats', kind: 'day', make: day => dayStatsText(day) || null },
  { key: 'last', label: 'Last game', kind: 'game', make: () => { const g = Store.sortedGames().find(x => x.winner); return g ? gameSummaryText(g) : null; } },
  { key: 'announce', label: 'Game night', kind: 'announcement', make: () => `🎭 Mafia BCN — у неділю о 19:00\n📍 Місце: …\n\nХто з нами? Відповідайте тут 👇` },
  { key: 'reminder', label: 'Reminder', kind: 'announcement', make: () => `⏰ Нагадування: сьогодні граємо в Мафію!\n🕖 Початок о 19:00\n📍 Місце: …\n\nЯкщо не зможете прийти, напишіть, будь ласка 🙏` },
  { key: 'mystats', label: '/mystats how-to', kind: 'update', make: () => `📊 Новинка: ваша особиста статистика в нашому боті!\n\n1. Відкрийте @mafia_bcn_bot і натисніть Start\n2. Надішліть /mystats — бот покаже ваші ігри, перемоги, рейтинг і місце\n\nЯкщо бот пише, що ви ще не прив'язані, напишіть мені (@voorest), і я прив'яжу ваш Telegram до вашого гравця.\n\n🌐 ${location.origin}` },
  { key: 'welcome', label: 'Welcome', kind: 'personal', make: () => `👋 Вітаємо в Mafia BCN!\n\nУся статистика наших ігор: ${location.origin}\nВаша особиста статистика: /mystats у @mafia_bcn_bot (натисніть Start)\n\nДо зустрічі за столом! 🎭` },
  { key: 'update', label: 'Site update', kind: 'update', make: () => `🆕 Оновлення сайту\n\n• …\n\n🌐 ${location.origin}` },
];
const BOT_KINDS = { announcement: 'Announcement', game: 'Game summary', day: 'Day stats', update: 'Update', personal: 'Personal' };
const BOT_COMMANDS = [
  { cmd: '/start', desc: 'Subscribe to announcements; links the player by @username' },
  { cmd: '/mystats', desc: 'Personal stats (linked players only)' },
  { cmd: '/help', desc: 'What the bot can do' },
  { cmd: '/stop', desc: 'Stop announcements' },
];

/* Bot page. The top part (status, commands, new post) loads at once; History and
   "Who receives messages" load only when asked and stay in memory until you leave the page. */
async function viewBot({ refresh = false } = {}) {
  const T = (UI.botTabs ||= { active: 'history', history: null, chats: null });
  // Status and command previews are kept for the whole visit to the site (until the page is reloaded);
  // they are fetched again only with ↻ or when the data changed.
  const C = (UI.botCache ||= { status: null, preview: {} });
  if (refresh || !C.status) {
    $app.innerHTML = '<div class="empty">Loading bot…</div>';
    C.status = await attempt(() => Store.bot.status());
  }
  const st = C.status;
  if (!st) { $app.innerHTML = '<div class="empty">Could not load the bot status.</div>'; return; }
  const connected = st.webhook && st.webhook.url === st.expectedUrl;
  const draft = UI.botDraft || {};
  const db = Store.get();
  const players = [...db.players].sort((a, b) => a.nickname.localeCompare(b.nickname));
  const days = [...new Set(db.games.filter(g => g.winner).map(g => g.date))].sort().reverse();

  $app.innerHTML = `
    <div class="page-head"><h1>Bot <span class="muted">@mafia_bcn_bot</span></h1></div>

    <div class="grid-2 cols-2">
      <section class="card">
        <h2>Status</h2>
        ${!st.tokenSet ? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)
            ? '<p class="muted">Local copy: the bot token lives only in Cloudflare, so the bot works only on the live site. This is expected.</p>'
            : '<p class="warn-text">TELEGRAM_BOT_TOKEN is not set in Cloudflare.</p>') : connected
          ? `<p><span class="chip win">Connected</span> The bot receives commands and group invites.</p>`
          : `<p><span class="chip warn">Not connected</span> Press the button once (on the live site) so the bot can receive commands.</p>`}
        ${st.webhook && st.webhook.lastError ? `<p class="muted small">Last Telegram error: ${h(st.webhook.lastError)}</p>` : ''}
        <div class="row gap wrap"><button class="btn ${connected ? 'ghost' : 'primary'}" id="botSetup">${connected ? 'Reconnect' : 'Connect bot'}</button><button class="btn ghost" id="statusRefresh" title="Check the status again">↻ Refresh</button></div>
        <p class="muted small mt">Receive messages: <b>${st.subscribers}</b> ${st.subscribers === 1 ? 'person' : 'people'} who pressed Start.</p>
        <h3 class="mt">Groups</h3>
        ${st.groups.length ? st.groups.map(c => `<div class="row gap"><span class="chip">${h(c.title || c.chat_id)}</span><span class="muted small">${c.type}</span></div>`).join('')
          : '<p class="muted small">Not in any group yet. In Telegram open your group → Add members → search <b>@mafia_bcn_bot</b> → add. It then appears here (the bot must be connected first).</p>'}
      </section>

      <section class="card">
        <h2>Commands</h2>
        <p class="muted small">What players can send to the bot. Preview the answer as any player; nothing is sent.</p>
        <div class="cmd-list">${BOT_COMMANDS.map(c => `<button class="cmd ${c.cmd === (UI.botCmd || '/mystats') ? 'on' : ''}" data-cmd="${c.cmd}"><code>${c.cmd}</code><span class="muted small">${h(c.desc)}</span></button>`).join('')}</div>
        <label class="field"><span>As player</span>
          <select id="cmdPlayer">
            <option value="">Someone not linked yet</option>
            ${players.map(p => `<option value="${p.id}" ${p.id === UI.botCmdPlayer ? 'selected' : ''}>${h(p.nickname)} (No. ${p.number})</option>`).join('')}
          </select>
        </label>
        <div class="tg-preview" id="cmdPreview"></div>
      </section>

      <section class="card wide">
        <h2>New post</h2>
        <div class="row gap wrap">
          <label class="field"><span>Send to</span>
            <select id="botAudience">
              ${st.groups.map(c => `<option value="group:${h(c.chat_id)}" ${draft.audience === 'group' ? 'selected' : ''}>Group: ${h(c.title || c.chat_id)}</option>`).join('')}
              <option value="subscribers" ${draft.audience === 'subscribers' ? 'selected' : ''}>Everyone who started the bot (${st.subscribers})</option>
              <option value="person" ${draft.audience === 'person' ? 'selected' : ''}>One person…</option>
              <option value="admins" ${draft.audience === 'admins' ? 'selected' : ''}>Admins only (test)</option>
            </select>
          </label>
          <label class="field" id="personField" hidden><span>Person</span><select id="botPerson"><option value="">Loading…</option></select></label>
          <label class="field"><span>Type</span>
            <select id="botKind">${Object.entries(BOT_KINDS).map(([k, l]) => `<option value="${k}" ${draft.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          </label>
        </div>
        <div class="row gap wrap tpl-row">
          <span class="lbl">Templates</span>
          ${BOT_TEMPLATES.map(t => `<button class="btn small ghost" data-tpl="${t.key}">${t.label}</button>`).join('')}
          <label class="field inline"><span>Game day</span><select id="tplDay">${days.map(d => `<option value="${d}">${isoToDmy(d)}</option>`).join('') || '<option value="">—</option>'}</select></label>
        </div>
        <textarea id="botText" rows="12" maxlength="4000" placeholder="Write your message… (plain text, emojis welcome)">${h(draft.text || '')}</textarea>
        <div class="row gap wrap"><span class="muted small" id="botCount"></span><span class="spacer"></span><button class="btn primary" id="botSend">Send</button></div>
      </section>
    </div>

    <div class="tabs" role="tablist">
      <button class="tab ${T.active === 'history' ? 'on' : ''}" data-tab="history">History</button>
      <button class="tab ${T.active === 'chats' ? 'on' : ''}" data-tab="chats">Who receives messages</button>
      <span class="spacer"></span>
      <button class="btn small ghost" id="tabRefresh" ${T[T.active] ? '' : 'hidden'}>↻ Refresh</button>
    </div>
    <div id="tabBody"></div>
  `;

  /* ---- commands preview ---- */
  // A preview is asked from the server once per command + player; saved games/players change the key, so stats stay right.
  const dataKey = () => { const d = Store.get(); return `${d.games.length}:${d.players.length}:${JSON.stringify(d.games).length}:${JSON.stringify(d.players).length}`; };
  const show = html => { if ($('#cmdPreview')) $('#cmdPreview').innerHTML = `<div class="tg-bubble">${html.replace(/\n/g, '<br>')}</div><div class="row"><span class="spacer"></span><button class="btn small ghost" id="cmdReload" title="Ask the server again">↻</button></div>`; if ($('#cmdReload')) $('#cmdReload').onclick = () => preview(true); };
  const preview = (force = false) => attempt(async () => {
    UI.botCmd = UI.botCmd || '/mystats';
    UI.botCmdPlayer = $('#cmdPlayer').value || null;
    const key = `${UI.botCmd}|${UI.botCmdPlayer || ''}|${dataKey()}`;
    if (!force && C.preview[key]) { show(C.preview[key]); return; }
    $('#cmdPreview').innerHTML = '<span class="muted small">Loading…</span>';
    const r = await Store.bot.preview(UI.botCmd, UI.botCmdPlayer);
    // the answer is our own HTML (names are escaped on the server); Telegram shows line breaks as-is
    C.preview[key] = r.html;
    show(r.html);
  });
  $$('[data-cmd]').forEach(b => b.onclick = () => { UI.botCmd = b.dataset.cmd; $$('[data-cmd]').forEach(x => x.classList.toggle('on', x === b)); preview(); });
  $('#cmdPlayer').onchange = () => preview();
  preview();   // served from memory when this command + player was already previewed

  /* ---- compose ---- */
  const text = $('#botText');
  const count = () => { $('#botCount').textContent = `${text.value.length} / 4000`; };
  text.oninput = count; count();
  const loadChats = async () => { if (!T.chats) T.chats = (await Store.bot.chats()).chats; return T.chats; };
  const syncAudience = () => attempt(async () => {
    const isPerson = $('#botAudience').value === 'person';
    $('#personField').hidden = !isPerson;
    if (!isPerson) return;
    const people = (await loadChats()).filter(c => c.status === 'active');
    $('#botPerson').innerHTML = people.length
      ? people.map(c => `<option value="${h(c.chat_id)}" ${c.chat_id === draft.chatId ? 'selected' : ''}>${h(c.nickname || c.title || c.chat_id)}${c.username ? ' @' + h(c.username) : ''}${c.nickname ? '' : ' (not linked)'}</option>`).join('')
      : '<option value="">Nobody has pressed Start yet</option>';
    if (T.active === 'chats') renderTab();
  });
  $('#botAudience').onchange = syncAudience;
  syncAudience();
  $$('[data-tpl]').forEach(b => b.onclick = () => {
    const t = BOT_TEMPLATES.find(x => x.key === b.dataset.tpl);
    const val = t.make($('#tplDay').value);
    if (!val) { toast('No finished games for this template yet'); return; }
    if (text.value.trim() && !confirm('Replace the current text with the template?')) return;
    text.value = val; count();
    $('#botKind').value = t.kind;
  });
  $('#botSetup').onclick = () => attempt(async () => { C.status = await Store.bot.setup(); toast('Bot connected'); viewBot(); });
  $('#statusRefresh').onclick = () => viewBot({ refresh: true });

  // sending happens in batches: keep asking the server until nothing is left
  const drain = async (id, label) => {
    let r = { remaining: 1 }, guard = 0;
    while (r.remaining > 0 && guard++ < 50) { r = await Store.bot.process(id); if (r.remaining) toast(`${label}… ${r.remaining} left`); }
  };
  const afterChange = async () => { if (T.history) { T.history = (await Store.bot.posts()).posts; if (T.active === 'history') renderTab(); } };
  $('#botSend').onclick = () => attempt(async () => {
    const val = $('#botAudience').value;
    if (!val) throw new Error('Choose who receives it');
    const [audience, chatId] = val.startsWith('group:') ? ['group', val.slice(6)] : val === 'person' ? ['person', $('#botPerson').value] : [val, null];
    if (audience === 'person' && !chatId) throw new Error('Choose the person');
    const who = audience === 'group' || audience === 'person'
      ? (audience === 'person' ? $('#botPerson') : $('#botAudience')).selectedOptions[0].textContent
      : audience === 'subscribers' ? `${st.subscribers} people who started the bot` : 'admins only';
    if (!text.value.trim()) throw new Error('The message is empty');
    if (!confirm(`Send this message to ${who}?`)) return;
    $('#botSend').disabled = true;
    const r = await Store.bot.send({ text: text.value, audience, chatId, kind: $('#botKind').value, gameId: draft.gameId || null });
    if (r.remaining) await drain(r.id, 'Sending');
    UI.botDraft = null;
    text.value = ''; count();
    toast('Sent');
    await afterChange();
  }).finally(() => { if ($('#botSend')) $('#botSend').disabled = false; });

  /* ---- tabs: History / Who receives messages ---- */
  const fmtWhen = t => t ? new Date(t.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const age = t => (Date.now() - new Date(t.replace(' ', 'T') + 'Z').getTime()) / 3600e3;
  const audienceLabel = p => p.audience === 'person' ? `To ${p.first_title || 'one person'}` : ({ group: 'Group', subscribers: 'Subscribers', admins: 'Admins' }[p.audience] || p.audience);
  const load = key => attempt(async () => {
    $('#tabBody').innerHTML = '<div class="card muted">Loading…</div>';
    if (key === 'history') T.history = (await Store.bot.posts()).posts;
    else T.chats = (await Store.bot.chats()).chats;
    renderTab();
  });
  function renderTab() {
    const key = T.active, data = T[key];
    $('#tabRefresh').hidden = !data;
    if (!data) {
      $('#tabBody').innerHTML = `<div class="card tab-empty"><p class="muted">${key === 'history' ? 'Sent posts, newest first.' : 'People who pressed Start in the bot.'} Not loaded yet.</p><button class="btn" id="tabLoad">Load ${key === 'history' ? 'history' : 'list'}</button></div>`;
      $('#tabLoad').onclick = () => load(key);
      return;
    }
    if (key === 'chats') {
      const active = data.filter(c => c.status === 'active').length;
      $('#tabBody').innerHTML = `<section class="card">
        <p class="muted small">${active} receive messages · only people who pressed <b>Start</b>. Linked players can use /mystats.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Telegram</th><th>Player</th><th>Since</th><th></th></tr></thead>
          <tbody>${data.map(c => `<tr class="${c.status === 'active' ? '' : 'dead'}">
            <td>${h(c.title || '')} ${c.username ? `<span class="muted">@${h(c.username)}</span>` : ''}</td>
            <td>${c.nickname ? h(c.nickname) : '<a href="/players" class="muted small">not linked</a>'}${c.role === 'admin' ? ' <span class="chip admin">admin</span>' : ''}</td>
            <td class="muted small">${h(isoToDmy((c.started_at || '').slice(0, 10)))}</td>
            <td class="muted small">${c.status === 'active' ? '' : 'stopped'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nobody yet.</td></tr>'}</tbody>
        </table></div></section>`;
      return;
    }
    $('#tabBody').innerHTML = data.length ? data.map(p => {
      const old = age(p.created_at) > 48;
      return `<section class="card post ${p.deleted_at ? 'deleted' : ''}" data-post="${p.id}">
        <div class="row gap wrap post-head">
          <b>${fmtWhen(p.created_at)}</b>
          <span class="chip">${h(audienceLabel(p))}</span>
          <span class="chip muted">${h(BOT_KINDS[p.kind] || p.kind)}</span>
          ${p.deleted_at ? '<span class="chip loss">deleted</span>' : ''}
          ${p.edited_at ? `<span class="muted small">edited ${fmtWhen(p.edited_at)}</span>` : ''}
          <span class="spacer"></span>
          <span class="muted small">✓ ${p.sent} sent${p.failed ? ` · ✗ ${p.failed} failed` : ''}${p.pending ? ` · ${p.pending} waiting` : ''}${p.deleted ? ` · 🗑 ${p.deleted}` : ''}</span>
        </div>
        <div class="post-text">${h(p.text)}</div>
        ${p.errors ? `<p class="muted small warn-text">${h(p.errors)}</p>` : ''}
        ${p.deleted_at ? '' : `<div class="row gap">
          ${p.pending ? `<button class="btn small" data-continue="${p.id}">Continue sending</button>` : ''}
          <button class="btn small ghost" data-edit-post="${p.id}">Edit</button>
          <button class="btn small ghost danger-text" data-del-post="${p.id}" ${old ? 'title="Telegram only allows deleting messages within 48 hours — it will be removed from this list, but may stay in Telegram"' : ''}>Delete${old ? ' (older than 48 h)' : ''}</button>
        </div>`}
      </section>`;
    }).join('') : '<div class="card muted">Nothing sent yet.</div>';

    $$('[data-continue]').forEach(b => b.onclick = () => attempt(async () => { await drain(+b.dataset.continue, 'Sending'); await afterChange(); }));
    $$('[data-edit-post]').forEach(b => b.onclick = () => {
      const card = b.closest('.post');
      const p = data.find(x => x.id === +b.dataset.editPost);
      card.querySelector('.post-text').outerHTML = `<textarea class="post-edit" rows="7" maxlength="4000">${h(p.text)}</textarea>`;
      b.outerHTML = `<button class="btn small primary" data-save-post="${p.id}">Save edit</button>`;
      card.querySelector('[data-save-post]').onclick = () => attempt(async () => {
        const t = card.querySelector('.post-edit').value;
        if (!confirm(`Update this message in Telegram (${p.sent} chat${p.sent === 1 ? '' : 's'})?`)) return;
        const r = await Store.bot.edit(p.id, t);
        if (r.remaining) await drain(p.id, 'Updating');
        toast('Updated');
        await afterChange();
      });
    });
    $$('[data-del-post]').forEach(b => b.onclick = () => attempt(async () => {
      const p = data.find(x => x.id === +b.dataset.delPost);
      if (!confirm(`Delete this message from Telegram (${p.sent} chat${p.sent === 1 ? '' : 's'})?`)) return;
      const r = await Store.bot.remove(p.id);
      if (r.remaining) await drain(p.id, 'Deleting');
      toast('Deleted');
      await afterChange();
    }));
  }
  $$('[data-tab]').forEach(b => b.onclick = () => {
    T.active = b.dataset.tab;
    $$('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
    renderTab();
  });
  $('#tabRefresh').onclick = () => load(T.active);
  renderTab();
}

/* ---------- start ---------- */
(async () => {
  $app.innerHTML = '<div class="empty">Loading…</div>';
  // Old links looked like /#/game/…; turn them into plain paths
  if (location.hash.startsWith('#/')) history.replaceState(null, '', (location.hash.slice(1) || '/') + location.search);
  currentPath = location.pathname;
  await Store.init();
  route();
})();
