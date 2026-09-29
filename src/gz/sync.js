// Pull member organizations from GrowthZone -> data/members.json (same shape as src/seed.js).
//
//   npm run sync               full pull of members in the configured statuses
//   npm run sync -- --discover  record the field names each endpoint returns (no values) to
//                               reports/gz-discovery.json; run this first to confirm the field map
//
// Field names were confirmed against GBCA's database with --discover. Re-run it if GrowthZone
// changes its response shapes; pick() still degrades a renamed field to a blank, not a failed run.
import fs from 'node:fs';
import { clientFromEnv } from './client.js';
import { loadConfig, writeJson, p } from '../lib/io.js';
import { makeMember, parseMembershipType } from '../lib/normalize.js';

/** First non-empty value among candidate keys (case-insensitive). */
export function pick(obj, keys) {
  if (!obj) return '';
  const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) {
    const v = lower[k.toLowerCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}

// Field names confirmed against GBCA's database with --discover (2026-09-29).
const F = {
  contactId: ['ContactId'],
  orgName: ['ContactDisplayName', 'Name'],
  typeId: ['MembershipTypeId'],
  // On /memberships/all rows, Type is the membership type name and Name is the organization.
  // On /memberships/types rows, Type is an icon class and Name is the type name.
  typeName: ['Type'],
  joinDate: ['StartDate'],
  line1: ['Address1'],
  line2: ['Address2'],
  city: ['City'],
  state: ['StateProvince'],
  zip: ['PostalCode'],
};

// OrgGeneral.ContactInfos[].Type
const INFO = { email: 1, phone: 2, address: 3, web: 4 };
// ContactInfos[].AddressType for address entries (TypeName "Physical and Mailing", "Mailing", "Physical")
const ADDR = { physicalAndMailing: 1, mailing: 2, physical: 3 };
// OrgGeneral.SystemContactTypeId / memberships/types OwnerContactTypeId
const ORGANIZATION = 2;

/**
 * Attach each address's type from OrgGeneral.ContactInfos (linked by EntryId -> ContactAddresses.Id),
 * so chooseAddress can rank them. Addresses with no matching info keep AddressType undefined.
 */
export function typedAddresses(addresses, contactInfos = []) {
  const info = new Map((contactInfos || []).filter((i) => i.Type === INFO.address).map((i) => [i.EntryId, i]));
  return (Array.isArray(addresses) ? addresses : []).map((a) => {
    const i = info.get(a.Id ?? a.ContactAddressId);
    return { ...a, AddressType: i?.AddressType, AddressTypeName: i?.TypeName, IsPrimary: Boolean(i?.IsPrimary) };
  });
}

/** Prefer a physical address, then the primary one; fall back to mailing; PO boxes last. */
export function chooseAddress(addresses) {
  const list = (Array.isArray(addresses) ? addresses : []).filter((a) => pick(a, F.line1) || pick(a, F.city));
  const rank = (a) => {
    const physical = a.AddressType === ADDR.physical || a.AddressType === ADDR.physicalAndMailing;
    const mailing = a.AddressType === ADDR.mailing;
    const po = /p\.?\s*o\.?\s*box/i.test(pick(a, F.line1));
    return (physical ? 0 : mailing ? 4 : 2) + (a.IsPrimary ? 0 : 1) + (po ? 10 : 0);
  };
  return list.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i)[0]?.a || null;
}

/** Primary (else first) ContactInfos value of a given type; phones prefer the "Main" line. */
export function contactInfo(infos, type) {
  const list = (infos || []).filter((i) => i.Type === type && !i.IsBad && String(i.Value ?? '').trim());
  const score = (i) => (i.IsPrimary ? 0 : 2) + (type === INFO.phone && !/main/i.test(i.TypeName || '') ? 1 : 0);
  return list.sort((a, b) => score(a) - score(b))[0]?.Value || '';
}

/**
 * /memberships/all ignores Page/PageSize and status filters in the body; it pages with OData
 * $skip/$top on the query string and returns every status, so status is filtered here.
 */
export async function allMemberships(gz, pageSize = 100) {
  const out = [];
  for (let skip = 0; skip < 100_000; skip += pageSize) {
    const data = await gz.post('/memberships/all', {}, { $skip: skip, $top: pageSize });
    const rows = data?.Results || [];
    out.push(...rows);
    const total = data?.TotalRecordAvailable;
    if (rows.length < pageSize || (Number.isFinite(total) && out.length >= total)) break;
  }
  return out;
}

export async function syncMembers(gz, cfg) {
  const pageSize = cfg.growthzone.pageSize;

  const types = await gz.all((page) => gz.get('/memberships/types', { page, pageSize }), pageSize);
  const typeById = new Map(types.map((t) => [String(t.MembershipTypeId), t]));

  // Active organizations only: one row per membership; keep the first per organization.
  const statuses = new Set(cfg.growthzone.includeStatusIds.map(Number));
  const byContact = new Map();
  const skipped = { status: 0, individual: 0 };
  for (const r of await allMemberships(gz, pageSize)) {
    if (!statuses.has(Number(r.MembershipStatusTypeId))) { skipped.status++; continue; }
    const t = typeById.get(String(pick(r, F.typeId)));
    if (t && t.OwnerContactTypeId !== undefined && t.OwnerContactTypeId !== ORGANIZATION) { skipped.individual++; continue; }
    const id = String(pick(r, F.contactId));
    if (id && !byContact.has(id)) byContact.set(id, r);
  }

  const members = [];
  for (const [contactId, ms] of byContact) {
    const [org, addresses] = await Promise.all([
      gz.get(`/contacts/OrgGeneral/${contactId}`),
      gz.get(`/contacts/ContactAddresses/${contactId}`),
    ]);
    if (org?.SystemContactTypeId !== undefined && org.SystemContactTypeId !== ORGANIZATION) { skipped.individual++; continue; }

    const infos = org?.ContactInfos || [];
    const addr = chooseAddress(typedAddresses(addresses, infos));
    const tname = pick(ms, F.typeName) || typeById.get(String(pick(ms, F.typeId)))?.Name || '';
    const rep = (org?.Contacts || []).find((c) => c.IsPrimary) || null;

    members.push(makeMember({
      id: `gz-${contactId}`,
      company: pick(org, F.orgName) || pick(ms, ['Name']),
      ...parseMembershipType(tname),
      addr1: pick(addr, F.line1),
      addr2: pick(addr, F.line2),
      city: pick(addr, F.city),
      state: pick(addr, F.state),
      zip: pick(addr, F.zip),
      phone: contactInfo(infos, INFO.phone),
      email: contactInfo(infos, INFO.email),
      website: contactInfo(infos, INFO.web),
      contactName: rep?.Name || '',
      contactTitle: rep?.Title || '',
      memberSince: String(pick(ms, F.joinDate)).slice(0, 10),
      source: 'growthzone',
    }));
  }
  return { members, calls: gz.calls, skipped };
}

/** Record response shapes (keys and value types only, never values) for the field-mapping check. */
export async function discover(gz) {
  const shape = (v) => (Array.isArray(v) ? [v.length ? shape(v[0]) : 'empty-array']
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v);
  const out = {};
  const safe = async (name, fn) => { try { out[name] = shape(await fn()); } catch (e) { out[name] = `ERROR: ${e.message}`; } };

  await safe('memberships/types', () => gz.get('/memberships/types', { page: 1, pageSize: 5 }));
  await safe('memberships/all', () => gz.post('/memberships/all', {}, { $top: 5 }));
  await safe('contacts', () => gz.get('/contacts', { page: 1, pageSize: 5 }));
  const first = await gz.post('/memberships/all', {}, { $top: 50 }).catch(() => null);
  const id = pick((first?.Results || []).find((r) => r.MembershipStatusTypeId === 2), F.contactId);
  if (id) {
    await safe('contacts/OrgGeneral/{id}', () => gz.get(`/contacts/OrgGeneral/${id}`));
    await safe('contacts/ContactAddresses/{id}', () => gz.get(`/contacts/ContactAddresses/${id}`));
    await safe('contacts/lookup/{id}/contactwebsites', () => gz.get(`/contacts/lookup/${id}/contactwebsites`));
    await safe('contacts/{id}/NotesAndFields', () => gz.get(`/contacts/${id}/NotesAndFields`));
    await safe('contacts/org/{id}/groups', () => gz.get(`/contacts/org/${id}/groups`));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const gz = clientFromEnv(cfg.growthzone);
  if (process.argv.includes('--discover')) {
    const shapes = await discover(gz);
    fs.mkdirSync(p('reports'), { recursive: true });
    writeJson(p('reports/gz-discovery.json'), shapes);
    console.log(`discover: ${gz.calls} calls -> reports/gz-discovery.json`);
  } else {
    const { members, calls, skipped } = await syncMembers(gz, cfg);
    writeJson(p('data/members.json'), { generatedAt: new Date().toISOString(), source: 'growthzone', members });
    console.log(`sync: ${members.length} member organizations from GrowthZone (${calls} API calls; skipped ${skipped.status} other-status memberships, ${skipped.individual} individuals)`);
  }
}
