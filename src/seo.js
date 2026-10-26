/* ============================================================
   Search engines and link previews.

   - Every page is the same index.html; before sending it, the Worker fills the block between
     <!-- seo --> and <!-- /seo --> with the page's own title, description, canonical address,
     language alternates (uk = default address, en = ?lang=en) and Open Graph tags
     (the preview card in Telegram / WhatsApp / Google).
   - Only the home page (dashboard) and /about are offered to search engines (sitemap + index).
     Every other page (games, players, compare, admin) gets "noindex": it still has a proper title and
     link preview for Telegram, but people's pages don't turn up in Google searches.
   ============================================================ */

const T = {
  uk: {
    home: ['Mafia BCN — Мафія в Барселоні: статистика, рейтинг, титули',
      'Mafia BCN — україномовна спільнота гри в Мафію в Барселоні. Результати всіх ігор, чесний рейтинг гравців, титули, ролі та особиста статистика.'],
    games: ['Ігри — Mafia BCN', 'Усі ігри Mafia BCN у Барселоні: дати, ролі, ночі, голосування і хто переміг — мирні чи мафія.'],
    game: ['Гра #{n} · {date} — Mafia BCN', 'Гра #{n} від {date}: ролі гравців, нічні дії, висування, голосування та результат.'],
    players: ['Гравці — Mafia BCN', 'Гравці Mafia BCN: рейтинг, кількість ігор, перемоги та остання гра кожного.'],
    player: ['{nick} — статистика гравця · Mafia BCN', '{nick}: рейтинг, перемоги, ролі (мирний, шериф, лікар, маніяк, мафія, дон) та історія ігор у Mafia BCN.'],
    compare: ['Порівняння гравців — Mafia BCN', 'Порівняйте статистику двох гравців Mafia BCN: рейтинг, перемоги, ролі та титули.'],
    pair: ['{a} vs {b} — порівняння гравців · Mafia BCN', 'Хто грає краще: {a} чи {b}? Рейтинг, перемоги, ролі та титули двох гравців Mafia BCN.'],
    about: ['Про Mafia BCN — україномовна Мафія в Барселоні', 'Хто ми, як грається Мафія, які є ролі і що можна знайти на сайті Mafia BCN. Нові гравці завжди бажані.'],
    locale: 'uk_UA',
  },
  en: {
    home: ['Mafia BCN — Mafia games in Barcelona: stats, ratings, titles',
      'Mafia BCN is a Ukrainian-speaking community playing the Mafia party game in Barcelona. Results of every game, a fair player rating, titles, roles and personal stats.'],
    games: ['Games — Mafia BCN', 'All Mafia BCN games in Barcelona: dates, roles, nights, votes and who won — the citizens or the mafia.'],
    game: ['Game #{n} · {date} — Mafia BCN', 'Game #{n} of {date}: player roles, night actions, nominations, votes and the result.'],
    players: ['Players — Mafia BCN', 'Mafia BCN players: rating, games played, wins and the last game of each player.'],
    player: ['{nick} — player stats · Mafia BCN', '{nick}: rating, wins, roles (citizen, sheriff, doctor, maniac, mafia, don) and game history at Mafia BCN.'],
    compare: ['Compare players — Mafia BCN', 'Compare the stats of two Mafia BCN players: rating, wins, roles and titles.'],
    pair: ['{a} vs {b} — player comparison · Mafia BCN', 'Who plays better: {a} or {b}? Rating, wins, roles and titles of two Mafia BCN players.'],
    about: ['About Mafia BCN — Ukrainian-speaking Mafia in Barcelona', 'Who we are, how Mafia is played, which roles there are and what you can find on the Mafia BCN site. New players are always welcome.'],
    locale: 'en_GB',
  },
};
const INDEXED = /^\/(dashboard|about)?$/;   // everything else: noindex
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));

/* Same slug rules as compare links in public/js/app.js (nick → "micro", "orsini-f"; empty/numeric/shared → "p<No.>") */
const SLUG_TR = { а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'io', ъ: '', "'": '', '’': '' };
const slugify = s => String(s || '').toLowerCase().replace(/♀/g, ' f').replace(/♂/g, ' m').replace(/./gu, c => SLUG_TR[c] ?? c)
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function findBySlug(players, key) {
  key = String(key).toLowerCase();
  if (/^\d+$/.test(key)) return players.find(p => String(p.number) === key) || null;
  const raw = players.map(p => [p, slugify(p.nickname)]);
  const count = {};
  raw.forEach(([, s]) => { count[s] = (count[s] || 0) + 1; });
  const hit = raw.find(([p, s]) => (s && !/^\d+$/.test(s) && count[s] === 1 ? s : `p${p.number}`) === key);
  return hit ? hit[0] : null;
}

async function publicData(env, key) {
  try { const v = env.KV ? await env.KV.get(key) : null; return v ? JSON.parse(v) : null; } catch { return null; }
}

/** Title + description for a path (player pages look up the nick in the public data copy). */
async function pageMeta(env, path, lang, snapshotKey) {
  const L = T[lang];
  let m;
  if ((m = path.match(/^\/game\/(\d{2})-(\d{2})-(\d{4})\/(\d+)$/))) {
    const v = { n: m[4], date: `${m[1]}/${m[2]}/${m[3]}` };
    return [fill(L.game[0], v), fill(L.game[1], v)];
  }
  if ((m = path.match(/^\/player\/(\d+)$/))) {
    const data = await publicData(env, snapshotKey);
    const p = data && (data.players || []).find(x => String(x.number) === m[1]);
    if (p) { const v = { nick: p.nickname }; return [fill(L.player[0], v), fill(L.player[1], v)]; }
    return L.players;
  }
  if ((m = path.match(/^\/compare\/([^/]+?)-vs-([^/]+)$/))) {
    // shared links (Share button) show both nicks in the Telegram preview
    const data = await publicData(env, snapshotKey);
    const a = data && findBySlug(data.players || [], decodeURIComponent(m[1])), b = data && findBySlug(data.players || [], decodeURIComponent(m[2]));
    if (a && b) { const v = { a: a.nickname, b: b.nickname }; return [fill(L.pair[0], v), fill(L.pair[1], v)]; }
  }
  if (path.startsWith('/compare')) return L.compare;
  const key = { '/': 'home', '/dashboard': 'home', '/games': 'games', '/players': 'players', '/about': 'about' }[path];
  return L[key || 'home'];
}

/** index.html with this page's title, description, language links and preview tags. */
export async function seoPage(request, env, url, snapshotKey) {
  const res = await env.ASSETS.fetch(new Request(new URL('/', url), request));
  if (!res.ok || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  const html = await res.text();
  const site = (env.SITE_URL || url.origin).replace(/\/$/, '');
  const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'uk';
  const path = url.pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '') || '/';
  const [title, desc] = await pageMeta(env, path, lang, snapshotKey);
  const ukUrl = site + path, enUrl = `${site}${path}?lang=en`;
  const self = lang === 'en' ? enUrl : ukUrl;
  const img = `${site}/android-chrome-512x512.png`;
  const tags = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    INDEXED.test(path) ? `<link rel="canonical" href="${esc(path === '/dashboard' ? (lang === 'en' ? `${site}/?lang=en` : `${site}/`) : self)}">` : '<meta name="robots" content="noindex, follow">',
    `<link rel="alternate" hreflang="uk" href="${esc(ukUrl)}">`,
    `<link rel="alternate" hreflang="en" href="${esc(enUrl)}">`,
    `<link rel="alternate" hreflang="x-default" href="${esc(ukUrl)}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Mafia BCN">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(self)}">`,
    `<meta property="og:image" content="${esc(img)}">`,
    '<meta property="og:image:width" content="512"><meta property="og:image:height" content="512">',
    '<meta property="og:image:alt" content="Mafia BCN">',
    `<meta property="og:locale" content="${T[lang].locale}"><meta property="og:locale:alternate" content="${T[lang === 'en' ? 'uk' : 'en'].locale}">`,
    '<meta name="twitter:card" content="summary">',
    path === '/' || path === '/dashboard'
      ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Mafia BCN', url: site + '/', description: desc, inLanguage: ['uk', 'en'] })}</script>`
      : '',
  ].filter(Boolean).join('\n  ');
  const out = html
    .replace(/<html lang="[^"]*">/, `<html lang="${lang}">`)
    .replace(/<!-- seo -->[\s\S]*?<!-- \/seo -->/, `<!-- seo -->\n  ${tags}\n  <!-- /seo -->`);
  const headers = new Headers(res.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.delete('content-length');
  headers.delete('etag');
  return new Response(out, { status: 200, headers });
}

/** /sitemap.xml: the home page and /about, each in Ukrainian and English. */
export async function sitemap(env, url, snapshotKey) {
  const site = (env.SITE_URL || url.origin).replace(/\/$/, '');
  const data = (await publicData(env, snapshotKey)) || { games: [] };
  const lastGame = (data.games || []).reduce((d, g) => (g.date > d ? g.date : d), '');
  const pages = [{ path: '/', mod: lastGame, pr: '1.0' }, { path: '/about', pr: '0.8' }];
  const entry = ({ path, mod, pr }) => {
    const uk = site + path, en = `${site}${path}?lang=en`;
    const alt = `<xhtml:link rel="alternate" hreflang="uk" href="${esc(uk)}"/><xhtml:link rel="alternate" hreflang="en" href="${esc(en)}"/>`;
    return [uk, en].map(loc => `<url><loc>${esc(loc)}</loc>${alt}${mod ? `<lastmod>${mod}</lastmod>` : ''}<priority>${pr}</priority></url>`).join('\n');
  };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${pages.map(entry).join('\n')}\n</urlset>\n`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}
