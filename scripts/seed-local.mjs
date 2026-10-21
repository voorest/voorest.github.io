// Fill the LOCAL development database (wrangler dev) with a copy of the real data.
//
//   1. On the live site: Data → "Full backup" → save it into the data/ folder
//   2. npm run seed:local            (uses the newest data/mafia-bcn-backup-*.json)
//      npm run seed:local -- <file>  (or a specific file)
//
// Only touches the local copy in .wrangler/ — never the real database.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const dataDir = path.resolve('data');
let file = process.argv[2];
if (!file) {
  const found = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter(f => /^mafia-bcn-backup-.*\.json$/.test(f)).sort() : [];
  if (found.length) file = path.join(dataDir, found[found.length - 1]);
}

// Tables we fill (parents first). accounts and sessions are not copied: locally you log in with the "Dev login" button
const ORDER = ['players', 'games', 'game_seats', 'nominations', 'round_events', 'settings'];

// Always create/update the tables first.
execSync('npx wrangler d1 migrations apply mafia-bcn --local', { stdio: 'inherit' });

if (!file) {
  // No backup yet: fall back to the original spreadsheet import, if present.
  const legacy = path.join(dataDir, 'import.sql');
  if (fs.existsSync(legacy)) {
    console.log('No backup found — loading data/import.sql (the original spreadsheet import).');
    // Empty the tables first, so running this again (or over older local data) doesn't clash
    const wipe = ['PRAGMA defer_foreign_keys = ON;', ...ORDER.filter(t => t !== 'settings').reverse().map(t => `DELETE FROM ${t};`)];
    const sql = fs.readFileSync(legacy, 'utf8').replace('PRAGMA defer_foreign_keys = ON;', '');
    const out = path.join(dataDir, 'seed-local.sql');
    fs.writeFileSync(out, [...wipe, sql, 'UPDATE players SET number = id WHERE number IS NULL;'].join('\n'));
    execSync(`npx wrangler d1 execute mafia-bcn --local --file="${out}"`, { stdio: 'inherit' });
    console.log('\nDone. Now run:  npm run dev   and open http://localhost:8787');
  } else {
    console.log('Tables created, but no data: save a Full backup from the live site (Data page) into data/ and run this again.');
  }
  process.exit(0);
}
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
const T = backup.tables;
const q = v => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

const order = ORDER;
const lines = ['PRAGMA defer_foreign_keys = ON;'];
for (const t of [...order].reverse()) lines.push(`DELETE FROM ${t};`);
for (const t of order) {
  for (const row of T[t] || []) {
    const cols = Object.keys(row);
    lines.push(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(c => q(row[c])).join(', ')});`);
  }
}
// Backups made before player numbers were stored: number = id
lines.push('UPDATE players SET number = id WHERE number IS NULL;');
const out = path.join(dataDir, 'seed-local.sql');
fs.writeFileSync(out, lines.join('\n'));
console.log(`Wrote ${out} from ${path.basename(file)} (${(T.games || []).length} games, ${(T.players || []).length} players)`);

execSync(`npx wrangler d1 execute mafia-bcn --local --file="${out}"`, { stdio: 'inherit' });
console.log('\nDone. Now run:  npm run dev   and open http://localhost:8787');
