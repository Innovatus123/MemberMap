// Compares the members embedded in two built maps (previous vs new). Prints counts, members
// added or dropped, and type/tier/region/placement changes by company name only.
// Usage: node scripts/diff-maps.mjs <previous.html> <new.html>
import { readFileSync } from 'node:fs';

function members(file) {
  const m = readFileSync(file, 'utf8').match(/<script type="application\/json" id="app-data">([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`no app-data block in ${file}`);
  const { cols, rows } = JSON.parse(m[1]).members;
  return rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}
const [prev, next] = process.argv.slice(2).map(members);
const byId = (list) => new Map(list.map((x) => [String(x.id), x]));
const p = byId(prev), n = byId(next);
const count = (list, k) => list.reduce((o, x) => ((o[x[k] || '(none)'] = (o[x[k] || '(none)'] || 0) + 1), o), {});
const changes = [];
for (const [id, x] of n) {
  const y = p.get(id);
  if (!y) continue;
  for (const k of ['company', 'category', 'tier', 'region', 'precision']) {
    if ((x[k] || '') !== (y[k] || '')) changes.push(`${x.company}: ${k} ${y[k] || '-'} -> ${x[k] || '-'}`);
  }
}
console.log(JSON.stringify({
  previous: { total: prev.length, byType: count(prev, 'category'), byPrecision: count(prev, 'precision') },
  current: { total: next.length, byType: count(next, 'category'), byPrecision: count(next, 'precision'), byRegion: count(next, 'region') },
  added: next.filter((x) => !p.has(String(x.id))).map((x) => `${x.company} (${x.category})`),
  dropped: prev.filter((x) => !n.has(String(x.id))).map((x) => `${x.company} (${x.category})`),
  changed: changes,
}, null, 1));
