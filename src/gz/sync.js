// Pull member organizations from GrowthZone -> data/members.json (same shape as src/seed.js).
//
//   npm run sync               full pull of members in the configured statuses
//   npm run sync -- --discover  record the field names each endpoint returns (no values) to
//                               reports/gz-discovery.json; run this first to confirm the field map
//
// Field names below follow GrowthZone's public docs. Each lookup tries several names so a
// naming difference in GBCA's database degrades to a blank field, not a failed run. Confirm
// with --discover and tighten the candidate lists.
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

const F = {
  contactId: ['ContactId', 'Id', 'OrganizationId'],
  orgName: ['Name', 'OrganizationName', 'ContactName', 'DisplayName'],
  contactType: ['ContactType', 'ContactTypeName', 'Type'],
  status: ['MembershipStatusTypeId', 'StatusTypeId'],
  typeId: ['MembershipTypeId', 'TypeId'],
  typeName: ['MembershipTypeName', 'MembershipType', 'TypeName', 'Name'],
  joinDate: ['JoinDate', 'MemberSince', 'StartDate', 'MembershipStartDate'],
  phone: ['Phone', 'PrimaryPhone', 'MainPhone', 'DefaultPhone'],
  email: ['Email', 'PrimaryEmail', 'DefaultEmail'],
  website: ['Website', 'WebsiteUrl', 'Url', 'Address'],
  primaryContactId: ['PrimaryContactId', 'PrimaryContactContactId'],
  primaryContactName: ['PrimaryContactName', 'PrimaryContact'],
  addrType: ['AddressType', 'Type', 'AddressTypeName', 'Label'],
  line1: ['Line1', 'Address1', 'Street', 'StreetAddress', 'AddressLine1'],
  line2: ['Line2', 'Address2', 'AddressLine2'],
  city: ['City'],
  state: ['StateProvince', 'State', 'StateProvinceAbbreviation', 'Region'],
  zip: ['PostalCode', 'Zip', 'ZipCode'],
};

/** Prefer a physical address; fall back to mailing; skip PO boxes when a street exists. */
export function chooseAddress(addresses) {
  const list = (Array.isArray(addresses) ? addresses : addresses?.Results || []).filter((a) => pick(a, F.line1) || pick(a, F.city));
  const rank = (a) => {
    const t = String(pick(a, F.addrType)).toLowerCase();
    const po = /p\.?\s*o\.?\s*box/i.test(pick(a, F.line1));
    return (t.includes('physical') || t.includes('street') ? 0 : t.includes('mail') ? 2 : 1) + (po ? 5 : 0);
  };
  return list.sort((a, b) => rank(a) - rank(b))[0] || null;
}

export async function syncMembers(gz, cfg) {
  const pageSize = cfg.growthzone.pageSize;

  const types = await gz.all((page) => gz.get('/memberships/types', { page, pageSize }), pageSize);
  const typeName = new Map(types.map((t) => [String(pick(t, ['MembershipTypeId', 'Id'])), pick(t, ['Name', 'MembershipTypeName'])]));

  // One row per membership; keep the first per organization.
  const byContact = new Map();
  for (const statusId of cfg.growthzone.includeStatusIds) {
    const rows = await gz.all(
      (Page, PageSize) => gz.post('/memberships/all', { MembershipStatusTypeId: statusId, Page, PageSize }),
      pageSize,
    );
    for (const r of rows) {
      const id = String(pick(r, F.contactId));
      if (id && !byContact.has(id)) byContact.set(id, r);
    }
  }

  const members = [];
  for (const [contactId, ms] of byContact) {
    const [org, addresses, websites] = await Promise.all([
      gz.get(`/contacts/OrgGeneral/${contactId}`),
      gz.get(`/contacts/ContactAddresses/${contactId}`),
      gz.get(`/contacts/lookup/${contactId}/contactwebsites`),
    ]);
    if (org && /individual|person/i.test(String(pick(org, F.contactType)))) continue;

    const addr = chooseAddress(addresses);
    const tname = pick(ms, F.typeName) || typeName.get(String(pick(ms, F.typeId))) || '';
    const site = Array.isArray(websites) ? websites.map((w) => (typeof w === 'string' ? w : pick(w, F.website))).find(Boolean) : '';

    members.push(makeMember({
      id: `gz-${contactId}`,
      company: pick(org, F.orgName) || pick(ms, F.orgName),
      ...parseMembershipType(tname),
      addr1: pick(addr, F.line1),
      addr2: pick(addr, F.line2),
      city: pick(addr, F.city),
      state: pick(addr, F.state),
      zip: pick(addr, F.zip),
      phone: pick(org, F.phone),
      email: pick(org, F.email),
      website: site || pick(org, F.website),
      contactName: pick(org, F.primaryContactName),
      memberSince: String(pick(ms, F.joinDate)).slice(0, 10),
      source: 'growthzone',
    }));
  }
  return { members, calls: gz.calls };
}

/** Record response shapes (keys and value types only, never values) for the field-mapping check. */
export async function discover(gz) {
  const shape = (v) => (Array.isArray(v) ? [v.length ? shape(v[0]) : 'empty-array']
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v);
  const out = {};
  const safe = async (name, fn) => { try { out[name] = shape(await fn()); } catch (e) { out[name] = `ERROR: ${e.message}`; } };

  await safe('memberships/types', () => gz.get('/memberships/types', { page: 1, pageSize: 5 }));
  await safe('memberships/all', () => gz.post('/memberships/all', { MembershipStatusTypeId: 2, Page: 1, PageSize: 5 }));
  await safe('contacts', () => gz.get('/contacts', { page: 1, pageSize: 5 }));
  const first = await gz.post('/memberships/all', { MembershipStatusTypeId: 2, Page: 1, PageSize: 1 }).catch(() => null);
  const id = pick((first?.Results || [])[0], F.contactId);
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
    const { members, calls } = await syncMembers(gz, cfg);
    writeJson(p('data/members.json'), { generatedAt: new Date().toISOString(), source: 'growthzone', members });
    console.log(`sync: ${members.length} member organizations from GrowthZone (${calls} API calls)`);
  }
}
