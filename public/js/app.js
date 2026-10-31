/* ============================================================
   UI — tiny hash router + views
   /dashboard  /games  /game/DD-MM-YYYY/N  /game/new  /players  /player/:no  /compare/:a/:b  /data  /settings  /bot  /me
   Every visible text goes through t() (see i18n.js); Ukrainian words are in /js/lang/uk.js.
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
  return isNaN(dt) ? d : dt.toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
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
  return `<span class="date-field"><input type="text" inputmode="numeric" placeholder="${t('DD/MM/YYYY')}" maxlength="10" value="${isoToDmy(iso)}" ${attrs}>` +
    `<button type="button" class="date-pick" title="${t('Pick a date')}" tabindex="-1">📅</button><input type="date" class="date-native" tabindex="-1" aria-hidden="true" value="${iso}"></span>`;
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
/* Avatars: real photos only for logged-in people (served by /api/avatar), the default icon for everyone else.
   Sizes live in CSS: .ava = 32px (lists), .ava-lg = the player page. */
const HAT_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M13 58c2-12 9-18 19-18s17 6 19 18" fill="currentColor" opacity=".5"/><circle cx="32" cy="32" r="9.5" fill="currentColor" opacity=".5"/><path d="M14 25.5c5 1.6 31 1.6 36 0-1 2.4-3.5 3.6-6 3.6H20c-2.5 0-5-1.2-6-3.6z" fill="currentColor"/><path d="M21.5 25.5l2.2-10.2C24.5 12 26.7 11 32 11s7.5 1 8.3 4.3l2.2 10.2z" fill="currentColor"/><path d="M22.6 21h18.8l.6 3H22z" fill="var(--accent)"/></svg>';
function avatar(p, large = false) {
  const cls = large ? 'ava ava-lg' : 'ava';
  const pl = p && typeof p === 'object' ? p : Store.player(p);
  const g = pl ? (Store.player(pl.id) || pl).gender : null;
  const u = Store.user();   // photos are for members: the admin or a login linked to a player
  if (Store.isLive() && u && (u.role === 'admin' || u.playerId) && pl && pl.av) {
    return `<img class="${cls}" src="/api/avatar/${pl.number}?v=${pl.av}" alt="" loading="lazy" onerror="this.outerHTML=ICON_HTML('${cls}','${g || ''}')">`;
  }
  return ICON_HTML(cls, g);
}
/** Default picture: the man / woman icon when gender is set, otherwise the neutral hat. */
const ICON_EDIT = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const ICON_DELETE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function ICON_HTML(cls, g) {
  if (g === 'm' || g === 'f') return `<span class="${cls} ava-icon"><img src="/images/mafia-${g === 'm' ? 'man' : 'woman'}.svg" alt=""></span>`;
  return `<span class="${cls} ava-hat">${HAT_SVG}</span>`;
}
const genderSelect = v => `<select name="gender" title="${t('Picks the default icon when there is no photo')}">
  <option value="">${t('— gender —')}</option><option value="m"${v === 'm' ? ' selected' : ''}>${t('Man')}</option><option value="f"${v === 'f' ? ' selected' : ''}>${t('Woman')}</option></select>`;

/** Pick a picture, let the person move/zoom a square crop, return a ~320×320 data URL (WebP, or JPEG). */
function pickAndCropPhoto() {
  return new Promise(resolve => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return resolve(null);
      const img = new Image();
      img.onload = () => {
        const V = 280, OUT = 320;                       // view size on screen, saved size
        const dlg = document.createElement('div');
        dlg.className = 'modal';
        dlg.innerHTML = `<div class="modal-box"><h3>${t('Crop the photo')}</h3>
          <canvas width="${V}" height="${V}" class="crop"></canvas>
          <label class="field"><span>${t('Zoom')}</span><input type="range" min="1" max="4" step="0.01" value="1"></label>
          <p class="muted small">${t('Drag the picture to move it.')}</p>
          <div class="row gap"><span class="spacer"></span><button class="btn ghost" data-x="cancel">${t('Cancel')}</button><button class="btn primary" data-x="save">${t('Save photo')}</button></div></div>`;
        document.body.appendChild(dlg);
        const cv = dlg.querySelector('canvas'), ctx = cv.getContext('2d'), zoom = dlg.querySelector('input');
        const base = V / Math.min(img.width, img.height);   // "cover" scale at zoom 1
        let z = 1, x = 0, y = 0;                             // offset of the picture centre from the view centre
        const clamp = () => {
          const w = img.width * base * z, hgt = img.height * base * z;
          x = Math.max(-(w - V) / 2, Math.min((w - V) / 2, x));
          y = Math.max(-(hgt - V) / 2, Math.min((hgt - V) / 2, y));
        };
        const draw = (c, size) => {
          const k = size / V, w = img.width * base * z * k, hgt = img.height * base * z * k;
          c.clearRect(0, 0, size, size);
          c.drawImage(img, (size - w) / 2 + x * k, (size - hgt) / 2 + y * k, w, hgt);
        };
        const redraw = () => { clamp(); draw(ctx, V); };
        redraw();
        zoom.oninput = () => { z = +zoom.value; redraw(); };
        let drag = null;
        cv.onpointerdown = e => { drag = { sx: e.clientX, sy: e.clientY, x, y }; cv.setPointerCapture(e.pointerId); };
        cv.onpointermove = e => { if (!drag) return; x = drag.x + e.clientX - drag.sx; y = drag.y + e.clientY - drag.sy; redraw(); };
        cv.onpointerup = () => { drag = null; };
        const close = val => { dlg.remove(); URL.revokeObjectURL(img.src); resolve(val); };
        dlg.querySelector('[data-x="cancel"]').onclick = () => close(null);
        dlg.querySelector('[data-x="save"]').onclick = () => {
          const out = Object.assign(document.createElement('canvas'), { width: OUT, height: OUT });
          draw(out.getContext('2d'), OUT);
          let url = out.toDataURL('image/webp', 0.85);
          if (!url.startsWith('data:image/webp')) url = out.toDataURL('image/jpeg', 0.85);
          close(url);
        };
      };
      img.onerror = () => { toast(t('Could not open this picture')); resolve(null); };
      img.src = URL.createObjectURL(file);
    };
    input.click();
  });
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), Math.max(2600, msg.length * 60));   // longer messages stay longer
}
async function attempt(fn) {
  try { return await fn(); } catch (e) { toast('⚠ ' + t(e.message)); return undefined; }
}
const roleChip = role => role ? `<span class="chip role-${role}" title="${ROLES[role].short}">${roleLabel(role)}</span>` : `<span class="chip muted">${t('no role')}</span>`;
const wonLabel = w => (w === 'town' ? t('Citizens won') : t('Mafia won'));
const winnerChip = w => w ? `<span class="chip team-${w}">${w === 'town' ? t('Citizens won') : t('Mafia won')}</span>` : `<span class="chip warn">${t('In progress')}</span>`;
const signed = x => (x >= 0 ? '+' : '') + x.toFixed(1);
function bar(value, max, cls = '') {
  const w = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return `<span class="bar ${cls}"><span style="width:${w.toFixed(1)}%"></span></span>`;
}
function fateText(f) {
  if (!f) return t('Survived');
  const n = { n: f.round };
  return {
    killed: t('Shot by mafia · night {n}', n), maniac: t('Killed by maniac · night {n}', n),
    voted: t('Voted out · day {n}', n), removed: t('Removed (fouls) · day {n}', n), died: t('Out'),
  }[f.type] || t('Out');
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
      const handle = await window.showSaveFilePicker({ id: 'mafia-backups', suggestedName: filename, types: [{ description: t('JSON backup'), accept: { 'application/json': ['.json'] } }] });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      toast(t('Backup saved'));
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
  if ((db.players.length || db.games.length) && !confirm(t('Replace ALL current data with demo data?'))) return;
  Store.replace(makeDemoData());
  toast(t('Demo data loaded'));
  route();
}

/* ---------- top bar: login + save status ---------- */
/** Login area: who you are + Log out, or the login button. Same markup in the top bar and in the phone menu. */
const ICON_PLANE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M21 4 3 11l6 2 2 6 3-4 5 4 2-15zM9 13l9-6-7 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const ICON_LOGOUT = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M9 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4M16 16l4-4-4-4M20 12H9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** Login block. In the side menu (drawer = true) Log out is an icon next to the close button instead. */
function authHtml(drawer = false) {
  const u = Store.user();
  if (!Store.isLive()) return `<span class="chip muted">${t('local mode')}</span>`;
  if (u) {
    const me = u.playerId ? Store.player(u.playerId) : null;
    return `<span class="who">${me ? avatar(me) : ''}<span>${h(u.nickname || (u.username ? '@' + u.username : u.name || t('you')))}</span>${u.role === 'admin' ? ` <span class="chip admin">${t('admin')}</span>` : ''}</span>`
      + (drawer ? '' : `<button type="button" class="btn small ghost icon-only logout-btn" title="${t('Log out')}" aria-label="${t('Log out')}">${ICON_LOGOUT.replace(/22/g, '18')}</button>`);
  }
  if (Store.devLogin()) return `<a class="btn small" href="/api/auth/dev-login">${t('Dev login')}</a>`;
  if (Store.loginAvailable()) return `<a class="btn small tg" href="/api/auth/telegram/start?back=${encodeURIComponent(location.pathname)}" title="${t('Log in with Telegram')}">${ICON_PLANE}<span>${t('Log in')}</span></a>`;
  return '';
}
/* Links that only some people may use are not in index.html, so crawlers never find them; they are added
   once we know who is looking. "My stats" (members) goes into the top menu; the admin pages (local mode keeps
   Data and Settings for editing) live only in the side menu, which the burger opens on desktop too. */
const ADMIN_NAV = [
  { route: 'data', label: 'Data', show: () => Store.canEdit() },
  { route: 'settings', label: 'Settings', show: () => Store.canEdit() },
  { route: 'bot', label: 'Bot', show: () => Store.isAdmin() },
];
function syncPrivateNav() {
  const nav = document.getElementById('nav');
  const u = Store.user();
  let me = nav.querySelector('a[data-route="me"]');
  if (!(u && u.playerId)) { if (me) me.remove(); return; }
  if (!me) { me = document.createElement('a'); me.href = '/me'; me.dataset.route = 'me'; me.dataset.i18n = 'My stats'; nav.append(me); }
  me.textContent = t('My stats');
}
function renderAuth() {
  syncPrivateNav();
  document.getElementById('auth').innerHTML = authHtml();
  document.getElementById('drawerAuth').innerHTML = authHtml(true);
  // side menu: Log out as an icon left of ✕ (only when logged in)
  let out = document.getElementById('drawerLogout');
  if (Store.isLive() && Store.user()) {
    if (!out) {
      out = Object.assign(document.createElement('button'), { type: 'button', id: 'drawerLogout', className: 'drawer-close logout-btn', innerHTML: ICON_LOGOUT });
      document.getElementById('drawerClose').before(out);
    }
    out.title = t('Log out'); out.setAttribute('aria-label', t('Log out'));
  } else if (out) out.remove();
  document.querySelectorAll('.logout-btn').forEach(b => { b.onclick = () => attempt(() => Store.logout()); });
}
/* ---------- phone menu (burger → side panel with login on top and the menu items) ---------- */
/** Side menu: the site's pages, then (for the admin) the admin pages. The burger shows on desktop only when there are admin pages. */
function renderMenu() {
  const link = (href, text, on) => `<a href="${href}" class="${on ? 'active' : ''}">${h(text)}</a>`;
  const site = [...document.querySelectorAll('#nav a')].map(a => link(a.getAttribute('href'), a.textContent, a.classList.contains('active')))
    .concat(link('/about', t('About Mafia BCN'), location.pathname === '/about'));
  const admin = ADMIN_NAV.filter(it => it.show()).map(it => link('/' + it.route, t(it.label), location.pathname.split('/')[1] === it.route));
  document.getElementById('drawerNav').innerHTML = `<div class="drawer-sec">${t('Site')}</div>${site.join('')}`
    + (admin.length ? `<div class="drawer-sec">${t('Admin')}</div>${admin.join('')}` : '');
  document.body.classList.toggle('with-admin-menu', admin.length > 0);
}
function setMenu(open) {
  const drawer = document.getElementById('drawer'), back = document.getElementById('drawerBackdrop'), btn = document.getElementById('menuBtn');
  drawer.hidden = back.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('menu-open', open);
  if (open) document.getElementById('drawerClose').focus();
}
Store.onSaveState((s, msg) => {
  const el = document.getElementById('saveState');
  el.className = 'save-state ' + s;
  el.textContent = { saving: t('Saving…'), saved: t('Saved ✓'), error: t('Save failed') }[s] || '';
  el.title = msg || '';
  if (s === 'error') toast('⚠ ' + t('Not saved: {msg}', { msg: t(msg || '') }));
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
  syncPrivateNav();   // before marking the active link
  const navKey = { game: 'games', player: 'players' }[view] || view;
  document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('active', a.dataset.route === navKey));
  const db = Store.get();
  let banner = '';
  if (!Store.isLive()) {
    banner = db.demo
      ? `<div class="demo-banner">${t('Local mode with <b>demo data</b>. Real data lives on the live site.')}</div>`
      : `<div class="demo-banner subtle">${t('Local mode — data is stored in this browser only.')}</div>`;
  } else if (Store.throttleWait()) {
    banner = `<div class="demo-banner subtle">${t('Showing your saved copy of the data — too many refreshes, the next update check is possible in {s} s.', { s: Store.throttleWait() })}</div>`;
  } else if (Store.isAdmin() && view === 'game') {   // only where games are edited
    banner = `<div class="demo-banner subtle">${t('Admin mode — game changes are stored only when you press <b>Save changes</b>.')}</div>`;
  }
  document.getElementById('banner').innerHTML = banner;
  renderAuth();
  // Data and Settings are for the admin only (in local mode they stay available for editing).
  const adminPages = Store.canEdit();
  setMenu(false);
  renderMenu();
  if ((!adminPages && (view === 'data' || view === 'settings')) || (view === 'bot' && !Store.isAdmin())) { go('/dashboard', { replace: true }); return; }
  if (view !== 'bot') UI.botTabs = null; // loaded bot lists live only while you stay on the Bot page
  const pageTitles = { games: t('Games'), players: t('Players'), compare: t('Compare players'), data: t('Data'), settings: t('Settings'), bot: t('Bot') };
  setTitle(pageTitles[view] || '');   // player and game pages set their own title
  const views = {
    dashboard: viewDashboard, games: viewGames, game: () => viewGame(id),
    players: viewPlayers, player: () => viewPlayer(id), compare: () => viewCompare(parts[1], parts[2]), about: viewAbout, data: viewData, settings: viewSettings, bot: viewBot,
    me: () => { const u = Store.user(); if (u && u.playerId) viewPlayer(u.playerId); else viewDashboard(); },
    'login-error': () => { $app.innerHTML = `<div class="empty"><h2>${t('Login did not work')}</h2><p>${h(decodeURIComponent(id || ''))}</p><p><a class="btn" href="/api/auth/telegram/start">${t('Try again')}</a></p></div>`; },
  };
  (views[view] || viewDashboard)();
}
let currentPath = location.pathname;
/** Leaving a game with unsaved changes asks first. Returns false if the person wants to stay. */
function confirmLeave(path) {
  const stillHere = UI.draft && path === UI.draft.path;
  if (!stillHere && gameDirty() && !confirm(UI.draft.id === 'new' ? t('This new game is not saved yet. Leave and discard it?') : t('You have unsaved changes in this game. Leave without saving?'))) return false;
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
// A table row with data-href opens that page when clicked anywhere (not only on its link)
document.addEventListener('click', e => {
  const tr = e.target.closest('tr.row-link');
  if (!tr || e.target.closest('a, button, input, select, textarea') || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey) { window.open(tr.dataset.href, '_blank'); return; }
  go(tr.dataset.href);
});
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
const LB_COLS = () => [
  { key: 'name', label: t('Player'), get: p => p.nick.toLowerCase() },
  { key: 'games', label: t('Games'), get: p => p.games },
  { key: 'wins', label: t('Wins'), get: p => p.wins },
  { key: 'winRate', label: t('Win %'), get: p => p.winRate },
  { key: 'rating', label: t('Rating'), get: p => p.rating, title: t('Win rate adjusted for number of games (see the note below the table)') },
  { key: 'aboveExpected', label: t('Impact'), get: p => p.aboveExpected, title: t('How a player wins compared with an average player in the same roles: +2 = two wins more, −1 = one fewer.') },
  { key: 'days', label: t('Days'), get: p => p.days },
  ...ROLE_ORDER.map(r => ({ key: r, label: roleLabel(r), get: p => p.roleRating[r] + p.byRole[r].g / 1e4 })),
  { key: 'survived', label: t('Alive'), get: p => (p.games ? p.survived / p.games : 0) + p.survived / 1e4, title: t('Games alive at the end / games played') },
];

/** The stats cells of a leaderboard row, after the player cell (same columns as LB_COLS().slice(1)).
    Used by the dashboard leaderboard and the Players page; s = the player's stats, or nothing yet. */
function lbCells(s) {
  if (!s || !s.games) return LB_COLS().slice(1).map(() => '<td class="muted">–</td>').join('');
  return `<td>${s.games}</td>
    <td>${s.wins}</td>
    <td>${pct(s.winRate)}</td>
    <td class="wr"><b>${pct(s.rating)}</b> ${bar(s.rating, 1)}</td>
    <td class="${s.aboveExpected >= 0 ? 'pos' : 'neg'}">${signed(s.aboveExpected)}</td>
    <td>${s.days}</td>
    ${ROLE_ORDER.map(r => `<td class="rolecell">${s.byRole[r].g ? `${s.byRole[r].w}/${s.byRole[r].g}` : '<span class="muted">–</span>'}</td>`).join('')}
    <td>${s.survived}/${s.games}</td>`;
}
const sortHead = (c, key, dir) => `<th data-sort="${c.key}" class="sortable ${c.key === key ? 'sorted' : ''}" ${c.title ? `title="${h(c.title)}"` : ''}>${c.label}${c.key === key ? (dir < 0 ? ' ↓' : ' ↑') : ''}</th>`;

function viewDashboard() {
  const db = Store.get();
  const st = Stats.compute(db);
  const T = st.totals;

  if (!T.games) {
    $app.innerHTML = `
      <section class="hero">
        <h1>${t('Mafia BCN game log')}</h1>
        <p>${t('No finished games yet.')}</p>
        ${Store.canEdit() ? `<div class="row gap wrap">
          <a class="btn primary" href="/games">${t('Record a game')}</a>
          ${Store.isLive() ? '' : `<button class="btn ghost" id="demoBtn">${t('Load demo data')}</button>`}
        </div>` : ''}
      </section>`;
    if ($('#demoBtn')) $('#demoBtn').onclick = loadDemo;
    return;
  }

  const titles = Stats.titles(st, db.settings);
  const { key, dir } = UI.lbSort;
  const cols = LB_COLS();
  const col = cols.find(c => c.key === key) || cols.find(c => c.key === 'rating');
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
    <div class="page-head"><h1>${t('Dashboard')}</h1>${Store.canEdit() ? `<a class="btn primary" href="/games">${t('+ Record a game')}</a>` : ''}</div>
    ${Store.user() ? '' : `<p class="intro">${t('Mafia BCN is a Ukrainian-speaking community playing Mafia in Barcelona. Here are the results of all our games, a fair player rating and titles.')} <a href="/about">${t('More about us →')}</a></p>`}

    <section class="kpis">
      <div class="kpi"><span class="kpi-val">${T.games}</span><span class="kpi-lbl">${t('Games played')}</span></div>
      <div class="kpi"><span class="kpi-val">${T.days}</span><span class="kpi-lbl">${t('Game days')}</span></div>
      <div class="kpi"><span class="kpi-val">${T.players}</span><span class="kpi-lbl">${t('Players')}</span></div>
      <div class="kpi"><span class="kpi-val town-text">${pct(T.townWins / T.games)}</span><span class="kpi-lbl">${t('Citizens won')} (${T.townWins})</span></div>
      <div class="kpi"><span class="kpi-val mafia-text">${pct(T.mafiaWins / T.games)}</span><span class="kpi-lbl">${t('Mafia won')} (${T.mafiaWins})</span></div>
    </section>
    <div class="split" title="${t('Citizens vs Mafia wins')}">
      <span class="split-town" style="flex:${T.townWins}">${T.townWins ? teamLabel('town') + ' ' + T.townWins : ''}</span>
      <span class="split-mafia" style="flex:${T.mafiaWins}">${T.mafiaWins ? teamLabel('mafia') + ' ' + T.mafiaWins : ''}</span>
    </div>

    <h2 class="section-title">${t('Titles')}</h2>
    <section class="titles">
      ${titles.map(tt => `
        <div class="title-card ${tt.player ? '' : 'empty-title'}">
          <div class="title-icon">${tt.icon}</div>
          <div class="title-body">
            <div class="title-name">${h(tt.title)}</div>
            ${tt.player
              ? `<a class="title-holder" href="${playerHref(tt.player)}">${h(tt.player.name)}</a><div class="title-detail">${h(tt.detail)}</div>`
              : `<div class="title-detail">${t('Nobody yet')} (${h(tt.rule)})</div>`}
            <div class="title-desc">${h(tt.desc)}</div>
          </div>
        </div>`).join('')}
    </section>

    <h2 class="section-title">${t('Leaderboard')}</h2>
    <section class="card">
      <div class="table-wrap">
        <table class="lb">
          <thead><tr><th>#</th>${cols.map(c => sortHead(c, key, dir)).join('')}</tr></thead>
          <tbody>
            ${sorted.map((p, i) => `
              <tr>
                <td class="muted">${i + 1}</td>
                <td class="who-cell"><a href="${playerHref(p)}">${avatar(p)}<span>${h(p.name)}</span></a></td>
                ${lbCells(p)}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="muted small">${t('<b>#</b> = place in the current sort. <b>Rating</b> = win rate adjusted for number of games: (wins + {k} × {avg}) ÷ (games + {k}), so few games stay close to the average.', { k: st.K, avg: pct(st.overallRate) })}
      ${t('<b>Impact</b> = wins compared with an average player in the same roles (+2 = two more, −1 = one fewer). Role columns: wins/games. Alive: games alive at the end / games. Click a header to sort.')}</p>
    </section>

    <div class="grid-2">
      <section class="card">
        <h2>${t('Role leaders')}</h2>
        <p class="muted small">${t('Role rating (same adjustment, using each role’s own average).')}</p>
        <div class="role-leaders">
          ${ROLE_ORDER.map(r => {
            const list = st.players.filter(p => p.byRole[r].g > 0)
              .sort((a, b) => b.roleRating[r] - a.roleRating[r] || b.byRole[r].g - a.byRole[r].g).slice(0, 5);
            return `<div class="role-block">
              <h4>${roleChip(r)} <span class="muted small" title="${t('Average win rate of this role · games where this role was in play')}">${t('average')} ${pct(st.baseline[r])} · ${tn(st.roleGames[r], 'game')}</span></h4>
              ${list.length ? list.map(p => `
                <div class="bar-row"><a href="${playerHref(p)}">${h(p.name)}</a>${bar(p.roleRating[r], 1, 'role-' + r)}<span class="num">${pct(p.roleRating[r])} <span class="muted">${p.byRole[r].w}/${p.byRole[r].g}</span></span></div>`).join('')
                : `<p class="muted small">${t('No games yet.')}</p>`}
            </div>`;
          }).join('')}
        </div>
      </section>

      <section class="card">
        <h2>${t('Attendance')}</h2>
        <p class="muted small">${t('Games played (and number of game days).')}</p>
        ${[...st.players].sort((a, b) => b.games - a.games || b.days - a.days).slice(0, 30).map(p => `
          <div class="bar-row"><a href="${playerHref(p)}">${h(p.name)}</a>${bar(p.games, maxGames, 'accent')}<span class="num">${p.games} <span class="muted">· ${p.days}${t('d')}</span></span></div>`).join('')}
      </section>
    </div>

    <h2 class="section-title">${t('Recent games')} <span class="muted small">· ${fmtDate(lastDay)} · <a href="/games">${t('all games')}</a></span></h2>
    <section class="card game-list">${recent.map(gameRow).join('')}</section>
  `;

  $$('th[data-sort]').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    UI.lbSort = { key: k, dir: UI.lbSort.key === k ? -UI.lbSort.dir : (k === 'name' ? 1 : -1) };
    // re-sorting redraws the page: keep the table's sideways scroll and the page position (phones)
    const wrap = $('table.lb') && $('table.lb').closest('.table-wrap');
    const left = wrap ? wrap.scrollLeft : 0, top = window.scrollY;
    viewDashboard();
    const again = $('table.lb') && $('table.lb').closest('.table-wrap');
    if (again) again.scrollLeft = left;
    window.scrollTo(0, top);
  });
}

function gameRow(g) {
  const filled = g.seats.filter(s => s.playerId).length;
  return `<a class="game-row" href="${gameHref(g)}">
    <span class="gnum">#${g.number}</span>
    <span class="gdate">${fmtDate(g.date)}</span>
    <span class="muted small">${t('overall')} #${Store.overallNumber(g)}</span>
    <span class="muted">${tn(filled, 'player')} · ${tn(g.rounds.length, 'round')}</span>
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
  toast(t('Game #{n}: same players, now set the roles', { n: g.number }));
}

function viewGames() {
  const games = Store.sortedGames();
  const groups = {};
  games.forEach(g => (groups[g.date] ||= []).push(g));

  $app.innerHTML = `
    <div class="page-head">
      <h1>${t('Games')} <span class="muted">· ${games.length}</span></h1>
      ${Store.canEdit() ? `<div class="row gap wrap">
        ${dateField(localToday(), `id="newDate" aria-label="${t('Game date')}"`)}
        <label class="field inline"><span>${t('Players')}</span><select id="newSeats">${seatOptions().map(n => `<option ${n === (+Store.get().settings.defaultSeats || 10) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <button class="btn primary" id="newGame">${t('+ New game')}</button>
      </div>` : ''}
    </div>
    ${games.length ? Object.entries(groups).map(([date, list]) => `
      <section class="card">
        <div class="section-head"><h3>${fmtDate(date)} <span class="muted">· ${tn(list.length, 'game')}</span></h3>
          ${Store.canEdit() ? `<button class="btn small ghost icon-btn" data-next-day="${date}" title="${t('Next game on this day with the same players (saved only when you press Save changes)')}" aria-label="${t('Next game, same players')}">⧉</button>` : ''}</div>
        <div class="game-list">${list.sort((a, b) => a.number - b.number).map(gameRow).join('')}</div>
      </section>`).join('')
      : `<div class="empty">${t('No games yet.')}</div>`}
  `;
  wireDateFields($app);
  $$('[data-next-day]').forEach(b => b.onclick = () => {
    const last = games.filter(g => g.date === b.dataset.nextDay).sort((a, b2) => b2.number - a.number)[0];
    if (last) draftNextGame(last);
  });
  if ($('#newGame')) $('#newGame').onclick = () => attempt(async () => {
    const date = dmyToIso($('#newDate').value);
    if (!date) { toast(t('Enter the date as DD/MM/YYYY')); $('#newDate').focus(); return; }
    // Nothing is stored yet: the game is created on its first "Save changes"
    const g = Store.draftGame(date, +$('#newSeats').value);
    UI.draft = { id: 'new', g, base: JSON.stringify(g), path: '/game/new' };
    go('/game/new');
  }).finally(() => { if ($('#newGame')) $('#newGame').disabled = false; });
}

/* ============================================================
   GAME SCREEN — editor for the admin (and in local mode), read-only otherwise
   ============================================================ */
/** "2-5-1" lines → nominations (who, whom, votes). 0 as "who" = revote. Any non-digit separates numbers. */
function parseVotes(text, seatCount) {
  const rows = [], errors = [];
  String(text || '').split('\n').forEach((line, k) => {
    const nums = line.split(/[^0-9]+/).filter(Boolean).map(Number);
    if (!nums.length) return;
    const [by, target, votes] = nums;
    if (nums.length < 2 || nums.length > 3) { errors.push(t('Line {n}: expected who-whom-votes, e.g. 2-5-1', { n: k + 1 })); return; }
    const bad = by > seatCount ? by : (target < 1 || target > seatCount) ? target : null;
    if (bad != null) { errors.push(t('Line {n}: there is no seat {s}', { n: k + 1, s: bad })); return; }
    rows.push({ by: by || null, target, votes: votes == null ? null : Math.min(votes, 20) });
  });
  return { rows, errors };
}
/** The seat that clearly got the most votes in the last vote (revote rows if there are any); null on a tie. */
function votedOutLeader(rows) {
  const last = rows.some(r => !r.by) ? rows.filter(r => !r.by) : rows;
  const counted = last.filter(r => r.votes != null);
  if (!counted.length) return null;
  const max = Math.max(...counted.map(r => r.votes));
  const top = [...new Set(counted.filter(r => r.votes === max).map(r => r.target))];
  return max > 0 && top.length === 1 ? top[0] : null;
}
function voteBoxHtml(text, ri, seatCount) {
  const { errors } = parseVotes(text, seatCount);
  return `<div class="vote-text">
    <textarea class="vote-textarea" data-act="vote-text" data-round="${ri}" rows="${Math.max(3, String(text).split('\n').length + 1)}" spellcheck="false" placeholder="2-5-1&#10;7-3-4&#10;0-3-6">${h(text)}</textarea>
    <div class="muted small">${t('One nomination per line: who-whom-votes, e.g. 2-5-1. Start with 0 for a revote (0-5-3). The rows below are replaced as you type; the seat with the most votes is marked as voted out (on a tie you pick).')}</div>
    ${errors.length ? `<div class="vote-errors">${errors.map(h).join('<br>')}</div>` : ''}
  </div>`;
}

function viewGame(id) {
  const isNew = id === 'new';
  const orig = isNew ? (UI.draft && UI.draft.id === 'new' && Store.canEdit() ? UI.draft.g : null) : Store.game(id);
  if (!orig) { $app.innerHTML = `<div class="empty">${t('Game not found.')} <a href="/games">${t('Back to games')}</a></div>`; return; }
  const ro = !Store.canEdit();
  setTitle(isNew ? t('New game') : `${t('Game #{n}', { n: orig.number })} · ${isoToDmy(orig.date)}`);
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
  const players = [...db.players].sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const used = {};
  g.seats.forEach(s => { if (s.playerId) used[s.playerId] = (used[s.playerId] || 0) + 1; });
  const roleCountHtml = () => { const c = GameLogic.roleCounts(g); return ROLE_ORDER.filter(r => c[r]).map(r => `<span class="chip role-${r}">${roleLabel(r)} × ${c[r]}</span>`).join(''); };
  const warningsHtml = () => { const w = ro ? [] : GameLogic.validate(g); return w.length ? `<ul class="warnings">${w.map(x => `<li>${h(x)}</li>`).join('')}</ul>` : ''; };
  // "Votes as text" box: open for one round at a time, its text is kept while you type
  const vb = !ro && UI.voteBox && UI.voteBox.path === location.pathname ? UI.voteBox : null;
  const outcome = ro ? null : GameLogic.outcome(g);
  const suggested = outcome && outcome.winner;
  const has = r => GameLogic.hasRole(g, r);

  const seatRows = g.seats.map(s => {
    const alive = tl.alive.includes(s.seat);
    const f = alive ? null : tl.fates[s.seat];
    return `<tr class="${alive ? '' : 'dead'}">
      <td class="seatno">${s.seat}</td>
      <td>${ro ? (s.playerId ? `<a class="who-cell" href="${playerHref(s.playerId)}">${avatar(s.playerId)}<span>${h(name(s.seat))}</span></a>` : '—') : `<select data-act="seat-player" data-seat="${s.seat}" class="${s.playerId && used[s.playerId] > 1 ? 'bad' : ''}">
        <option value="">${t('— pick player —')}</option>
        ${players.map(p => `<option value="${p.id}" ${p.id === s.playerId ? 'selected' : ''}>${h(fullName(p))}${used[p.id] && p.id !== s.playerId ? ` (${t('seated')})` : ''}</option>`).join('')}
      </select>`}</td>
      <td>${ro ? roleChip(s.role) : `<select data-act="seat-role" data-seat="${s.seat}" class="role-select ${s.role ? 'role-' + s.role : ''}">
        <option value="">—</option>
        ${ROLE_ORDER.map(r => `<option value="${r}" data-k="${h(`${t(ROLES[r].code)} ${ROLES[r].code} ${roleLabel(r)} ${ROLES[r].label}`)}" ${s.role === r ? 'selected' : ''}>${t(ROLES[r].code)} — ${roleLabel(r)}</option>`).join('')}
      </select>`}</td>
      ${ro ? '' : `<td><input type="number" min="0" max="4" value="${s.fouls || 0}" data-act="seat-fouls" data-seat="${s.seat}" class="fouls ${s.fouls >= 3 ? 'warnf' : ''}"></td>`}
      ${!ro && imported ? `<td><label class="pick ${s.alive === 1 ? 'on-ok' : ''}"><input type="checkbox" data-act="seat-alive" data-seat="${s.seat}" ${s.alive === 1 ? 'checked' : ''}> ${t('alive')}</label></td>` : ''}
      <td class="fate">${alive ? `<span class="alive">${t('alive at the end')}</span>` : fateText(f)}</td>
    </tr>`;
  }).join('');

  const checkResult = (seat, kind) => {
    if (!seat) return '';
    const s = seatBy(seat);
    if (!s || !s.role) return '';
    if (kind === 'sheriff') return ROLES[s.role].team === 'mafia' ? `<span class="chip team-mafia">${t('Black')} ✓</span>` : `<span class="chip team-town">${t('Red')} ✗</span>`;
    if (kind === 'don') return s.role === 'sheriff' ? `<span class="chip role-sheriff">${t('Sheriff')} ✓</span>` : `<span class="chip muted">${t('Not sheriff')} ✗</span>`;
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
      ? `<div class="nom-row ro"><span class="nom-by">${nm.by ? h(lbl(nm.by)) : '—'}</span><span class="arrow">→</span><span class="nom-target">${h(lbl(nm.target))}</span><span class="nom-votes">${nm.votes == null ? '–' : tn(nm.votes, 'vote')}</span></div>`
      : `<div class="nom-row">
          <select data-act="nom-by" data-round="${i}" data-idx="${j}">${seatOpts(nomSeats, nm.by, t('who'))}</select>
          <span class="arrow">→</span>
          <select data-act="nom-target" data-round="${i}" data-idx="${j}">${seatOpts(nomSeats, nm.target, t('whom'))}</select>
          <input type="number" min="0" max="20" value="${nm.votes ?? ''}" placeholder="${t('votes')}" data-act="nom-votes" data-round="${i}" data-idx="${j}" class="votes-input">
          <button class="btn small ghost" data-act="nom-del" data-round="${i}" data-idx="${j}" title="${t('Remove')}">✕</button>
        </div>`).join('');
    const nt = r.night || {};
    const nightField = (field, label, show, kind) => {
      // Once the role is out, its night action disappears (an old value stays visible with a note)
      const canAct = GameLogic.canAct(g, field, nightAlive);
      if (!show || (!canAct && !nt[field])) return '';
      const outNote = canAct ? '' : ` <span class="chip warn">${t('role is out: ignored')}</span>`;
      if (ro) {
        if (!nt[field]) return '';
        return `<div class="night-ro"><span class="lbl">${label}</span> <b>${h(lbl(nt[field]))}</b> ${kind ? checkResult(nt[field], kind) : ''}${outNote}${field === 'doctorHeal' && (nt.doctorHeal === nt.mafiaKill || nt.doctorHeal === nt.maniacKill) ? ` <span class="chip win">${t('saved!')}</span>` : ''}</div>`;
      }
      return `<label class="field"><span>${label}</span>
        <select data-act="night" data-field="${field}" data-round="${i}">${seatOpts(nightAlive, nt[field], field.endsWith('Kill') ? t('miss / none') : '—')}</select>
        ${kind ? checkResult(nt[field], kind) : ''}${outNote}
      </label>`;
    };
    const anyMafia = has('mafia') || has('don') || !g.seats.some(s => s.role);
    const nightHtml = nightField('mafiaKill', t('Mafia shot'), anyMafia) + nightField('donCheck', t('Don checked'), has('don'), 'don') +
      nightField('sheriffCheck', t('Sheriff checked'), has('sheriff'), 'sheriff') + nightField('maniacKill', t('Maniac shot'), has('maniac')) +
      nightField('doctorHeal', t('Doctor healed'), has('doctor'));
    const elimRo = (r.eliminated || []).length ? (r.eliminated || []).map(s => `<span class="chip team-town">${h(lbl(s))}</span>`).join(' ') : `<span class="muted small">${t('nobody')}</span>`;
    return `
      <div class="card round" id="round-${n}">
        <div class="round-head">
          <h3>${t('Round {n}', { n })}</h3>
          ${!ro && i === g.rounds.length - 1 ? `<button class="btn small ghost" data-act="del-round" data-round="${i}">${t('Remove round')}</button>` : ''}
        </div>
        ${ro && !nightHtml.trim() ? '' : `<div class="phase night">
          <h4>☾ ${t('Night {n}', { n })}</h4>
          <div class="night-grid">${nightHtml || `<span class="muted small">${t('No night notes')}</span>`}</div>
        </div>`}
        <div class="phase day">
          <h4>☀ ${t('Day {n} — nominations', { n })}</h4>
          ${vb && vb.ri === i ? voteBoxHtml(vb.text, i, g.seats.length) : ''}
          <div class="noms">${noms || `<span class="muted small">${t('No nominations recorded')}</span>`}</div>
          ${ro ? '' : `<div class="row gap wrap"><button class="btn small" data-act="nom-add" data-round="${i}">${t('+ Nomination')}</button>
            <button class="btn small ghost ${vb && vb.ri === i ? 'on' : ''}" data-act="nom-text" data-round="${i}" title="${t('Type the nominations as short lines: who-whom-votes')}">⌨ ${t('As text')}</button></div>`}
          <div class="picks"><span class="lbl">${t('Voted out:')}</span>${ro ? elimRo : picks('eliminated', dayAlive)}</div>
          ${ro ? ((r.removed || []).length ? `<div class="picks"><span class="lbl">${t('Removed for fouls:')}</span>${r.removed.map(s => `<span class="chip warn">${h(lbl(s))}</span>`).join(' ')}</div>` : '')
               : `<details ${(r.removed || []).length ? 'open' : ''}><summary>${t('Removed for fouls')}</summary><div class="picks">${picks('removed', dayAlive)}</div></details>`}
        </div>
      </div>`;
  }).join('');

  $app.innerHTML = `
    <div class="page-head">
      <div>
        <a href="/games" class="back">← ${t('Games')}</a>
        <h1>${t('Game #{n}', { n: g.number })} <span class="muted">· ${fmtDate(g.date)} · ${t('overall')} #${Store.overallNumber(g)}</span></h1>
        <div class="row gap wrap">${isNew ? `<span class="chip warn">${t('New — not saved yet')}</span>` : winnerChip(g.winner)}${imported ? `<span class="chip muted">${t('imported from spreadsheet')}</span>` : ''}</div>
      </div>
      ${ro ? '' : `<div class="row gap wrap">
        ${!isNew ? `<button class="btn icon-btn" id="nextSameBtn" title="${t('Next game on this day with the same players (saved only when you press Save changes)')}" aria-label="${t('Next game, same players')}">⧉</button>` : ''}
        ${Store.isAdmin() && orig.winner && !isNew ? `<button class="btn" id="publishBtn" title="${t('Prepare a summary post for the Telegram group')}">📣 ${t('Publish to Telegram')}</button>` : ''}
        <label class="field inline"><span>${t('Date')}</span>${dateField(g.date, 'data-act="date"')}</label>
        <label class="field inline"><span>${t('Game #')}</span><input type="number" min="1" data-act="number" value="${g.number}" class="num-input"></label>
        <button class="btn danger" data-act="del-game">${t('Delete')}</button>
      </div>`}
    </div>

    <section class="card">
      <div class="section-head">
        <h2>${t('Seats & roles')}</h2>
        ${ro ? '' : `<div class="row gap wrap">
          <label class="field inline"><span>${t('Players')}</span><select data-act="seat-count">${seatOptions().map(n => `<option ${n === g.seats.length ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <button class="btn small" data-act="random-roles">🎲 ${t('Random roles')}</button>
          <button class="btn small ghost" data-act="clear-roles">${t('Clear roles')}</button>
        </div>`}
      </div>
      ${ro ? '' : `<div class="row gap wrap quick-add">
        <input id="qaName" placeholder="${t('Name (e.g. Tania)')}" maxlength="40">
        <input id="qaNick" placeholder="${t('Nick (e.g. Tianaboa)')}" maxlength="60">
        ${genderSelect(null).replace('name="gender"', 'name="gender" id="qaGender"')}
        <button class="btn small" data-act="quick-add">${t('+ Add player')}</button>
        <span class="muted small">${t('New player goes to the first empty seat.')}</span>
      </div>`}
      <div class="role-count" id="roleCount">${roleCountHtml()}</div>
      <div id="seatWarnings">${warningsHtml()}</div>
      <div class="table-wrap">
        <table class="seats">
          <thead><tr><th>#</th><th>${t('Player')}</th><th>${t('Role')}</th>${ro ? '' : `<th>${t('Fouls')}</th>`}${!ro && imported ? `<th>${t('End')}</th>` : ''}<th>${t('Status')}</th></tr></thead>
          <tbody>${seatRows}</tbody>
        </table>
      </div>
      ${!ro && imported ? `<p class="muted small">${t('Imported game: there are no night notes, so “alive at the end” is set by hand.')}</p>` : ''}
    </section>

    <div class="section-head"><h2>${t('Rounds')}</h2>${ro ? '' : `<span class="muted small">${t('Each round = Night (shots, checks, heal) → Day (nominations, vote-out). Nothing is saved until you press <b>Save changes</b>.')}</span>`}</div>
    ${roundsHtml || `<div class="card muted">${t('No rounds recorded.')}</div>`}
    ${ro ? '' : `<button class="btn primary add-round" data-act="add-round">${t('+ Add round {n}', { n: g.rounds.length + 1 })}</button>`}

    <section class="card result">
      <h2>${t('Result')}</h2>
      <div class="alive-list"><span class="lbl">${t('Alive at the end')} (${tl.alive.length}):</span>
        ${tl.alive.map(n => { const s = seatBy(n); return `<span class="alive-chip">${h(lbl(n))} ${s && s.role ? roleChip(s.role) : ''}</span>`; }).join('') || `<span class="muted">${t('nobody')}</span>`}
      </div>
      ${ro ? (g.notes ? `<p class="notes">${h(g.notes)}</p>` : '') : `
      ${suggested && suggested !== g.winner ? `<p class="hint">${t('By the rules it looks like <b>{team}</b> won', { team: teamLabel(suggested) })} <span class="muted">(${h(outcome.reason)})</span>. <button class="btn small" data-act="winner" data-val="${suggested}">${t('Set {team} as winner', { team: teamLabel(suggested) })}</button></p>` : ''}
      <div class="seg">
        <button class="seg-town ${g.winner === 'town' ? 'on' : ''}" data-act="winner" data-val="town">${t('Citizens (МИР) won')}</button>
        <button class="seg-mafia ${g.winner === 'mafia' ? 'on' : ''}" data-act="winner" data-val="mafia">${t('Mafia (МАФ) won')}</button>
        <button class="${!g.winner ? 'on' : ''}" data-act="winner" data-val="">${t('Not finished')}</button>
      </div>
      <label class="field block"><span>${t('Notes')}</span><textarea data-act="notes" rows="3" placeholder="${t('Anything worth remembering about this game')}">${h(g.notes)}</textarea></label>`}
    </section>
  `;
  if (ro) return;
  renderSaveBar();

  /** Re-draw the editor; sel = element to focus afterwards (keeps keyboard entry going). */
  const commit = sel => { viewGame(id); const el = sel && $(sel); if (el) el.focus(); };
  const focusKey = el => (el.id ? '#' + el.id : el.dataset && el.dataset.act
    ? `[data-act="${el.dataset.act}"]` + ['seat', 'round', 'idx', 'field'].filter(k => el.dataset[k] != null).map(k => `[data-${k}="${el.dataset[k]}"]`).join('')
    : null);

  async function handle(act, el) {
    const seat = +el.dataset.seat, ri = +el.dataset.round, idx = +el.dataset.idx;
    const s = seat ? g.seats.find(x => x.seat === seat) : null;
    const r = Number.isInteger(ri) ? g.rounds[ri] : null;
    switch (act) {
      case 'seat-player': s.playerId = el.value || null; break;
      case 'seat-role': s.role = el.value || null; break;
      case 'seat-alive': s.alive = el.checked ? 1 : 0; break;
      case 'seat-fouls': s.fouls = Math.max(0, Math.min(4, +el.value || 0)); if (s.fouls >= 4) toast(t('4 fouls — mark the player as removed in the current round')); break;
      case 'nom-text': {
        if (vb && vb.ri === ri) { UI.voteBox = null; commit(); return; }
        const text = (r.nominations || []).filter(nm => nm.target).map(nm => [nm.by || 0, nm.target, nm.votes].filter(v => v != null).join('-')).join('\n');
        UI.voteBox = { path: location.pathname, ri, text, auto: null };
        commit('.vote-textarea');
        const t2 = $('.vote-textarea'); if (t2) t2.setSelectionRange(t2.value.length, t2.value.length);
        return;
      }
      case 'nom-add': UI.voteBox = null; r.nominations.push({ by: null, target: null, votes: null }); break;
      case 'nom-del': UI.voteBox = null; r.nominations.splice(idx, 1); break;
      case 'nom-by': UI.voteBox = null; r.nominations[idx].by = el.value ? +el.value : null; break;
      case 'nom-target': UI.voteBox = null; r.nominations[idx].target = el.value ? +el.value : null; break;
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
        if (!confirm(t('Remove round {n} and everything recorded in it?', { n: ri + 1 }))) return;
        g.rounds.splice(ri, 1);
        break;
      case 'random-roles': {
        if (g.seats.some(x => x.role) && !confirm(t('Overwrite the current roles with a random distribution?'))) return;
        const pool = Object.entries(roleSetup(g.seats.length)).flatMap(([rr, c]) => Array(c).fill(rr));
        for (let k = pool.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [pool[k], pool[j]] = [pool[j], pool[k]]; }
        g.seats.forEach((x, k) => { x.role = pool[k]; });
        break;
      }
      case 'clear-roles':
        if (!confirm(t('Clear all roles?'))) return;
        g.seats.forEach(x => { x.role = null; });
        break;
      case 'seat-count': {
        const n = +el.value;
        if (n < g.seats.length && g.seats.slice(n).some(x => x.playerId) && !confirm(t('Remove seats {a}–{b}?', { a: n + 1, b: g.seats.length }))) { viewGame(id); return; }
        if (n < g.seats.length) g.seats = g.seats.slice(0, n);
        while (g.seats.length < n) g.seats.push({ seat: g.seats.length + 1, playerId: null, role: null, alive: null, fouls: 0 });
        break;
      }
      case 'quick-add': {
        const name = $('#qaName').value, nickname = $('#qaNick').value, gender = $('#qaGender').value || null;
        if (!name.trim() && !nickname.trim()) { toast(t('Type a name or a nick')); $('#qaName').focus(); return; }
        const p = await attempt(() => Store.addPlayer({ name, nickname, gender }));
        if (!p) return;   // e.g. the nick is taken: the fields keep what was typed
        const free = g.seats.find(x => !x.playerId);
        if (free && !g.seats.some(x => x.playerId === p.id)) { free.playerId = p.id; toast(t('{name} (No. {no}) → seat {seat}', { name: fullName(p), no: p.number, seat: free.seat })); }
        else toast(t('{name} added', { name: fullName(p) }));
        commit('#qaName');
        return;
      }
      case 'winner': g.winner = el.dataset.val || null; break; // stored with Save changes, like everything else
      case 'notes': g.notes = el.value; renderSaveBar(); return;
      case 'date': {
        const iso = dmyToIso(el.value);
        if (!iso) { toast(t('Enter the date as DD/MM/YYYY')); el.value = isoToDmy(g.date); return; }
        g.date = iso;
        break;
      }
      case 'number': g.number = Math.max(1, +el.value || 1); break;
      case 'del-game':
        if (isNew) {
          if (!confirm(t('Discard this new game? Nothing has been saved yet.'))) return;
          UI.draft = null; renderSaveBar(); go('/games');
          return;
        }
        if (!confirm(t('Delete this game permanently?'))) return;
        if (await attempt(() => Store.deleteGame(id).then(() => true))) { UI.draft = null; go('/games'); }
        return;
    }
    commit();
  }

  wireDateFields($app);
  const seatSel = 'select[data-act="seat-player"], select[data-act="seat-role"]';
  $$('[data-act]').forEach(el => {
    if (el.matches(seatSel) || el.matches('.vote-textarea')) return;
    const evt = el.tagName === 'BUTTON' ? 'click' : 'change';
    el.addEventListener(evt, () => handle(el.dataset.act, el));
  });
  // Player and role pickers: a change made with the keyboard is applied at once but the page is re-drawn
  // only on Enter (focus moves to the same picker one seat down) or when you leave the picker.
  // A mouse pick re-draws right away, as before.
  // Type-to-pick is our own (browsers differ): letters typed quickly match the start of any word of an option
  // ("ми" → МИР — Мирний, "sh" → Sheriff); the same letter again jumps to the next option with that letter.
  let seatPending = false, lastKey = 0, typed = '', typedAt = 0;
  const words = o => (o.dataset.k || o.textContent).toLowerCase().split(/[\s—()]+/).filter(Boolean);
  function typeToPick(el, ch) {
    const now = Date.now();
    typed = (now - typedAt > 900 ? '' : typed) + ch.toLowerCase(); typedAt = now;
    const opts = [...el.options].filter(o => o.value);
    const starts = (o, x) => words(o).some(w => w.startsWith(x));
    let m = opts.find(o => starts(o, typed));
    if (!m && [...typed].every(c => c === typed[0])) {
      const list = opts.filter(o => starts(o, typed[0]));
      m = list[(list.indexOf(el.selectedOptions[0]) + 1) % list.length];
      typed = typed[0];
    }
    if (m && m.value !== el.value) { el.value = m.value; el.dispatchEvent(new Event('change')); }
  }
  $$(seatSel).forEach(el => {
    const s = g.seats.find(x => x.seat === +el.dataset.seat);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const next = `select[data-act="${el.dataset.act}"][data-seat="${Math.min(+el.dataset.seat + 1, g.seats.length)}"]`;
        if (seatPending) { seatPending = false; commit(next); } else if ($(next)) $(next).focus();
        return;
      }
      if (e.key !== 'Tab') lastKey = Date.now();
      if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeToPick(el, e.key); }
    });
    el.addEventListener('change', () => {
      if (el.dataset.act === 'seat-role') s.role = el.value || null; else s.playerId = el.value || null;
      if (Date.now() - lastKey > 1500) { seatPending = false; commit(); return; }
      seatPending = true;
      if (el.dataset.act === 'seat-role') { el.classList.remove(...ROLE_ORDER.map(r => 'role-' + r)); if (s.role) el.classList.add('role-' + s.role); }
      $('#roleCount').innerHTML = roleCountHtml();
      $('#seatWarnings').innerHTML = warningsHtml();
      renderSaveBar();
    });
    el.addEventListener('blur', () => {
      if (!seatPending) return;
      seatPending = false;
      setTimeout(() => { const a = document.activeElement; commit(a && a !== document.body ? focusKey(a) : null); });
    });
  });
  // Votes as text: every edit rewrites the round's nominations (and the voted-out pick when one seat clearly leads)
  const ta = $('.vote-textarea');
  if (ta) {
    let timer;
    ta.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const ri = +ta.dataset.round, r = g.rounds[ri];
        vb.text = ta.value;
        const { rows } = parseVotes(ta.value, g.seats.length);
        r.nominations = rows;
        const day = tl.phases.find(p => p.round === ri + 1 && p.phase === 'day');
        const lead = votedOutLeader(rows);
        if (lead && day.alive.includes(lead)) { r.eliminated = [lead]; vb.auto = lead; }
        else if (!lead && vb.auto && (r.eliminated || []).length === 1 && r.eliminated[0] === vb.auto) { r.eliminated = []; vb.auto = null; }
        const a = ta.selectionStart, b = ta.selectionEnd;
        commit('.vote-textarea');
        const t2 = $('.vote-textarea'); if (t2) t2.setSelectionRange(a, b);
      }, 300);
    });
  }
  $$('#qaName, #qaNick').forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') handle('quick-add', el); }));
  if ($('#nextSameBtn')) $('#nextSameBtn').onclick = () => {
    if (gameDirty()) { toast(t('Save your changes first')); return; }
    draftNextGame(orig);
  };
  if ($('#publishBtn')) $('#publishBtn').onclick = () => {
    if (gameDirty()) { toast(t('Save your changes first')); return; }
    UI.botDraft = { text: gameSummaryText(orig), kind: 'game', gameId: orig.id, audience: 'group' };
    go('/bot');
  };
  $$('textarea[data-act="notes"], input[data-act="nom-votes"]').forEach(el => el.addEventListener('input', () => handle(el.dataset.act, el)));
}

/* ---------- unsaved changes: bar, summary, save/discard ---------- */
function gameDirty() { return !!(UI.draft && (UI.draft.id === 'new' || JSON.stringify(UI.draft.g) !== UI.draft.base)); }

function changeSummary(base, g) {
  const out = [];
  const label = w => (w ? wonLabel(w) : t('not finished'));
  const role = r => (r ? roleLabel(r) : '—');
  if (base.date !== g.date) out.push(`${t('Date')}: ${isoToDmy(base.date)} → ${isoToDmy(g.date)}`);
  if (base.number !== g.number) out.push(`${t('Game #')}: ${base.number} → ${g.number}`);
  if (base.winner !== g.winner) out.push(`${t('Result')}: ${label(base.winner)} → ${label(g.winner)}`);
  if ((base.notes || '') !== (g.notes || '')) out.push(t('Notes changed'));
  if (base.seats.length !== g.seats.length) out.push(`${t('Seats')}: ${base.seats.length} → ${g.seats.length}`);
  g.seats.forEach(s => {
    const b = base.seats.find(x => x.seat === s.seat);
    if (!b) return;
    const seat = t('Seat {n}', { n: s.seat });
    if (b.playerId !== s.playerId) out.push(`${seat}: ${b.playerId ? Store.playerName(b.playerId) : '—'} → ${s.playerId ? Store.playerName(s.playerId) : '—'}`);
    if (b.role !== s.role) out.push(`${seat}: ${t('role')} ${role(b.role)} → ${role(s.role)}`);
    if (b.alive !== s.alive && g.source === 'xls') out.push(`${seat}: ${s.alive ? t('alive at the end') : t('out at the end')}`);
    if ((b.fouls || 0) !== (s.fouls || 0)) out.push(`${seat}: ${t('fouls')} ${b.fouls || 0} → ${s.fouls || 0}`);
  });
  if (base.rounds.length !== g.rounds.length) out.push(`${t('Rounds')}: ${base.rounds.length} → ${g.rounds.length}`);
  g.rounds.forEach((r, i) => {
    const b = base.rounds[i];
    if (!b) return;
    if (JSON.stringify(b.night) !== JSON.stringify(r.night)) out.push(t('Round {n}: night changed', { n: i + 1 }));
    if (JSON.stringify([b.nominations, b.eliminated, b.removed]) !== JSON.stringify([r.nominations, r.eliminated, r.removed])) out.push(t('Round {n}: day changed', { n: i + 1 }));
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
  const changes = isNew ? [t('nothing is stored until you save')] : changeSummary(JSON.parse(UI.draft.base), UI.draft.g);
  bar.innerHTML = `<div class="savebar-inner">
      <span class="dot"></span><b>${isNew ? t('New game') : t('Unsaved changes')}</b><span class="muted small">${isNew ? '' : `${tn(changes.length, 'change')}: `}${h(changes.slice(0, 3).join(' · '))}${changes.length > 3 ? ' …' : ''}</span>
      <span class="spacer"></span>
      <button class="btn ghost small" id="discardBtn">${t('Discard')}</button>
      <button class="btn primary" id="saveBtn">${t('Save changes')}</button>
    </div>`;
  document.getElementById('discardBtn').onclick = () => {
    if (!confirm(isNew ? t('Discard this new game? Nothing has been saved yet.') : t('Discard all unsaved changes in this game?'))) return;
    const id = UI.draft.id;
    UI.draft = null;
    renderSaveBar();
    if (id === 'new') go('/games'); else viewGame(id);
  };
  document.getElementById('saveBtn').onclick = async () => {
    const dg = UI.draft.g;
    if (isNew) {
      const filled = dg.seats.filter(x => x.playerId).length;
      if (!confirm(`${t('Save new Game #{n} ({date})?', { n: dg.number, date: isoToDmy(dg.date) })}\n\n${t('{a} of {b} seats filled', { a: filled, b: dg.seats.length })} · ${tn(dg.rounds.length, 'round')} · ${dg.winner ? wonLabel(dg.winner) : t('not finished')}`)) return;
    } else {
      const list = changeSummary(JSON.parse(UI.draft.base), dg);
      const text = list.slice(0, 15).map(x => '• ' + x).join('\n') + (list.length > 15 ? `\n… ${t('and {n} more', { n: list.length - 15 })}` : '');
      if (!confirm(`${t('Save these changes to Game #{n} ({date})?', { n: dg.number, date: isoToDmy(dg.date) })}\n\n${text}`)) return;
    }
    const btn = document.getElementById('saveBtn');
    btn.disabled = true; btn.textContent = t('Saving…');
    const saved = await attempt(() => Store.saveGame(UI.draft.g));
    if (saved) {
      // The address follows the date and game number (they may have changed, or the game is new)
      const href = gameHref(saved);
      if (location.pathname !== href) { history.replaceState(null, '', href); currentPath = href; }
      UI.draft = { id: saved.id, g: JSON.parse(JSON.stringify(saved)), base: JSON.stringify(saved), path: href };
      toast(t('Game saved'));
      renderSaveBar();
      viewGame(saved.id);
    } else { btn.disabled = false; btn.textContent = t('Save changes'); }
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

  // The player No. (order of joining) is for the admin only; visitors see the list without it
  const numCol = { key: 'number', label: t('No.'), get: p => p.number };
  // the same stats columns as the leaderboard (players without games sort last)
  const statCols = LB_COLS().slice(1).map(c => ({ ...c, get: p => (byId[p.id] && byId[p.id].games ? c.get(byId[p.id]) : -1) }));
  const cols = [
    ...(edit ? [numCol] : []),
    { key: 'nickname', label: t('Player'), get: p => fullName(p).toLowerCase() },
    ...statCols,
  ];
  const nCols = 1 + cols.length + (adminLive ? 2 : 0) + (edit ? 1 : 0);   // 1 = the # (place in the current order)
  const { dir } = UI.plSort;
  // visitors don't see No., so their default order is by rating
  const col = cols.find(c => c.key === UI.plSort.key) || cols.find(c => c.key === 'rating');
  const key = col.key;
  const list = [...db.players].sort((a, b) => { const va = col.get(a), vb = col.get(b); return va < vb ? -dir : va > vb ? dir : a.number - b.number; });

  const row = (p, i) => {
    const s = byId[p.id];
    const pv = priv[p.id] || {};
    const tg = tgFor(p.id);
    if (UI.editingPlayer === p.id) {
      const pre = tg.find(a => !a.linked) || tg[0];
      return `<tr class="editing"><td class="muted">${i + 1}</td><td colspan="${nCols - 1}">
        <form class="edit-player row gap wrap" data-id="${p.id}">
          <label class="field"><span>${t('Name (short, e.g. Tania)')}</span><input name="name" value="${h(p.name || '')}" maxlength="40"></label>
          <label class="field"><span>${t('Nick (public, unique)')}</span><input name="nickname" value="${h(p.nickname)}" required maxlength="60"></label>
          <label class="field"><span>${t('Gender (icon)')}</span>${genderSelect(p.gender)}</label>
          ${adminLive ? `
          <label class="field"><span>${t('First name (private)')}</span><input name="first_name" value="${h(pv.first_name || '')}"></label>
          <label class="field"><span>${t('Last name (private)')}</span><input name="last_name" value="${h(pv.last_name || '')}"></label>
          <label class="field"><span>${t('Telegram @username')}</span><input name="telegram" value="${h(pre ? pre.username || '' : '')}" placeholder="@username"></label>` : ''}
          <div class="row gap"><button class="btn primary small">${t('Save')}</button><button type="button" class="btn ghost small" data-cancel>${t('Cancel')}</button></div>
        </form></td></tr>`;
    }
    return `<tr data-name="${h((fullName(p) + ' ' + (pv.first_name || '') + ' ' + (pv.last_name || '') + ' ' + tg.map(a => a.username).join(' ')).toLowerCase())}">
      <td class="muted">${i + 1}</td>
      ${edit ? `<td class="muted">${p.number}</td>` : ''}
      <td class="who-cell"><a href="${playerHref(p)}">${avatar(p)}<span>${h(fullName(p))}</span></a></td>
      ${adminLive ? `<td>${h([pv.first_name, pv.last_name].filter(Boolean).join(' ')) || '<span class="muted">—</span>'}</td>
        <td>${tg.length ? tg.map(a => {
          const label = a.username ? '@' + a.username : (a.display_name || 'Telegram');
          const [cls, tip] = a.seen ? ['win', t('Connected: has logged in or pressed Start')]
            : a.linked ? ['', t('Telegram ID known ({name}): linked automatically on the first login or Start', { name: a.display_name || '' })]
            : ['muted', t('Waiting for the first login or Start (matched by @username)')];
          return `<span class="chip ${cls}" title="${h(tip)}">${h(label)}</span>`;
        }).join(' ') : '<span class="muted">—</span>'}</td>` : ''}
      ${lbCells(s)}
      ${edit ? `<td class="actions"><button class="btn small ghost icon-only" data-edit="${p.id}" title="${t('Edit')}" aria-label="${t('Edit')}">${ICON_EDIT}</button><button class="btn small ghost icon-only danger-text" data-del="${p.id}" title="${t('Delete')}" aria-label="${t('Delete')}">${ICON_DELETE}</button></td>` : ''}
    </tr>`;
  };

  // logins that really happened (pre-filled IDs / @usernames show in the Telegram column until then)
  const loggedIn = accounts.filter(a => a.seen || (a.linked && !a.player_id));
  $app.innerHTML = `
    <div class="page-head"><h1>${t('Players')} <span class="muted">· ${list.length}</span></h1></div>
    ${edit ? `<section class="card">
      <form id="addForm" class="row gap wrap">
        <input name="name" placeholder="${t('Name (e.g. Tania)')}" maxlength="40">
        <input name="nickname" placeholder="${t('Nick (e.g. Tianaboa)')}" maxlength="60">
        ${genderSelect(null)}
        <button class="btn primary">${t('+ Add player')}</button>
        <span class="muted small">${t('New players get the next number (No. {n}).', { n: Math.max(0, ...db.players.map(p => p.number)) + 1 })}</span>
      </form>
    </section>` : ''}
    <section class="card">
      <input id="filter" class="filter" placeholder="${t('Search players…')}">
      <div class="table-wrap">
        <table class="players">
          <thead><tr>
            <th title="${t('Place in the current order')}">#</th>
            ${cols.slice(0, edit ? 2 : 1).map(c => sortHead(c, key, dir)).join('')}
            ${adminLive ? `<th>${t('Real name')}</th><th>Telegram</th>` : ''}
            ${cols.slice(edit ? 2 : 1).map(c => sortHead(c, key, dir)).join('')}
            ${edit ? '<th></th>' : ''}
          </tr></thead>
          <tbody>${list.map(row).join('') || `<tr><td colspan="${nCols}" class="muted">${t('No players yet.')}</td></tr>`}</tbody>
        </table>
      </div>
      ${adminLive ? `<p class="muted small">${t('Real name and Telegram are private (only you see them). If you add someone’s Telegram @username, they are linked to this player automatically the first time they log in.')}</p>` : ''}
    </section>
    ${adminLive ? `
    <section class="card">
      <div class="section-head"><h2>${t('Telegram logins')}</h2>
        <button class="btn small ghost" id="tgPhotos" title="${t('Take profile photos from Telegram for linked players who have none yet')}">📷 ${t('Load Telegram photos')}</button></div>
      <p class="muted small">${t('Everyone who has logged in. Link an account to a player so they see “My stats”; make someone admin if they should help with data.')}</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Telegram</th><th title="${t('Last login on the website (UTC). Pressing Start in the bot is not a website login.')}">${t('Last site login')}</th><th>${t('Player')}</th><th>${t('Role')}</th></tr></thead>
        <tbody>${loggedIn.map(a => `<tr>
          <td>${h(a.display_name || '')} ${a.username ? `<span class="muted">@${h(a.username)}</span>` : ''}</td>
          <td class="muted">${a.last_login_at ? h(a.last_login_at.slice(0, 16)) : a.bot ? t('bot only') : '—'}</td>
          <td><select data-acc-player="${a.id}"><option value="">${t('— not linked —')}</option>${[...db.players].sort((x, y) => fullName(x).localeCompare(fullName(y))).map(p => `<option value="${p.id}" ${a.player_id === p.id ? 'selected' : ''}>${h(fullName(p))}</option>`).join('')}</select></td>
          <td>${String(a.id) === String((Store.user() || {}).accountId)
            ? `<span class="chip admin" title="${t('Your own admin role can’t be removed here (protection against locking yourself out)')}">${t('admin · you')}</span>`
            : `<select data-acc-role="${a.id}"><option value="player" ${a.role === 'player' ? 'selected' : ''}>${t('player')}</option><option value="admin" ${a.role === 'admin' ? 'selected' : ''}>${t('admin')}</option></select>`}</td>
        </tr>`).join('') || `<tr><td colspan="4" class="muted">${t('Nobody has logged in yet.')}</td></tr>`}</tbody>
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
      const f = e.target;
      if (!f.elements.name.value.trim() && !f.nickname.value.trim()) { toast(t('Type a name or a nick')); return; }
      const p = await Store.addPlayer({ name: f.elements.name.value, nickname: f.nickname.value, gender: f.gender.value || null });
      if (p) { toast(t('{name} added as No. {no}', { name: fullName(p), no: p.number })); viewPlayers(); $('#addForm input').focus(); }
    });
  };
  $$('[data-edit]').forEach(b => b.onclick = () => { UI.editingPlayer = b.dataset.edit; viewPlayers(); });
  $$('[data-cancel]').forEach(b => b.onclick = () => { UI.editingPlayer = null; viewPlayers(); });
  $$('form.edit-player').forEach(f => f.onsubmit = e => {
    e.preventDefault();
    const patch = { name: f.elements.name.value.trim(), nickname: f.nickname.value.trim(), gender: f.gender.value || null };
    if (f.first_name) Object.assign(patch, { first_name: f.first_name.value, last_name: f.last_name.value, telegram: f.telegram.value });
    attempt(async () => { await Store.updatePlayer(f.dataset.id, patch); UI.editingPlayer = null; toast(t('Saved')); viewPlayers(); });
  });
  $$('[data-del]').forEach(b => b.onclick = () => {
    const p = Store.player(b.dataset.del);
    if (Store.playerInUse(p.id)) { toast(t('{name} has played games — edit instead', { name: fullName(p) })); return; }
    if (confirm(t('Delete {name}?', { name: fullName(p) }))) attempt(async () => { await Store.deletePlayer(p.id); viewPlayers(); });
  });
  if ($('#tgPhotos')) $('#tgPhotos').onclick = () => attempt(async () => {
    $('#tgPhotos').disabled = true;
    let r = { remaining: 1 }, added = 0, checked = 0, guard = 0;
    while (r.remaining > 0 && guard++ < 20) {
      r = await Store.avatar.bulkTelegram();
      added += r.added; checked += r.checked;
      if (!r.checked) break;
      toast(t('Photos: {a} added, {b} left…', { a: added, b: r.remaining }));
    }
    await Store.loadAdmin().catch(() => {});
    await Store.init().catch(() => {});
    toast(checked ? t('Done: {a} photo(s) added from Telegram', { a: added }) + (checked - added ? t(', {b} without a visible photo', { b: checked - added }) : '') : t('Everyone linked already has a photo (or was checked before)'));
    viewPlayers();
  }).finally(() => { if ($('#tgPhotos')) $('#tgPhotos').disabled = false; });
  // Changes to logins apply at once, so each one asks first; Cancel puts the old value back.
  const accName = id => { const a = accounts.find(x => String(x.id) === String(id)) || {}; return a.username ? '@' + a.username : (a.display_name || t('this login')); };
  $$('[data-acc-player]').forEach(s => s.onchange = () => {
    const to = s.value ? Store.playerName(s.value) : null;
    if (!confirm(to ? t('Link {acc} to player {to}?\n\nThey will see “{to}” as their own stats (/mystats, My stats). You can change it back here.', { acc: accName(s.dataset.accPlayer), to }) : t('Unlink {acc} from its player?', { acc: accName(s.dataset.accPlayer) }))) { viewPlayers(); return; }
    attempt(async () => { await Store.updateAccount(s.dataset.accPlayer, { player_id: s.value || null }); toast(t('Saved')); viewPlayers(); });
  });
  $$('[data-acc-role]').forEach(s => s.onchange = () => {
    const msg = s.value === 'admin'
      ? t('Make {acc} an ADMIN?\n\nAdmins can edit and delete games, players, settings and send bot messages.', { acc: accName(s.dataset.accRole) })
      : t('Remove admin rights from {acc}?', { acc: accName(s.dataset.accRole) });
    if (!confirm(msg)) { viewPlayers(); return; }
    attempt(async () => { await Store.updateAccount(s.dataset.accRole, { role: s.value }); toast(t('Saved')); viewPlayers(); });
  });
}

/* ---------- player profile ("My stats") ---------- */
function viewPlayer(id) {
  const p0 = Store.player(id);
  if (!p0) { $app.innerHTML = `<div class="empty">${t('Player not found.')} <a href="/players">${t('Back')}</a></div>`; return; }
  setTitle(fullName(p0));
  const st = Stats.compute(Store.get());
  const p = st.players.find(x => x.id === p0.id);
  const ranked = [...st.players].sort((a, b) => b.rating - a.rating);
  const rank = ranked.findIndex(x => x.id === p0.id) + 1;
  const mine = Store.user() && Store.user().playerId === p0.id;

  const canPhoto = Store.isLive() && (mine || Store.isAdmin());   // your own photo, or any photo for the admin
  const u = Store.user();
  const head = `
    <div class="page-head">
      <div class="player-head">
        <div class="player-photo">${avatar(p0, true)}</div>
        <div><a href="/players" class="back">← ${t('Players')}</a><h1>${h(fullName(p0))}${mine ? ` <span class="chip win">${t('you')}</span>` : ''}</h1>
          <div class="row gap wrap photo-actions">
            <a class="btn small ghost" href="${compareHref(p0)}" title="${t('Compare this player’s stats with another player')}">⇄ ${t('Compare')}</a>
            ${canPhoto ? `<button class="btn small" data-photo="upload">📷 ${p0.av ? t('Change photo') : t('Add photo')}</button>
            <button class="btn small ghost" data-photo="telegram" title="${t('Take the current profile photo from Telegram')}">${t('From Telegram')}</button>
            ${p0.av ? `<button class="btn small ghost danger-text" data-photo="remove">${t('Remove')}</button>` : ''}` : ''}
          </div>
        </div>
      </div>
    </div>
    ${mine ? `<section class="card my-details">
      <h2>${t('My details')} <span class="muted small">· ${t('private, only you and the game master see them')}</span></h2>
      <form id="myDetails" class="row gap wrap">
        <label class="field"><span>${t('First name')}</span><input name="first_name" value="${h(u.firstName || '')}" maxlength="100"></label>
        <label class="field"><span>${t('Last name')}</span><input name="last_name" value="${h(u.lastName || '')}" maxlength="100"></label>
        <div class="field"><span>&nbsp;</span><button class="btn primary" type="submit">${t('Save')}</button></div>
      </form>
      <p class="muted small">${t('Your name and nick on the site are set by the game master.')}</p>
    </section>` : ''}`;
  const wireHead = () => {
    $$('[data-photo]').forEach(b => b.onclick = () => attempt(async () => {
      const act = b.dataset.photo, self = !!mine;   // your own photo goes through /api/me, others through the admin API
      if (act === 'upload') {
        const url = await pickAndCropPhoto();
        if (!url) return;
        await Store.avatar.upload(p0.id, url, self);
        toast(t('Photo saved'));
      } else if (act === 'telegram') {
        await Store.avatar.telegram(p0.id, self);
        toast(t('Photo taken from Telegram'));
      } else if (act === 'remove') {
        if (!confirm(t('Remove this photo? The default icon will be shown instead.'))) return;
        await Store.avatar.remove(p0.id, self);
        toast(t('Photo removed'));
      }
      viewPlayer(id);
    }));
    if ($('#myDetails')) $('#myDetails').onsubmit = e => attempt(async () => {
      e.preventDefault();
      const f = e.target;
      await Store.profile.save({ first_name: f.first_name.value.trim(), last_name: f.last_name.value.trim() });
      toast(t('Saved'));
    });
  };

  if (!p) { $app.innerHTML = head + `<div class="empty">${t('No finished games yet for {name}.', { name: h(fullName(p0)) })}</div>`; wireHead(); return; }

  const facts = [
    [t('Alive at the end'), `${p.survived} (${pct(p.survived / p.games)})`],
    [t('Voted out'), p.voted],
    [t('Shot by mafia'), p.killed],
    [t('Killed by maniac'), p.maniac],
    [t('Shot first at night'), p.firstKilled],
    [t('Removed for fouls'), p.removed],
    [t('Nominations made'), p.noms],
    [t('Nominations on mafia (as citizen)'), p.nomsAsTown ? `${p.nomsOnMafia}/${p.nomsAsTown} (${pct(p.nomAcc)})` : '—'],
    [t('Sheriff checks found black'), p.sheriffChecks ? `${p.sheriffBlack}/${p.sheriffChecks}` : '—'],
    [t('Don found the sheriff'), p.donChecks ? `${p.donFoundSheriff}/${p.donChecks}` : '—'],
    [t('Doctor saves'), p.byRole.doctor.g ? p.doctorSaves : '—'],
    [t('Maniac kills (on mafia)'), p.byRole.maniac.g ? `${p.maniacKills} (${p.maniacKillsMafia})` : '—'],
  ];

  $app.innerHTML = head + `
    <section class="kpis">
      <div class="kpi"><span class="kpi-val">#${rank}</span><span class="kpi-lbl">${t('Rank of {n}', { n: ranked.length })}</span></div>
      <div class="kpi"><span class="kpi-val">${pct(p.rating)}</span><span class="kpi-lbl">${t('Rating')}</span></div>
      <div class="kpi"><span class="kpi-val">${p.wins}/${p.games}</span><span class="kpi-lbl">${t('Wins / games')} (${pct(p.winRate)})</span></div>
      <div class="kpi"><span class="kpi-val ${p.aboveExpected >= 0 ? 'pos' : 'neg'}">${signed(p.aboveExpected)}</span><span class="kpi-lbl" title="${t('How a player wins compared with an average player in the same roles: +2 = two wins more, −1 = one fewer.')}">${t('Impact')}</span></div>
      <div class="kpi"><span class="kpi-val">${p.days}</span><span class="kpi-lbl">${t('Game days')}</span></div>
    </section>

    <div class="grid-2">
      <section class="card">
        <h2>${t('By role')}</h2>
        ${ROLE_ORDER.map(r => `
          <div class="bar-row">${roleChip(r)}${bar(p.byRole[r].g ? p.roleRating[r] : 0, 1, 'role-' + r)}<span class="num">${p.byRole[r].g ? pct(p.roleRating[r]) : '—'} <span class="muted">${p.byRole[r].w}/${p.byRole[r].g}</span></span></div>`).join('')}
        <p class="muted small">${t('Bars show the role rating (role average: {roles}).', { roles: ROLE_ORDER.map(r => `${roleLabel(r)} ${pct(st.baseline[r])}`).join(', ') })}</p>
      </section>
      <section class="card">
        <h2>${t('How the games went')}</h2>
        <dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      </section>
    </div>

    <section class="card">
      <h2>${t('Game history')}</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>${t('Date')}</th><th>${t('Game')}</th><th>${t('Seat')}</th><th>${t('Role')}</th><th>${t('Result')}</th><th>${t('Fate')}</th></tr></thead>
          <tbody>
            ${[...p.history].sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number).map(x => {
              const href = Store.game(x.gameId) ? gameHref(Store.game(x.gameId)) : '/games';
              return `
              <tr class="row-link" data-href="${href}">
                <td>${fmtDate(x.date)}</td>
                <td><a href="${href}">#${x.number}</a></td>
                <td>${x.seat}</td>
                <td>${roleChip(x.role)}</td>
                <td>${x.won ? `<span class="chip win">${t('Win')}</span>` : `<span class="chip loss">${t('Loss')}</span>`}</td>
                <td class="muted">${fateText(x.fate)}</td>
              </tr>`; }).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
  wireHead();
}

/* ============================================================
   ABOUT — who we are, how the game works, what the site shows (public, for new people and search engines)
   ============================================================ */
function viewAbout() {
  document.title = `${t('About Mafia BCN')} — ${t('Mafia in Barcelona')}`;
  const roleLine = (r, text) => `<li>${roleChip(r)}<span>${text}</span></li>`;
  $app.innerHTML = `
    <article class="about">
      <div class="page-head"><h1>${t('About Mafia BCN')}</h1></div>
      <p>${t('<b>Mafia BCN</b> is a Ukrainian-speaking community in Barcelona that plays Mafia, the classic party game of logic, bluff and intuition. We usually meet on Sundays and play several games in an evening, with 7 to 16 players at the table.')}</p>

      <h2>${t('How the game works')}</h2>
      <p>${t('Every player secretly gets a role. The citizens, together with the sheriff, the doctor and the maniac, try to find the mafia. The mafia and their don try to stay hidden until they are as many as the citizens.')}</p>
      <p>${t('Each round has a <b>night</b>, when the mafia shoots and the sheriff and the don check players, and a <b>day</b>, when everyone talks, nominates suspects and votes someone out.')}</p>
      <ul class="roles-list">
        ${roleLine('citizen', t('finds the mafia by talking and voting.'))}
        ${roleLine('sheriff', t('checks one player every night: mafia or not.'))}
        ${roleLine('doctor', t('heals one player every night and can save them from a shot.'))}
        ${roleLine('maniac', t('can shoot anyone at night, but plays for the citizens, so the best target is the mafia.'))}
        ${roleLine('mafia', t('shoots one player every night and wins by numbers.'))}
        ${roleLine('don', t('leads the mafia and looks for the sheriff at night.'))}
      </ul>

      <h2>${t('What you will find on this site')}</h2>
      <ul>
        <li>${t('The result of every game: roles, nights, nominations and votes.')}</li>
        <li>${t('A fair rating: the win rate adjusted for the number of games, so 8 wins of 10 rank higher than 2 of 2.')}</li>
        <li>${t('Titles: King of the Game, the best sheriff, don, doctor and more.')}</li>
        <li>${t('A page for every player and a comparison of any two players.')}</li>
        <li>${t('Telegram bot <b>@mafia_bcn_bot</b>: send /mystats to get your own stats.')}</li>
      </ul>

      <h2>${t('Want to play?')}</h2>
      <p>${t('New players are always welcome. No experience is needed: the game master explains the rules before the game.')}</p>
      <p class="row gap wrap"><a class="btn tg" href="https://t.me/voorest" target="_blank" rel="noopener">${t('Write to the game master in Telegram')}</a><a class="btn" href="/">${t('See the stats')}</a><a class="btn ghost" href="/games">${t('All games')}</a></p>
    </article>`;
}

/* ============================================================
   COMPARE — two players side by side  /compare/<No.>/<No.>
   Default: you vs the top player (or the 2nd, if you are the top); for visitors #1 vs #2.
   ============================================================ */
/** Rating order used for "place" (same as the player page). */
const rankedPlayers = st => [...st.players].sort((a, b) => b.rating - a.rating || b.games - a.games);
/** The usual opponent for someone: the top player, or the 2nd when they are the top themselves. */
function defaultRival(ranked, id) { return ranked.find(p => p.id !== id) || null; }
/* Readable compare links: /compare/micro-vs-undefined (nicks as slugs; the same rules live in src/seo.js).
   Old links with player numbers (/compare/6/25) still work. */
const SLUG_TR = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'io', ъ: '', "'": '', '’': '' };
const slugify = s => String(s || '').toLowerCase().replace(/♀/g, ' f').replace(/♂/g, ' m').replace(/./gu, c => SLUG_TR[c] ?? c)
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
/** Slug of every player; an empty, numeric or shared slug falls back to "p<No.>" so each one is unique. */
function playerSlugs() {
  const raw = Store.get().players.map(p => [p, slugify(p.nickname)]);
  const count = {};
  raw.forEach(([, s]) => { count[s] = (count[s] || 0) + 1; });
  return new Map(raw.map(([p, s]) => [p.id, s && !/^\d+$/.test(s) && count[s] === 1 ? s : `p${p.number}`]));
}
const playerSlug = p => playerSlugs().get(p.id);
const comparePath = (a, b) => `/compare/${playerSlug(a)}-vs-${playerSlug(b)}`;
/** Link from a player page: you vs this player when you are logged in as someone else, otherwise this player vs the top. */
function compareHref(p0) {
  const u = Store.user();
  const me = u && u.playerId && u.playerId !== p0.id ? Store.player(u.playerId) : null;
  return me ? comparePath(me, p0) : `/compare/${playerSlug(p0)}`;
}

function viewCompare(arg1, arg2) {
  const db = Store.get();
  const st = Stats.compute(db);
  const ranked = rankedPlayers(st);
  if (ranked.length < 2) { $app.innerHTML = `<div class="empty">${t('At least two players with finished games are needed to compare.')}</div>`; return; }
  // "micro-vs-undefined", "micro" (vs the default rival), or old numbers "6", "25"
  const slugs = playerSlugs();
  const [aKey, bKey] = arg1 && arg1.includes('-vs-') ? arg1.split('-vs-') : [arg1, arg2];
  const find = key => (!key ? null : ranked.find(p => (/^\d+$/.test(key) ? String(p.number) === key : slugs.get(p.id) === key.toLowerCase())) || null);
  const u = Store.user();
  const me = u && u.playerId ? ranked.find(p => p.id === u.playerId) : null;
  let A = find(aKey), B = find(bKey);
  if (!A) A = me || ranked[0];
  if (!B || B.id === A.id) B = defaultRival(ranked, A.id);
  // The plain /compare address stays clean; a chosen pair shows as readable nicks
  if (arg1) { const want = comparePath(A, B); if (location.pathname !== want) { history.replaceState(null, '', want); currentPath = want; } }

  const place = p => ranked.findIndex(x => x.id === p.id) + 1;
  const titles = Stats.titles(st, db.settings);
  const rate = (n, d) => (d ? n / d : null);
  const frac = (n, d) => (d ? `${n}/${d} <span class="muted">(${pct(n / d)})</span>` : '—');
  /* One row: label, a value to compare (null = nothing to compare), the text shown, which way is better */
  const row = (label, fn, better = 'high', hint = '') => ({ label, hint, better, a: fn(A), b: fn(B) });
  const sections = [
    [t('Overall'), [
      row(t('Place in the rating'), p => ({ v: place(p), text: `#${place(p)} <span class="muted">${t('of {n}', { n: ranked.length })}</span>` }), 'low'),
      row(t('Rating'), p => ({ v: p.rating, text: `<b>${pct(p.rating)}</b>` })),
      row(t('Games'), p => ({ v: p.games, text: p.games }), null),
      row(t('Wins'), p => ({ v: p.wins, text: p.wins }), null),
      row(t('Win %'), p => ({ v: p.winRate, text: pct(p.winRate) })),
      row(t('Impact'), p => ({ v: p.aboveExpected, text: signed(p.aboveExpected) }), 'high', t('How a player wins compared with an average player in the same roles: +2 = two wins more, −1 = one fewer.')),
      row(t('Game days'), p => ({ v: p.days, text: p.days }), null),
      row(t('Alive at the end'), p => ({ v: rate(p.survived, p.games), text: frac(p.survived, p.games) })),
    ]],
    [t('By role'), ROLE_ORDER.map(r => row(`${roleChip(r)}`, p => p.byRole[r].g
      ? { v: p.roleRating[r], text: `${pct(p.roleRating[r])} <span class="muted">${p.byRole[r].w}/${p.byRole[r].g}</span>` }
      : { v: null, text: '<span class="muted">—</span>' }, 'high', t('Role rating · wins/games in this role')))],
    [t('How the games went'), [
      row(t('Voted out'), p => ({ v: rate(p.voted, p.games), text: frac(p.voted, p.games) }), 'low'),
      row(t('Removed for fouls'), p => ({ v: p.removed, text: p.removed }), 'low'),
      row(t('Shot by mafia'), p => ({ v: p.killed, text: p.killed }), null),
      row(t('Shot first at night'), p => ({ v: p.firstKilled, text: p.firstKilled }), null),
      row(t('Nominations on mafia (as citizen)'), p => ({ v: rate(p.nomsOnMafia, p.nomsAsTown), text: frac(p.nomsOnMafia, p.nomsAsTown) })),
      row(t('Sheriff checks found black'), p => ({ v: rate(p.sheriffBlack, p.sheriffChecks), text: frac(p.sheriffBlack, p.sheriffChecks) })),
      row(t('Don found the sheriff'), p => ({ v: rate(p.donFoundSheriff, p.donChecks), text: frac(p.donFoundSheriff, p.donChecks) })),
      row(t('Doctor saves'), p => (p.byRole.doctor.g ? { v: p.doctorSaves, text: p.doctorSaves } : { v: null, text: '—' })),
      row(t('Maniac kills (on mafia)'), p => (p.byRole.maniac.g ? { v: p.maniacKillsMafia, text: `${p.maniacKills} (${p.maniacKillsMafia})` } : { v: null, text: '—' })),
    ]],
  ];
  // Who is better in a row: only when both have a value and they differ
  const winner = r => {
    if (!r.better || r.a.v == null || r.b.v == null || r.a.v === r.b.v) return null;
    return (r.better === 'high') === (r.a.v > r.b.v) ? 'a' : 'b';
  };
  let leadA = 0, leadB = 0;
  sections.forEach(([, rows]) => rows.forEach(r => { const w = winner(r); if (w === 'a') leadA++; if (w === 'b') leadB++; }));

  const options = sel => ranked.map(p => `<option value="${p.number}" ${p.id === sel.id ? 'selected' : ''}>#${place(p)} ${h(fullName(p))}</option>`).join('');
  const card = (p, side) => {
    return `<div class="cmp-card cmp-card-${side}">
      <select class="cmp-select" data-side="${side}" aria-label="${t('Player')}">${options(p)}</select>
      <a class="cmp-who" href="${playerHref(p)}">${avatar(p, true)}<span>${h(fullName(p))}${me && me.id === p.id ? ` <span class="chip win">${t('you')}</span>` : ''}</span></a>
      <div class="cmp-big"><b>${pct(p.rating)}</b> <span class="muted">· #${place(p)}</span></div>
    </div>`;
  };
  // Titles go under the cards as short chips (full name on hover), so both cards stay the same height
  const titlesOf = (p, side) => {
    const held = titles.filter(x => x.player && x.player.id === p.id);
    return `<div class="cmp-titles cmp-titles-${side}">${held.map(x => `<span class="chip" title="${h(x.title)} · ${h(x.desc)}">${x.icon} ${h(x.short)}</span>`).join('') || `<span class="muted small">${t('No titles yet')}</span>`}</div>`;
  };
  const lead = leadA === leadB ? t('Even: {a} : {b}', { a: leadA, b: leadB })
    : t('{name} is ahead in {n} of {m} rows', { name: h((leadA > leadB ? A : B).nick), n: Math.max(leadA, leadB), m: leadA + leadB });

  $app.innerHTML = `
    <div class="page-head"><h1>${t('Compare players')}</h1>
      <button class="btn small" id="cmpShare" title="${t('Send a link to this comparison')}">🔗 ${t('Share')}</button></div>
    <section class="cmp-head">
      ${card(A, 'a')}
      <button class="btn ghost cmp-swap" id="cmpSwap" title="${t('Swap')}" aria-label="${t('Swap')}">⇄</button>
      ${card(B, 'b')}
      ${titlesOf(A, 'a')}${titlesOf(B, 'b')}
    </section>
    <p class="cmp-lead muted">${lead}</p>
    ${sections.map(([title, rows]) => `
      <section class="card">
        <h2>${title}</h2>
        <div class="table-wrap"><table class="cmp-table">
          <thead><tr><th></th><th>${h(A.nick)}</th><th>${h(B.nick)}</th></tr></thead>
          <tbody>${rows.map(r => { const w = winner(r); return `<tr>
            <th scope="row"${r.hint ? ` title="${h(r.hint)}"` : ''}>${r.label}</th>
            <td class="${w === 'a' ? 'better' : ''}">${r.a.text}</td>
            <td class="${w === 'b' ? 'better' : ''}">${r.b.text}</td></tr>`; }).join('')}</tbody>
        </table></div>
      </section>`).join('')}
    <p class="muted small">${t('Green = better in that row. Rows without green are just facts (more games or being shot is not better or worse).')}</p>
  `;
  const byNo = no => ranked.find(p => String(p.number) === String(no));
  const goPair = (a, b) => { const path = comparePath(a, b); history.replaceState(null, '', path); currentPath = path; viewCompare(path.slice(9)); };
  $$('.cmp-select').forEach(s => s.onchange = () => {
    let a = s.dataset.side === 'a' ? byNo(s.value) : A, b = s.dataset.side === 'b' ? byNo(s.value) : B;
    if (a.id === b.id) { if (s.dataset.side === 'a') b = A; else a = B; }   // picking the other side's player swaps them
    goPair(a, b);
  });
  $('#cmpSwap').onclick = () => goPair(B, A);
  // Share: the phone's share sheet, or copy the link on a computer
  $('#cmpShare').onclick = async () => {
    const url = location.origin + comparePath(A, B) + (I18N.lang === 'en' ? '?lang=en' : '');
    const title = `${A.nick} vs ${B.nick} — Mafia BCN`;
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast(t('Link copied: {url}', { url })); }
    catch { toast(url); }
  };
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
      rows.push([g.date, g.number, g.id, s.seat, p.number || '', fullName(p) || '', s.role || '', team, g.winner || '',
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
    <div class="page-head"><h1>${t('Data')}</h1></div>
    ${live ? `<div class="callout">${Store.isAdmin() ? t('Live site: data comes from the database — you are admin, so you can edit games and players and download a full backup.') : t('Live site: data comes from the database. Downloads contain public data only (nicknames).')}</div>`
           : `<div class="callout">${t('Local mode: data is stored <b>in this browser only</b>. Download a backup after every game night.')}</div>`}
    <div class="grid-2 cols-2">
      <section class="card">
        <h2>${t('Backup')}</h2>
        <p class="muted small">${tn(db.players.length, 'player')} · ${tn(db.games.length, 'game')}</p>
        <div class="row gap wrap">
          ${Store.isAdmin() ? `<button class="btn primary" id="fullBackup">⬇ ${t('Full backup (private, JSON)')}</button>` : ''}
          ${Store.isAdmin() ? '' : `<button class="btn primary" id="exportJson">⬇ ${t('Download JSON')}</button>`}
          ${live ? '' : `<label class="btn">⬆ ${t('Restore from backup')}<input type="file" id="importJson" accept=".json,application/json" hidden></label>`}
        </div>
        ${Store.isAdmin() ? `<p class="muted small">${t('The full backup includes private names and Telegram accounts. Keep it in your private <code>data</code> folder.')}</p>` : ''}
      </section>
      <section class="card">
        <h2>${t('Export for Excel')}</h2>
        <p class="muted small">${t('One row per player per game — easy to pivot in Excel.')}</p>
        <div class="row gap wrap">
          <button class="btn" id="csvSemi">${t('CSV for Excel (EU, “;”)')}</button>
          <button class="btn ghost" id="csvComma">CSV (“,”)</button>
        </div>
      </section>
      ${Store.isAdmin() ? `<section class="card wide">
        <h2>${t('Backups in Cloudflare')}</h2>
        <p class="muted small">${t('Every Sunday at 09:00 (08:00 in winter) a full backup is stored automatically; the last 12 are kept, plus the last 5 manual ones. You get a Telegram message each time.')}</p>
        <div class="row gap wrap">
          <button class="btn" id="backupNow">${t('Back up now')}</button>
        </div>
        <div id="backupList" class="backup-list"><div class="row gap wrap"><span class="muted small">${t('The list is not loaded yet.')}</span><button class="btn small" id="loadBackups">${t('Show backups')}</button></div></div>
      </section>` : ''}
      ${live ? '' : `<section class="card">
        <h2>${t('Demo & reset')}</h2>
        <div class="row gap wrap">
          <button class="btn" id="demo">${t('Load demo data')}</button>
          <button class="btn danger" id="clear">${t('Clear all data')}</button>
        </div>
      </section>`}
    </div>
  `;

  if ($('#fullBackup')) $('#fullBackup').onclick = () => attempt(async () => {
    const res = await fetch('/api/admin/backup', { credentials: 'same-origin' });
    if (!res.ok) throw new Error(t('Backup failed ({n})', { n: res.status }));
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
      box.innerHTML = `<div class="row gap"><span class="spacer"></span><button class="btn small ghost" id="refreshBackups">↻ ${t('Refresh')}</button></div>` + (res.backups.length ? `<div class="table-wrap"><table><thead><tr><th>${t('When')}</th><th>${t('Type')}</th><th>${t('Games')}</th><th>${t('Players')}</th><th>${t('Size')}</th><th></th></tr></thead><tbody>${res.backups.map(b => `
        <tr><td>${h(new Date(b.at).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }))}</td><td>${h(t(b.kind))}</td><td>${b.games}</td><td>${b.players}</td><td>${Math.round(b.size / 1024)} KB</td>
        <td class="actions"><button class="btn small" data-dl="${h(b.name)}">⬇ ${t('Download')}</button></td></tr>`).join('')}</tbody></table></div>`
        : `<p class="muted small">${t('No backups yet — the first weekly one runs on Sunday, or press “Back up now”.')}</p>`);
      $('#refreshBackups').onclick = renderBackups;
      $$('[data-dl]').forEach(btn => btn.onclick = () => attempt(async () => {
        const r = await fetch('/api/admin/backups/' + encodeURIComponent(btn.dataset.dl), { credentials: 'same-origin' });
        if (!r.ok) throw new Error(t('Download failed ({n})', { n: r.status }));
        await saveFile(`mafia-bcn-backup-${btn.dataset.dl}.json`, await r.text());
      }));
    };
    // The list is loaded only on request (saves a storage read every time the page opens)
    $('#loadBackups').onclick = renderBackups;
    $('#backupNow').onclick = () => attempt(async () => { const b = await Store.backupNow(); toast(t('Backup saved ({games}, {kb} KB)', { games: tn(b.games, 'game'), kb: Math.round(b.size / 1024) })); if (!$('#loadBackups')) renderBackups(); });
  }
  if (live) return;
  $('#importJson').onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.players) || !Array.isArray(data.games)) throw new Error(t('This file is not a Mafia BCN backup'));
        if (!confirm(t('Replace current data with the backup ({players}, {games})?', { players: tn(data.players.length, 'player'), games: tn(data.games.length, 'game') }))) return;
        Store.replace(data);
        toast(t('Backup restored'));
        route();
      } catch (err) { alert(t('Could not read backup: {msg}', { msg: err.message })); }
    };
    reader.readAsText(file);
  };
  $('#demo').onclick = loadDemo;
  $('#clear').onclick = () => {
    if (!confirm(t('Delete ALL players and games from this browser?'))) return;
    if (!confirm(t('Really? Make sure you downloaded a backup.'))) return;
    Store.clear();
    toast(t('All data cleared'));
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
    <div class="page-head"><h1>${t('Settings')}</h1></div>
    <div class="grid-2">
      <section class="card">
        <h2>${t('Rating rules')}</h2>
        <form id="settings" class="settings">
          <label class="field"><span>${t('Confidence weight K — how many “average games” every player starts with')}</span><input type="number" min="0" max="50" name="priorWeight" value="${s.priorWeight}" ${dis}></label>
          <label class="field"><span>${t('Minimum games for “King of the Game”')}</span><input type="number" min="1" max="50" name="minGames" value="${s.minGames}" ${dis}></label>
          <label class="field"><span>${t('Seats in a new game')}</span><input type="number" min="${SEATS_MIN}" max="${SEATS_MAX}" name="defaultSeats" value="${s.defaultSeats}" ${dis}></label>
          ${edit ? `<div><button class="btn primary" type="submit">${t('Save settings')}</button></div>` : `<p class="muted small">${t('Only the admin can change these.')}</p>`}
        </form>
      </section>
      <section class="card">
        <h2>${t('How ratings work')}</h2>
        <p>${t('<b>Rating</b> = (wins + K × average) ÷ (games + K)')}</p>
        <p class="muted">${t('Now: K = {k}, average win rate per seat = {avg}. A new player starts at the average; every game moves the rating towards their real win rate. So 8 wins of 10 games ranks higher than 2 of 2.', { k: st.K, avg: pct(st.overallRate) })}</p>
        <p>${t('<b>Role rating</b> — same formula, but with that role’s own average:')}</p>
        <p class="muted">${ROLE_ORDER.map(r => `${roleLabel(r)} ${pct(st.baseline[r])}`).join(' · ')}</p>
        <p>${t('<b>Impact</b> — how a player wins compared with an average player in the same roles: +2 = two wins more, −1 = one fewer.')}</p>
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
    if (!confirm(t('Save settings?\n\nK = {k}, min games for King = {min}, seats in a new game = {seats}', { k: patch.priorWeight, min: patch.minGames, seats: patch.defaultSeats }))) return;
    attempt(async () => { await Store.saveSettings(patch); toast(t('Settings saved')); viewSettings(); });
  };
}

/* ============================================================
   BOT — posts to the Telegram group / subscribers, history with edit & delete
   ============================================================ */
/* Telegram texts are always in Ukrainian, whatever language the site is shown in. */
/* Short format (agreed 31 Oct 2026): nicks only, roles as emoji, " | " between groups,
   links written as [text](address) and sent as clickable words (see postHtml). Citizens are not listed. */
const tgLink = (text, url) => `[${text}](${url})`;
const resultUk = w => (w === 'town' ? 'перемога мирних' : w === 'mafia' ? 'перемога мафії' : 'не завершена');
const resultDot = w => (w === 'town' ? '🔴' : w === 'mafia' ? '⚫' : '⏳');
/** One game: "🔴 Гра 3 — перемога мирних" (linked), then the mafia line and the active citizen roles line. */
function gameBlockUk(g) {
  const part = role => {
    const nicks = g.seats.filter(s => s.role === role && s.playerId).map(s => Store.playerNick(s.playerId));
    return nicks.length ? `${ROLES[role].icon} ${nicks.join(', ')}` : '';
  };
  const lines = [`${resultDot(g.winner)} ${tgLink(`Гра ${g.number}`, location.origin + gameHref(g))} — ${resultUk(g.winner)}`];
  for (const roles of [['don', 'mafia'], ['sheriff', 'doctor', 'maniac']]) {
    const line = roles.map(part).filter(Boolean).join(' | ');
    if (line) lines.push(line);
  }
  return lines;
}
function gameSummaryText(g) {
  return [`${tgLink('Mafia BCN', location.origin)} | ${isoToDmy(g.date)}`, ...gameBlockUk(g)].join('\n');
}
/** Post text as HTML for the page (preview, history): escaped, [text](https://…) shown as a link. */
const postHtml = text => h(text).replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`);

/** All finished games of one day as a Telegram post (the agreed "day stats" format). */
function dayStatsText(date) {
  const db = Store.get();
  const games = db.games.filter(g => g.date === date && g.winner).sort((a, b) => a.number - b.number);
  if (!games.length) return '';
  const town = games.filter(g => g.winner === 'town').length;
  const out = [`${tgLink('Mafia BCN', location.origin)} | ${isoToDmy(date)}`, `Мирні ${town} : ${games.length - town} Мафія`, ''];
  games.forEach(g => out.push(...gameBlockUk(g), ''));

  // Everyone who won all their games that day
  const day = {};
  games.forEach(g => g.seats.forEach(s => {
    if (!s.playerId || !s.role) return;
    const d = (day[s.playerId] ||= { g: 0, w: 0 });
    d.g++; if (ROLES[s.role].team === g.winner) d.w++;
  }));
  const best = Object.entries(day).filter(([, d]) => d.w === d.g).sort((a, b) => b[1].g - a[1].g);

  // Rating before this day vs after it (later games are left out, so an old day reads the same later)
  const before = Stats.compute({ ...db, games: db.games.filter(g => g.date < date) });
  const after = Stats.compute({ ...db, games: db.games.filter(g => g.date <= date) });
  const was = Object.fromEntries(before.players.map(p => [p.id, p]));
  const pts = x => Math.round(x * 100);
  const moves = after.players.filter(p => day[p.id] && was[p.id]).map(p => ({ p, d: pts(p.rating) - pts(was[p.id].rating) })).filter(m => m.d !== 0);
  const ups = moves.filter(m => m.d > 0).sort((a, b) => b.d - a.d).slice(0, 3);
  const downs = moves.filter(m => m.d < 0).sort((a, b) => a.d - b.d).slice(0, 3);
  const newbies = after.players.filter(p => day[p.id] && !was[p.id]);
  const facts = [
    best.length && `🏆 Без поразок: ${best.map(([id, d]) => `${Store.playerNick(id)} ${d.w}/${d.g}`).join(' | ')}`,
    ups.length && `📈 ${ups.map(m => `${m.p.nick} +${m.d}`).join(' | ')}`,
    downs.length && `📉 ${downs.map(m => `${m.p.nick} −${-m.d}`).join(' | ')}`,
    newbies.length && `🆕 Нові: ${newbies.map(p => p.nick).join(' | ')}`,
  ].filter(Boolean);
  if (facts.length) out.push(...facts, '');

  // Top 3 among players with enough games, with places gained/lost since before the day
  const minG = +db.settings.minGames || 3;
  const rank = st => st.players.filter(p => p.games >= minG).sort((a, b) => b.rating - a.rating);
  const oldPlace = Object.fromEntries(rank(before).map((p, i) => [p.id, i + 1]));
  const top = rank(after).slice(0, 3);
  if (top.length) {
    const mark = (p, i) => { const o = oldPlace[p.id]; return !o ? ' нов.' : o > i + 1 ? ` ↑${o - i - 1}` : o < i + 1 ? ` ↓${i + 1 - o}` : ''; };
    out.push(`🏅 Топ-3 (від ${minG} ігор): ${top.map((p, i) => `${i + 1}. ${p.nick} ${pts(p.rating)}%${mark(p, i)}`).join(' | ')}`, '');
  }
  out.push('📊 Твоя статистика: /mystats у @mafia_bcn_bot');
  return out.join('\n');
}

/* Post templates (Ukrainian). `day` is the game day picked next to the templates. */
const BOT_TEMPLATES = [   // labels are translated where shown
  { key: 'day', label: 'Day stats', kind: 'day', make: day => dayStatsText(day) || null },
  { key: 'last', label: 'Last game', kind: 'game', make: () => { const g = Store.sortedGames().find(x => x.winner); return g ? gameSummaryText(g) : null; } },
];
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
    $app.innerHTML = `<div class="empty">${t('Loading bot…')}</div>`;
    C.status = await attempt(() => Store.bot.status());
  }
  const st = C.status;
  if (!st) { $app.innerHTML = `<div class="empty">${t('Could not load the bot status.')}</div>`; return; }
  const connected = st.webhook && st.webhook.url === st.expectedUrl;
  const draft = UI.botDraft || {};
  const db = Store.get();
  const players = [...db.players].sort((a, b) => fullName(a).localeCompare(fullName(b)));
  const days = [...new Set(db.games.filter(g => g.winner).map(g => g.date))].sort().reverse();

  $app.innerHTML = `
    <div class="page-head"><h1>${t('Bot')} <span class="muted">@mafia_bcn_bot</span></h1></div>

    <div class="grid-2 cols-2">
      <section class="card">
        <h2>${t('Status')}</h2>
        ${!st.tokenSet ? (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)
            ? `<p class="muted">${t('Local copy: the bot token lives only in Cloudflare, so the bot works only on the live site. This is expected.')}</p>`
            : `<p class="warn-text">${t('TELEGRAM_BOT_TOKEN is not set in Cloudflare.')}</p>`) : connected
          ? `<p><span class="chip win">${t('Connected')}</span> ${t('The bot receives commands and group invites.')}</p>`
          : `<p><span class="chip warn">${t('Not connected')}</span> ${t('Press the button once (on the live site) so the bot can receive commands.')}</p>`}
        ${st.webhook && st.webhook.lastError ? `<p class="muted small">${t('Last Telegram error:')} ${h(st.webhook.lastError)}</p>` : ''}
        <div class="row gap wrap"><button class="btn ${connected ? 'ghost' : 'primary'}" id="botSetup">${connected ? t('Reconnect') : t('Connect bot')}</button><button class="btn ghost" id="statusRefresh" title="${t('Check the status again')}">↻ ${t('Refresh')}</button></div>
        <p class="muted small mt">${t('Receive messages: <b>{n}</b> who pressed Start.', { n: tn(st.subscribers, 'person') })}</p>
        <h3 class="mt">${t('Groups')}</h3>
        ${st.groups.length ? st.groups.map(c => `<div class="row gap"><span class="chip">${h(c.title || c.chat_id)}</span><span class="muted small">${c.type}</span></div>`).join('')
          : `<p class="muted small">${t('Not in any group yet. In Telegram open your group → Add members → search <b>@mafia_bcn_bot</b> → add. It then appears here (the bot must be connected first).')}</p>`}
      </section>

      <section class="card">
        <h2>${t('Commands')}</h2>
        <p class="muted small">${t('What players can send to the bot. Preview the answer as any player; nothing is sent.')}</p>
        <div class="cmd-list">${BOT_COMMANDS.map(c => `<button class="cmd ${c.cmd === (UI.botCmd || '/mystats') ? 'on' : ''}" data-cmd="${c.cmd}"><code>${c.cmd}</code><span class="muted small">${h(t(c.desc))}</span></button>`).join('')}</div>
        <label class="field"><span>${t('As player')}</span>
          <select id="cmdPlayer">
            <option value="">${t('Someone not linked yet')}</option>
            ${players.map(p => `<option value="${p.id}" ${p.id === UI.botCmdPlayer ? 'selected' : ''}>${h(fullName(p))} (No. ${p.number})</option>`).join('')}
          </select>
        </label>
        <div class="tg-preview" id="cmdPreview"></div>
      </section>

      <section class="card wide">
        <h2>${t('New post')}</h2>
        <div class="row gap wrap">
          <label class="field"><span>${t('Send to')}</span>
            <select id="botAudience">
              ${st.groups.map(c => `<option value="group:${h(c.chat_id)}" ${draft.audience === 'group' ? 'selected' : ''}>${t('Group')}: ${h(c.title || c.chat_id)}</option>`).join('')}
              <option value="subscribers" ${draft.audience === 'subscribers' ? 'selected' : ''}>${t('Everyone who started the bot')} (${st.subscribers})</option>
              <option value="person" ${draft.audience === 'person' ? 'selected' : ''}>${t('One person…')}</option>
              <option value="admins" ${draft.audience === 'admins' ? 'selected' : ''}>${t('Admins only (test)')}</option>
            </select>
          </label>
          <label class="field" id="personField" hidden><span>${t('Person')}</span><select id="botPerson"><option value="">${t('Loading…')}</option></select></label>
        </div>
        <div class="row gap wrap tpl-row">
          <span class="lbl">${t('Templates')}</span>
          ${BOT_TEMPLATES.map(tp => `<button class="btn small ghost" data-tpl="${tp.key}">${t(tp.label)}</button>`).join('')}
          <label class="field inline"><span>${t('Game day')}</span><select id="tplDay">${days.map(d => `<option value="${d}">${isoToDmy(d)}</option>`).join('') || '<option value="">—</option>'}</select></label>
        </div>
        <textarea id="botText" rows="12" maxlength="4000" placeholder="${t('Write your message… Links: [text](address)')}">${h(draft.text || '')}</textarea>
        <div class="tg-bubble post-preview" id="botPreview" title="${t('How it will look in Telegram')}"></div>
        <div class="row gap wrap"><span class="muted small" id="botCount"></span><span class="spacer"></span><button class="btn primary" id="botSend">${t('Send')}</button></div>
      </section>
    </div>

    <div class="tabs" role="tablist">
      <button class="tab ${T.active === 'history' ? 'on' : ''}" data-tab="history">${t('History')}</button>
      <button class="tab ${T.active === 'chats' ? 'on' : ''}" data-tab="chats">${t('Who receives messages')}</button>
      <span class="spacer"></span>
      <button class="btn small ghost" id="tabRefresh" ${T[T.active] ? '' : 'hidden'}>↻ ${t('Refresh')}</button>
    </div>
    <div id="tabBody"></div>
  `;

  /* ---- commands preview ---- */
  // A preview is asked from the server once per command + player; saved games/players change the key, so stats stay right.
  const dataKey = () => { const d = Store.get(); return `${d.games.length}:${d.players.length}:${JSON.stringify(d.games).length}:${JSON.stringify(d.players).length}`; };
  const show = html => { if ($('#cmdPreview')) $('#cmdPreview').innerHTML = `<div class="tg-bubble">${html.replace(/\n/g, '<br>')}</div><div class="row"><span class="spacer"></span><button class="btn small ghost" id="cmdReload" title="${t('Ask the server again')}">↻</button></div>`; if ($('#cmdReload')) $('#cmdReload').onclick = () => preview(true); };
  const preview = (force = false) => attempt(async () => {
    UI.botCmd = UI.botCmd || '/mystats';
    UI.botCmdPlayer = $('#cmdPlayer').value || null;
    const key = `${UI.botCmd}|${UI.botCmdPlayer || ''}|${dataKey()}`;
    if (!force && C.preview[key]) { show(C.preview[key]); return; }
    $('#cmdPreview').innerHTML = `<span class="muted small">${t('Loading…')}</span>`;
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
  const count = () => {
    $('#botCount').textContent = `${text.value.length} / 4000`;
    $('#botPreview').innerHTML = postHtml(text.value);
    $('#botPreview').hidden = !text.value.trim();
  };
  text.oninput = count; count();
  const loadChats = async () => { if (!T.chats) T.chats = (await Store.bot.chats()).chats; return T.chats; };
  const syncAudience = () => attempt(async () => {
    const isPerson = $('#botAudience').value === 'person';
    $('#personField').hidden = !isPerson;
    if (!isPerson) return;
    const people = (await loadChats()).filter(c => c.status === 'active');
    $('#botPerson').innerHTML = people.length
      ? people.map(c => `<option value="${h(c.chat_id)}" ${c.chat_id === draft.chatId ? 'selected' : ''}>${h(c.nickname || c.title || c.chat_id)}${c.username ? ' @' + h(c.username) : ''}${c.nickname ? '' : ` (${t('not linked')})`}</option>`).join('')
      : `<option value="">${t('Nobody has pressed Start yet')}</option>`;
    if (T.active === 'chats') renderTab();
  });
  $('#botAudience').onchange = syncAudience;
  syncAudience();
  $$('[data-tpl]').forEach(b => b.onclick = () => {
    const tp = BOT_TEMPLATES.find(x => x.key === b.dataset.tpl);
    const val = tp.make($('#tplDay').value);
    if (!val) { toast(t('No finished games for this template yet')); return; }
    if (text.value.trim() && !confirm(t('Replace the current text with the template?'))) return;
    text.value = val; count();
    draft.kind = tp.kind;   // stored with the post (day / game), not shown
  });
  $('#botSetup').onclick = () => attempt(async () => { C.status = await Store.bot.setup(); toast(t('Bot connected')); viewBot(); });
  $('#statusRefresh').onclick = () => viewBot({ refresh: true });

  // sending happens in batches: keep asking the server until nothing is left
  const drain = async (id, label) => {
    let r = { remaining: 1 }, guard = 0;
    while (r.remaining > 0 && guard++ < 50) { r = await Store.bot.process(id); if (r.remaining) toast(`${label}… ${t('{n} left', { n: r.remaining })}`); }
  };
  const afterChange = async () => { if (T.history) { T.history = (await Store.bot.posts()).posts; if (T.active === 'history') renderTab(); } };
  $('#botSend').onclick = () => attempt(async () => {
    const val = $('#botAudience').value;
    if (!val) throw new Error(t('Choose who receives it'));
    const [audience, chatId] = val.startsWith('group:') ? ['group', val.slice(6)] : val === 'person' ? ['person', $('#botPerson').value] : [val, null];
    if (audience === 'person' && !chatId) throw new Error(t('Choose the person'));
    const who = audience === 'group' || audience === 'person'
      ? (audience === 'person' ? $('#botPerson') : $('#botAudience')).selectedOptions[0].textContent
      : audience === 'subscribers' ? t('{n} who started the bot', { n: tn(st.subscribers, 'person') }) : t('admins only');
    if (!text.value.trim()) throw new Error(t('The message is empty'));
    if (!confirm(t('Send this message to {who}?', { who }))) return;
    $('#botSend').disabled = true;
    const r = await Store.bot.send({ text: text.value, audience, chatId, kind: draft.kind || 'announcement', gameId: draft.gameId || null });
    if (r.remaining) await drain(r.id, t('Sending'));
    UI.botDraft = null;
    text.value = ''; count();
    toast(t('Sent'));
    await afterChange();
  }).finally(() => { if ($('#botSend')) $('#botSend').disabled = false; });

  /* ---- tabs: History / Who receives messages ---- */
  const fmtWhen = ts => ts ? new Date(ts.replace(' ', 'T') + 'Z').toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const age = ts => (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 3600e3;
  const audienceLabel = p => p.audience === 'person' ? t('To {who}', { who: p.first_title || t('one person') }) : ({ group: t('Group'), subscribers: t('Subscribers'), admins: t('Admins') }[p.audience] || p.audience);
  const load = key => attempt(async () => {
    $('#tabBody').innerHTML = `<div class="card muted">${t('Loading…')}</div>`;
    if (key === 'history') T.history = (await Store.bot.posts()).posts;
    else T.chats = (await Store.bot.chats()).chats;
    renderTab();
  });
  function renderTab() {
    const key = T.active, data = T[key];
    $('#tabRefresh').hidden = !data;
    if (!data) {
      $('#tabBody').innerHTML = `<div class="card tab-empty"><p class="muted">${key === 'history' ? t('Sent posts, newest first.') : t('People who pressed Start in the bot.')} ${t('Not loaded yet.')}</p><button class="btn" id="tabLoad">${key === 'history' ? t('Load history') : t('Load list')}</button></div>`;
      $('#tabLoad').onclick = () => load(key);
      return;
    }
    if (key === 'chats') {
      const active = data.filter(c => c.status === 'active').length;
      $('#tabBody').innerHTML = `<section class="card">
        <p class="muted small">${t('{n} receive messages · only people who pressed <b>Start</b>. Linked players can use /mystats.', { n: active })}</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Telegram</th><th>${t('Player')}</th><th>${t('Since')}</th><th></th></tr></thead>
          <tbody>${data.map(c => `<tr class="${c.status === 'active' ? '' : 'dead'}">
            <td>${h(c.title || '')} ${c.username ? `<span class="muted">@${h(c.username)}</span>` : ''}</td>
            <td>${c.nickname ? h(c.nickname) : `<a href="/players" class="muted small">${t('not linked')}</a>`}${c.role === 'admin' ? ` <span class="chip admin">${t('admin')}</span>` : ''}</td>
            <td class="muted small">${h(isoToDmy((c.started_at || '').slice(0, 10)))}</td>
            <td class="muted small">${c.status === 'active' ? '' : t('stopped')}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">${t('Nobody yet.')}</td></tr>`}</tbody>
        </table></div></section>`;
      return;
    }
    $('#tabBody').innerHTML = data.length ? data.map(p => {
      const old = age(p.created_at) > 48;
      return `<section class="card post ${p.deleted_at ? 'deleted' : ''}" data-post="${p.id}">
        <div class="row gap wrap post-head">
          <b>${fmtWhen(p.created_at)}</b>
          <span class="chip">${h(audienceLabel(p))}</span>
          ${p.deleted_at ? `<span class="chip loss">${t('deleted')}</span>` : ''}
          ${p.edited_at ? `<span class="muted small">${t('edited')} ${fmtWhen(p.edited_at)}</span>` : ''}
          <span class="spacer"></span>
          <span class="muted small">✓ ${p.sent} ${t('sent')}${p.failed ? ` · ✗ ${p.failed} ${t('failed')}` : ''}${p.pending ? ` · ${p.pending} ${t('waiting')}` : ''}${p.deleted ? ` · 🗑 ${p.deleted}` : ''}</span>
        </div>
        <div class="post-text">${postHtml(p.text)}</div>
        ${p.errors ? `<p class="muted small warn-text">${h(p.errors)}</p>` : ''}
        ${p.deleted_at ? '' : `<div class="row gap">
          ${p.pending ? `<button class="btn small" data-continue="${p.id}">${t('Continue sending')}</button>` : ''}
          <button class="btn small ghost" data-edit-post="${p.id}">${t('Edit')}</button>
          <button class="btn small ghost danger-text" data-del-post="${p.id}" ${old ? `title="${t('Telegram only allows deleting messages within 48 hours — it will be removed from this list, but may stay in Telegram')}"` : ''}>${t('Delete')}${old ? ` (${t('older than 48 h')})` : ''}</button>
        </div>`}
      </section>`;
    }).join('') : `<div class="card muted">${t('Nothing sent yet.')}</div>`;

    $$('[data-continue]').forEach(b => b.onclick = () => attempt(async () => { await drain(+b.dataset.continue, t('Sending')); await afterChange(); }));
    $$('[data-edit-post]').forEach(b => b.onclick = () => {
      const card = b.closest('.post');
      const p = data.find(x => x.id === +b.dataset.editPost);
      card.querySelector('.post-text').outerHTML = `<textarea class="post-edit" rows="7" maxlength="4000">${h(p.text)}</textarea>`;
      b.outerHTML = `<button class="btn small primary" data-save-post="${p.id}">${t('Save edit')}</button>`;
      card.querySelector('[data-save-post]').onclick = () => attempt(async () => {
        const txt = card.querySelector('.post-edit').value;
        if (!confirm(t('Update this message in Telegram ({chats})?', { chats: tn(p.sent, 'chat') }))) return;
        const r = await Store.bot.edit(p.id, txt);
        if (r.remaining) await drain(p.id, t('Updating'));
        toast(t('Updated'));
        await afterChange();
      });
    });
    $$('[data-del-post]').forEach(b => b.onclick = () => attempt(async () => {
      const p = data.find(x => x.id === +b.dataset.delPost);
      if (!confirm(t('Delete this message from Telegram ({chats})?', { chats: tn(p.sent, 'chat') }))) return;
      const r = await Store.bot.remove(p.id);
      if (r.remaining) await drain(p.id, t('Deleting'));
      toast(t('Deleted'));
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
  applyStaticTexts();
  document.querySelectorAll('[data-lang]').forEach(b => b.onclick = () => { if (b.dataset.lang !== I18N.lang) { setLang(b.dataset.lang); route(); } });
  document.getElementById('menuBtn').onclick = () => setMenu(document.getElementById('drawer').hidden);
  document.getElementById('drawerClose').onclick = () => setMenu(false);
  document.getElementById('drawerBackdrop').onclick = () => setMenu(false);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.getElementById('drawer').hidden) setMenu(false); });
  $app.innerHTML = `<div class="empty">${t('Loading…')}</div>`;
  // Old links looked like /#/game/…; turn them into plain paths
  if (location.hash.startsWith('#/')) history.replaceState(null, '', (location.hash.slice(1) || '/') + location.search);
  currentPath = location.pathname;
  await Store.init();
  route();
})();
