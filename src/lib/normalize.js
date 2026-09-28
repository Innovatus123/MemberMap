// Shared normalization rules. Every data source (seed files, GrowthZone API)
// is reduced to the same member record shape before geocoding and build.

const SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'lp', 'llp', 'pc', 'plc', 'ltd', 'co', 'company',
  'corp', 'corporation', 'the', 'and', 'of',
]);

/** Name key used to join records across sources ("C. Erickson & Sons, LLC" == "C Erickson and Sons Inc"). */
export function nameKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !SUFFIXES.has(w))
    .join(' ');
}

const PO_BOX = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|pmb)\b/i;
export const isPoBox = (s) => PO_BOX.test(String(s || ''));

/**
 * Choose the street line to geocode. A PO box cannot be mapped, so if line 1 is a
 * PO box and line 2 looks like a street, use line 2.
 */
export function pickStreet(line1, line2) {
  const a = clean(line1);
  const b = clean(line2);
  if (a && !isPoBox(a)) return { street: a, suite: b, poBox: false };
  if (b && !isPoBox(b) && /\d/.test(b)) return { street: b, suite: '', poBox: false };
  return { street: a || b, suite: '', poBox: Boolean(a || b) };
}

export const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const zip5 = (z) => {
  const m = clean(z).match(/^(\d{4,5})/);
  return m ? m[1].padStart(5, '0') : '';
};

/** "GBCA Associate Member - $5 Million to $10 Million" -> { category: 'Associate', tier: '$5 Million to $10 Million' } */
export function parseMembershipType(raw) {
  const s = clean(raw);
  const m = s.match(/\b(Active|Associate|Affiliate)\b/i);
  const category = m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : 'Unknown';
  const dash = s.indexOf(' - ');
  const tier = dash >= 0 ? s.slice(dash + 3).trim() : '';
  return { category, tier, membershipType: s };
}

/** Sort key for revenue-band tiers so filters list smallest to largest. */
export function tierRank(tier) {
  if (!tier) return 1e12;
  if (/^over/i.test(tier)) return 1e11 + (parseMoney(tier) || 0);
  return parseMoney(tier) ?? 1e12;
}
function parseMoney(t) {
  const m = t.match(/\$([\d,.]+)\s*(million)?/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return m[2] ? n * 1e6 : n;
}

export function normalizeWebsite(url) {
  const u = clean(url);
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** Map a 5-digit county FIPS (or state FIPS) to a configured region name. */
export function regionFor(countyFips, stateFips, regions) {
  for (const r of regions) {
    if (r.counties && countyFips && r.counties.includes(countyFips)) return r.name;
  }
  for (const r of regions) {
    if (r.states && stateFips && r.states.includes(stateFips)) return r.name;
  }
  const fallback = regions.find((r) => !r.counties && !r.states);
  return fallback ? fallback.name : '';
}

export const STATE_FIPS = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11',
  FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21',
  LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30',
  NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39',
  OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49',
  VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56', PR: '72',
};

/** Canonical member record. Every source produces this shape. */
export function makeMember(fields) {
  const { street, suite, poBox } = pickStreet(fields.addr1, fields.addr2);
  const state = clean(fields.state).toUpperCase();
  return {
    id: fields.id || nameKey(fields.company).replace(/ /g, '-'),
    company: clean(fields.company),
    category: fields.category || 'Unknown',
    tier: fields.tier || '',
    membershipType: fields.membershipType || '',
    street,
    suite,
    city: clean(fields.city),
    state,
    zip: zip5(fields.zip),
    poBox,
    phone: clean(fields.phone),
    website: normalizeWebsite(fields.website),
    email: clean(fields.email),
    contactName: clean(fields.contactName),
    contactTitle: clean(fields.contactTitle),
    memberSince: fields.memberSince || '',
    source: fields.source || '',
  };
}
