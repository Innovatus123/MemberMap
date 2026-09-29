// Merge the pipeline's exception reports into one staff worklist: reports/data-cleanup.csv.
// Every fix belongs in GrowthZone so the next sync picks it up.
import fs from 'node:fs';
import { parseCsv, toCsv, p } from './lib/io.js';

const ACTIONS = [
  [/PO box/, 'Get the physical street address from the member and add it in GrowthZone as a Physical address.'],
  [/No address/, 'Add the physical street address in GrowthZone.'],
  [/Could not locate/, 'Correct the address in GrowthZone (city/ZIP look wrong).'],
  [/Street address not matched/, 'Check the street line in GrowthZone: street number first, suite/building names in line 2, no route shorthand.'],
  [/ZIP\/state mismatch/, 'Correct the ZIP code or state in GrowthZone.'],
  [/membership type unknown/, 'Confirm membership type in GrowthZone (joined after May 2026?).'],
  [/not on Sep 2026 mailing list/, 'Confirm status: if still a member, add a mailing/physical address; if dropped, no action.'],
];

function rows(file) {
  if (!fs.existsSync(file)) return [];
  const [header, ...body] = parseCsv(fs.readFileSync(file, 'utf8'));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const items = [...rows(p('reports/needs-attention.csv')), ...rows(p('reports/reconciliation.csv'))]
  .map((r) => ({
    Company: r.company,
    Issue: r.issue,
    Detail: r.detail || '',
    'Suggested action': (ACTIONS.find(([re]) => re.test(r.issue)) || [, ''])[1],
    Owner: 'Membership',
    Done: '',
  }))
  .sort((a, b) => a.Issue.localeCompare(b.Issue) || a.Company.localeCompare(b.Company));

fs.writeFileSync(p('reports/data-cleanup.csv'), toCsv(items, ['Company', 'Issue', 'Detail', 'Suggested action', 'Owner', 'Done']));
console.log(`cleanup: ${items.length} items -> reports/data-cleanup.csv`);
