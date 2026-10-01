// Headless check of a built map: no console/page errors, and stats, search, filters, list and
// detail panel all work. Prints counts only (no member data). Exit code 1 on any failure.
// Usage: node scripts/verify-map.mjs [dist/gbca-member-map.html]
// Chromium must trust the HTTPS proxy CA, if any, or basemap tiles log errors (see docs/weekly-refresh.md).
import { chromium } from 'playwright-core';
import { resolve } from 'node:path';

const file = resolve(process.argv[2] || 'dist/gbca-member-map.html');
const executablePath = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath });
const p = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });
p.on('pageerror', (e) => errors.push('page: ' + e.message));
await p.goto('file://' + file, { waitUntil: 'load' });
await p.waitForTimeout(2500);

const text = (id) => p.locator('#' + id).innerText();
const listCount = async () => Number(await text('list-count'));
const settle = () => p.waitForTimeout(400);
const r = {};
r.members = Number(await text('st-members'));
r.mapped = Number(await text('st-mapped'));
r.counties = Number(await text('st-counties'));
r.list = await listCount();
await p.fill('#q', 'construction'); await settle();
r.search = await listCount(); r.searchDropdown = await p.locator('#results').isVisible();
await p.fill('#q', ''); await settle();
const cats = p.locator('#cats input[type=checkbox]');
r.types = await cats.count();
await cats.first().uncheck(); await settle(); r.oneTypeOff = await listCount();
await cats.first().check(); await settle();
await p.selectOption('#region', { index: 1 }); await settle(); r.firstRegion = await listCount();
await p.selectOption('#region', ''); await settle();
await p.click('.seg-btn[data-view=list]'); await settle();
r.listRows = await p.locator('#list-table tbody tr').count();
await p.locator('#list-table tbody tr').first().click(); await settle();
r.detailOpens = await p.locator('#detail').isVisible();
await p.click('#btn-reset'); await settle(); r.afterReset = await listCount();
await browser.close();

const fail = [];
if (errors.length) fail.push(`${errors.length} console/page errors: ${[...new Set(errors)].slice(0, 3).join(' | ')}`);
if (!(r.members > 0 && r.list === r.members && r.listRows === r.members)) fail.push('member count, list count and list rows disagree');
if (!(r.search > 0 && r.search < r.members && r.searchDropdown)) fail.push('search did not narrow the list');
if (!(r.oneTypeOff < r.members)) fail.push('type filter had no effect');
if (!(r.firstRegion > 0 && r.firstRegion < r.members)) fail.push('region filter had no effect');
if (!r.detailOpens) fail.push('detail panel did not open');
if (r.afterReset !== r.members) fail.push('reset did not restore all members');
console.log(JSON.stringify(r));
if (fail.length) { console.error('VERIFY FAILED: ' + fail.join('; ')); process.exit(1); }
console.log('VERIFY OK');
