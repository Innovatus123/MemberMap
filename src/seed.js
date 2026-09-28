// Interim data source for the first draft, until the GrowthZone sync can run.
// Both inputs are GrowthZone exports that staff saved to SharePoint:
//   data/seed/addresses.tsv    - 2026 Membership Directory mailing list (Sep 3, 2026): roster + mailing addresses
//   data/seed/memberships.tsv  - GrowthZone Contacts Report (May 25, 2026): membership type/tier + primary contact
// The newer mailing list defines who is on the map. Membership type comes from the contacts report.
import { readTsv, writeJson, toCsv, p } from './lib/io.js';
import { nameKey, parseMembershipType, makeMember } from './lib/normalize.js';
import fs from 'node:fs';

// Same company, different name in the two exports (confirmed by matching primary-contact email).
const ALIASES = {
  'l w supply': 'abc supply interiors',
  'construction connectivity': 'climit',
  'horn williamson': 'horn williamson collins',
  'keller': 'keller north america',
};

export function seed({ addresses, memberships }) {
  const typeByKey = new Map();
  for (const m of memberships) {
    const k = nameKey(m.name);
    typeByKey.set(ALIASES[k] || k, m);
  }

  const members = [];
  const issues = [];
  const matched = new Set();

  for (const a of addresses) {
    const k = nameKey(a.name);
    const m = typeByKey.get(k);
    if (m) matched.add(k);
    const t = parseMembershipType(m?.type);
    const rec = makeMember({
      company: a.name,
      ...t,
      addr1: a.addr1,
      addr2: a.addr2,
      city: a.city,
      state: a.state,
      zip: a.zip,
      email: a.email,
      contactName: m ? `${m.first} ${m.last}`.trim() : '',
      source: 'seed:2026-09-03 MD mailing list',
    });
    members.push(rec);
    if (!m) issues.push({ company: a.name, issue: 'Not in May 2026 contacts report - membership type unknown (new member since May?)' });
  }

  for (const [k, m] of typeByKey) {
    if (!matched.has(k)) {
      issues.push({ company: m.name, issue: 'In May 2026 contacts report but not on Sep 2026 mailing list - dropped, renamed, or missing address? Not mapped.' });
    }
  }
  return { members, issues };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const addresses = readTsv(p('data/seed/addresses.tsv'));
  const memberships = readTsv(p('data/seed/memberships.tsv'));
  const { members, issues } = seed({ addresses, memberships });
  writeJson(p('data/members.json'), { generatedAt: new Date().toISOString(), source: 'seed', members });
  fs.mkdirSync(p('reports'), { recursive: true });
  fs.writeFileSync(p('reports/reconciliation.csv'), toCsv(issues, ['company', 'issue']));
  console.log(`seed: ${members.length} members, ${issues.length} reconciliation items -> reports/reconciliation.csv`);
}
