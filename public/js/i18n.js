/* ============================================================
   LANGUAGES — Ukrainian (default) and English.

   Texts in the code are written in English and wrapped in t('…'). The Ukrainian
   words live in /js/lang/uk.js (one flat dictionary: English text → Ukrainian).
   A text missing from the dictionary simply shows in English.

     t('Games played')                       → "Зіграно ігор"
     t('Round {n}', { n: 2 })                → "Раунд 2"
     tn(3, 'game')                           → "3 гри" / "3 games"   (plural forms below)

   The choice is kept per browser (localStorage "mbcn.lang").
   ============================================================ */
'use strict';

const LANGS = { uk: 'UA', en: 'EN' };
const I18N = {
  lang: (() => { try { return localStorage.getItem('mbcn.lang') === 'en' ? 'en' : 'uk'; } catch { return 'uk'; } })(),
  dict: { uk: {} },   // filled by /js/lang/uk.js
};

/** Translate an English text; {name} placeholders are filled from vars. */
function t(text, vars) {
  let out = I18N.lang === 'en' ? text : (I18N.dict[I18N.lang] || {})[text] ?? text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return out;
}

/* Plural forms: English has 2 (1 game / 2 games), Ukrainian 3 (1 гра / 2 гри / 5 ігор). */
const PLURALS = {
  game: { en: ['game', 'games'], uk: ['гра', 'гри', 'ігор'] },
  round: { en: ['round', 'rounds'], uk: ['раунд', 'раунди', 'раундів'] },
  player: { en: ['player', 'players'], uk: ['гравець', 'гравці', 'гравців'] },
  change: { en: ['change', 'changes'], uk: ['зміна', 'зміни', 'змін'] },
  person: { en: ['person', 'people'], uk: ['людина', 'людини', 'людей'] },
  chat: { en: ['chat', 'chats'], uk: ['чат', 'чати', 'чатів'] },
  day: { en: ['day', 'days'], uk: ['день', 'дні', 'днів'] },
  role: { en: ['role', 'roles'], uk: ['роль', 'ролі', 'ролей'] },
  win: { en: ['win', 'wins'], uk: ['перемога', 'перемоги', 'перемог'] },
  nomination: { en: ['nomination', 'nominations'], uk: ['номінація', 'номінації', 'номінацій'] },
  seat: { en: ['seat', 'seats'], uk: ['місце', 'місця', 'місць'] },
  vote: { en: ['vote', 'votes'], uk: ['голос', 'голоси', 'голосів'] },
};
function pluralIndex(n, lang) {
  n = Math.abs(n);
  if (lang !== 'uk') return n === 1 ? 0 : 1;
  const d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return 0;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return 1;
  return 2;
}
/** Number + word in the right form: tn(5, 'game') → "5 ігор". With bare = true only the word. */
function tn(n, word, bare = false) {
  const forms = (PLURALS[word] || {})[I18N.lang] || (PLURALS[word] || {}).en || [word];
  const w = forms[Math.min(pluralIndex(n, I18N.lang), forms.length - 1)];
  return bare ? w : `${n} ${w}`;
}

/** Locale for dates and numbers. */
const locale = () => (I18N.lang === 'uk' ? 'uk-UA' : 'en-GB');
const roleLabel = r => t(ROLES[r].label);
const teamLabel = w => t(TEAM_LABEL[w]);

/** Texts that live in index.html (menu, page title): elements with data-i18n="English text". */
function applyStaticTexts() {
  document.documentElement.lang = I18N.lang;
  document.title = t('Mafia BCN — Game Log');
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('on', b.dataset.lang === I18N.lang));
}
function setLang(lang) {
  I18N.lang = LANGS[lang] ? lang : 'uk';
  try { localStorage.setItem('mbcn.lang', I18N.lang); } catch { /* private mode: the choice lasts until reload */ }
  applyStaticTexts();
}
