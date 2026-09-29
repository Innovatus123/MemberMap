import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, pickStreet, parseMembershipType, zip5, regionFor, tierRank } from '../src/lib/normalize.js';
import { parseCsv, toCsv } from '../src/lib/io.js';
import { seed } from '../src/seed.js';
import { approximate, countyAt, censusBatch, geocodeMembers } from '../src/geocode.js';
import { GrowthZoneClient } from '../src/gz/client.js';
import { syncMembers, chooseAddress, pick, typedAddresses, contactInfo } from '../src/gz/sync.js';
import { build, publishable } from '../src/build.js';

const REGIONS = [
  { name: 'Philadelphia', counties: ['42101'] },
  { name: 'Other PA', states: ['42'] },
  { name: 'Outside' },
];

test('nameKey joins legal-suffix and punctuation variants', () => {
  assert.equal(nameKey('C. Erickson & Sons, LLC'), nameKey('C Erickson and Sons, Inc.'));
  assert.equal(nameKey('Superior Scaffold Services, Inc. (a Sunbelt Rentals Company)'), nameKey('Superior Scaffold Services, Inc.'));
  assert.notEqual(nameKey('Torrado Construction Co., Inc.'), nameKey('Torrado Distributors Inc.'));
});

test('pickStreet uses line 2 when line 1 is a PO box', () => {
  assert.deepEqual(pickStreet('P.O. Box 451', '3732 West Chester Pike'), { street: '3732 West Chester Pike', suite: '', poBox: false });
  assert.equal(pickStreet('P.O. Box 462', '').poBox, true);
  assert.equal(pickStreet('1800 Fruitville Pike', 'P.O. Box 8408').street, '1800 Fruitville Pike');
});

test('parseMembershipType splits category and dues tier', () => {
  assert.deepEqual(parseMembershipType('GBCA Associate Member - $5 Million to $10 Million'),
    { category: 'Associate', tier: '$5 Million to $10 Million', membershipType: 'GBCA Associate Member - $5 Million to $10 Million' });
  assert.equal(parseMembershipType('GBCA Affiliate Member').tier, '');
  assert.equal(parseMembershipType(undefined).category, 'Unknown');
  assert.ok(tierRank('$0 - $499,999') < tierRank('$1 Million to $2 Million'));
  assert.ok(tierRank('$60 Million to $70 Million') < tierRank('Over $50 Million'));
});

test('zip5 keeps leading zeros and drops +4', () => {
  assert.equal(zip5('08110'), '08110');
  assert.equal(zip5('19114-4013'), '19114');
  assert.equal(zip5('8110'), '08110');
});

test('regionFor prefers county, then state, then fallback', () => {
  assert.equal(regionFor('42101', '42', REGIONS), 'Philadelphia');
  assert.equal(regionFor('42091', '42', REGIONS), 'Other PA');
  assert.equal(regionFor('', '06', REGIONS), 'Outside');
});

test('CSV round trip handles quotes, commas and newlines', () => {
  const rows = [{ a: 'x, "y"', b: 'line1\nline2' }];
  const parsed = parseCsv(toCsv(rows, ['a', 'b']));
  assert.deepEqual(parsed[1], ['x, "y"', 'line1\nline2']);
});

test('seed joins roster to membership type and reports both-way gaps', () => {
  const { members, issues } = seed({
    addresses: [
      { name: 'ABC Supply Interiors, Inc.', email: 'a@x.com', addr1: '111 Titus Ave', addr2: '', city: 'Warrington', zip: '18976', state: 'PA' },
      { name: 'New Firm LLC', email: '', addr1: '1 Main St', addr2: '', city: 'Media', zip: '19063', state: 'PA' },
    ],
    memberships: [
      { name: 'L&W Supply', type: 'GBCA Affiliate Member', first: 'Pat', last: 'Example' },
      { name: 'Gone Co.', type: 'GBCA Associate Member - $0 - $1 Million', first: 'A', last: 'B' },
    ],
  });
  assert.equal(members.length, 2);
  assert.equal(members[0].category, 'Affiliate');
  assert.equal(members[0].contactName, 'Pat Example');
  assert.equal(members[1].category, 'Unknown');
  assert.equal(issues.length, 2);
});

test('approximate geocode: ZIP centroid, and city fallback on ZIP/state mismatch', () => {
  const z = approximate({ zip: '19103', state: 'PA', city: 'Philadelphia' });
  assert.equal(z.precision, 'zip');
  assert.ok(Math.abs(z.lat - 39.95) < 0.05);
  const c = approximate({ zip: '19382', state: 'NJ', city: 'Paulsboro' });
  assert.equal(c.precision, 'city');
  assert.match(c.note, /19382 is in PA/);
  assert.equal(approximate({ zip: '', state: '', city: '' }), null);
});

test('countyAt resolves county FIPS by point in polygon', () => {
  assert.equal(countyAt(39.9526, -75.1652).fips, '42101'); // City Hall
  assert.equal(countyAt(39.9259, -75.1196).fips, '34007'); // Camden
  assert.equal(countyAt(0, 0), null);
});

test('censusBatch parses matches and returns null when the service is unreachable', async () => {
  const body = '"k1","100 Main St, X, PA, 19103",Match,Exact,"100 MAIN ST, PHILADELPHIA, PA, 19103","-75.17,39.95",1,L,42,101,000100,1000\n' +
    '"k2","bad",No_Match\n';
  const ok = await censusBatch([{ id: 'k1' }, { id: 'k2' }], { fetchImpl: async () => ({ ok: true, text: async () => body }) });
  assert.deepEqual(ok.get('k1'), { lat: 39.95, lng: -75.17, precision: 'street', matched: '100 MAIN ST, PHILADELPHIA, PA, 19103' });
  assert.equal(ok.has('k2'), false);
  const down = await censusBatch([{ id: 'k1' }], { fetchImpl: async () => { throw new Error('offline'); }, retryDelayMs: 0 });
  assert.equal(down, null);
});

test('censusBatch retries a 200 response that has no result rows', async () => {
  const good = '"k1","x",Match,Exact,"100 MAIN ST","-75.17,39.95",1,L,42,101,000100,1000\n';
  let calls = 0;
  const flaky = async () => ({ ok: true, text: async () => (++calls === 1 ? '' : good) });
  const r = await censusBatch([{ id: 'k1' }], { fetchImpl: flaky, retryDelayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(r.get('k1').precision, 'street');
  const empty = await censusBatch([{ id: 'k1' }], { fetchImpl: async () => ({ ok: true, text: async () => '<html>busy</html>' }), retryDelayMs: 0 });
  assert.equal(empty, null);
});

test('geocodeMembers uses street-level Census results for members that carry their own id', async () => {
  const m = { id: 'gz-42', company: 'Test Builders', street: '36 S 18th St', city: 'Philadelphia', state: 'PA', zip: '19103' };
  const fetchImpl = async (_url, init) => {
    const csv = await init.body.get('addressFile').text();
    const id = csv.split(',')[0].replace(/"/g, '');
    return { ok: true, text: async () => `"${id}","x",Match,Exact,"36 S 18TH ST","-75.1707,39.9522",1,L,42,101,000100,1000\n` };
  };
  const { members } = await geocodeMembers([m], { cache: {}, fetchImpl });
  assert.equal(members[0].precision, 'street');
  assert.equal(members[0].id, 'gz-42');
  assert.equal(members[0].region, 'Philadelphia');

  // A street the Census cannot match falls back to the ZIP center and goes on the worklist.
  const miss = async () => ({ ok: true, text: async () => '"x","y",No_Match\n' });
  const r = await geocodeMembers([m], { cache: {}, fetchImpl: miss });
  assert.equal(r.members[0].precision, 'zip');
  assert.match(r.issues[0].issue, /Street address not matched/);
});

// ---- GrowthZone client/sync against a mock server ----
function mockFetch(routes, log = []) {
  return async (url, init) => {
    const u = new URL(url);
    log.push({ method: init.method, path: u.pathname, auth: init.headers.Authorization, body: init.body });
    const key = `${init.method} ${u.pathname.replace(/^\/api/, '')}`;
    const handler = routes[key];
    const res = handler ? handler(u, init.body && JSON.parse(init.body)) : { status: 404, body: null };
    return {
      ok: res.status === undefined || res.status < 400,
      status: res.status ?? 200,
      headers: { get: () => null },
      text: async () => (res.body === null ? '' : JSON.stringify(res.body ?? res)),
    };
  };
}

test('GrowthZone client sends ApiKey header, pages, and retries on 429', async () => {
  const log = [];
  let hits = 0;
  const gz = new GrowthZoneClient({
    baseUrl: 'https://x.growthzoneapp.com/api', apiKey: 'k', requestsPerSecond: 1000,
    fetchImpl: mockFetch({
      'GET /memberships/types': (u) => {
        hits++;
        if (hits === 1) return { status: 429, body: {} };
        const page = Number(u.searchParams.get('page'));
        return { body: { TotalRecordAvailable: 3, Results: page === 1 ? [{ Id: 1 }, { Id: 2 }] : [{ Id: 3 }] } };
      },
    }, log),
  });
  const rows = await gz.all((page, pageSize) => gz.get('/memberships/types', { page, pageSize }), 2);
  assert.equal(rows.length, 3);
  assert.equal(log[0].auth, 'ApiKey k');
  assert.equal(log.length, 3); // one 429 retry + two pages
});

test('GrowthZone client refuses to run without a key', () => {
  assert.throws(() => new GrowthZoneClient({ baseUrl: 'https://x', apiKey: '' }), /GZ_API_KEY/);
});

test('chooseAddress prefers physical over mailing and skips PO boxes', () => {
  const infos = [
    { Type: 3, EntryId: 1, AddressType: 2, TypeName: 'Mailing', IsPrimary: true },
    { Type: 3, EntryId: 2, AddressType: 3, TypeName: 'Physical', IsPrimary: false },
    { Type: 3, EntryId: 3, AddressType: 1, TypeName: 'Physical and Mailing', IsPrimary: false },
  ];
  const a = chooseAddress(typedAddresses([
    { Id: 1, Address1: '10 Mail St', City: 'Ambler' },
    { Id: 2, Address1: 'P.O. Box 5', City: 'Ambler' },
    { Id: 3, Address1: '20 Main St', City: 'Ambler' },
  ], infos));
  assert.equal(a.Address1, '20 Main St');
  // A mailing street address still beats a physical PO box.
  assert.equal(chooseAddress(typedAddresses([{ Id: 1, Address1: '10 Mail St' }, { Id: 2, Address1: 'PO Box 5' }], infos)).Address1, '10 Mail St');
  assert.equal(pick({ postalcode: '19103' }, ['PostalCode']), '19103');
});

test('contactInfo picks the primary value and prefers the main phone line', () => {
  const infos = [
    { Type: 2, TypeName: 'Fax', Value: '215-555-0199', IsPrimary: false },
    { Type: 2, TypeName: 'Main', Value: '215-555-0100', IsPrimary: true },
    { Type: 1, TypeName: 'Work', Value: 'info@example.com', IsPrimary: true },
    { Type: 4, TypeName: 'Homepage', Value: 'www.example.com', IsPrimary: true },
  ];
  assert.equal(contactInfo(infos, 2), '215-555-0100');
  assert.equal(contactInfo(infos, 1), 'info@example.com');
  assert.equal(contactInfo([], 2), '');
});

test('syncMembers maps GrowthZone responses to member records', async () => {
  const log = [];
  const gz = new GrowthZoneClient({
    baseUrl: 'https://x.growthzoneapp.com/api', apiKey: 'k', requestsPerSecond: 1000,
    fetchImpl: mockFetch({
      'GET /memberships/types': () => ({ body: { TotalRecordAvailable: 2, Results: [
        { MembershipTypeId: 7, Type: 'fa fa-building', Name: 'GBCA Active Member', OwnerContactTypeId: 2 },
        { MembershipTypeId: 8, Type: 'fa fa-user', Name: 'General membership', OwnerContactTypeId: 1 },
      ] } }),
      // Pages with $skip/$top and returns every status; the sync filters to Active (2).
      'POST /memberships/all': (u) => {
        const rows = [
          { ContactId: 42, Name: 'Test Builders, Inc.', MembershipTypeId: 7, Type: 'GBCA Active Member - Over $100 Million', MembershipStatusTypeId: 2, StartDate: '1938-01-02T00:00:00' },
          { ContactId: 43, Name: 'Gone Co', MembershipTypeId: 7, Type: 'GBCA Active Member', MembershipStatusTypeId: 5 },
          { ContactId: 44, Name: 'Pat Person', MembershipTypeId: 8, Type: 'General membership', MembershipStatusTypeId: 2 },
        ];
        const skip = Number(u.searchParams.get('$skip')), top = Number(u.searchParams.get('$top'));
        return { body: { TotalRecordAvailable: rows.length, Results: rows.slice(skip, skip + top) } };
      },
      'GET /contacts/OrgGeneral/42': () => ({ body: {
        ContactDisplayName: 'Test Builders, Inc.', SystemContactTypeId: 2,
        ContactInfos: [
          { Type: 2, TypeName: 'Main', Value: '215-555-0100', IsPrimary: true },
          { Type: 4, TypeName: 'Homepage', Value: 'www.example.com', IsPrimary: true },
          { Type: 3, EntryId: 900, AddressType: 1, TypeName: 'Physical and Mailing', IsPrimary: true },
        ],
        Contacts: [{ Name: 'Sam Staff', IsPrimary: false }, { Name: 'Pat Doe', Title: 'President', IsPrimary: true }],
      } }),
      'GET /contacts/ContactAddresses/42': () => ({ body: [{ Id: 900, ContactAddressId: 900, Address1: '36 S 18th St', City: 'Philadelphia', StateProvince: 'PA', PostalCode: '19103' }] }),
    }, log),
  });
  const cfg = { growthzone: { includeStatusIds: [2], pageSize: 2 } };
  const { members, skipped } = await syncMembers(gz, cfg);
  assert.equal(members.length, 1);
  assert.deepEqual(skipped, { status: 1, individual: 1 });
  assert.equal(log.filter((l) => l.path.endsWith('/memberships/all')).length, 2); // two $top=2 pages
  const m = members[0];
  assert.equal(m.company, 'Test Builders, Inc.');
  assert.equal(m.category, 'Active');
  assert.equal(m.tier, 'Over $100 Million');
  assert.equal(m.street, '36 S 18th St');
  assert.equal(m.phone, '215-555-0100');
  assert.equal(m.website, 'https://www.example.com');
  assert.equal(m.memberSince, '1938-01-02');
  assert.equal(m.contactName, 'Pat Doe');
  assert.equal(m.contactTitle, 'President');
});

test('build escapes member text so it cannot break out of the data script', async () => {
  const cfg = {
    mapTitle: 'T', shortName: 'S', subtitle: '', chapterName: 'C', classification: 'X', footprintStates: ['10'],
    mapCenter: [0, 0], mapZoom: 5, categories: [{ key: 'Active', label: 'A', color: '#f00' }], regions: [{ name: 'R' }],
    brand: { red: '#f00', nearBlack: '#000', darkGray: '#333', offWhite: '#eee', headingFont: 'serif', bodyFont: 'sans-serif' },
    publish: { showDuesTier: false, showPrimaryContact: true, showEmail: false },
  };
  const evil = { id: 'x', company: '</script><script>alert(1)</script>', category: 'Active', tier: 'Over $100 Million', email: 'a@b.c', lat: 1, lng: 1 };
  const html = await build({ cfg, geo: { generatedAt: '2026-09-28', members: [evil, { id: 'y', company: 'No Geo', category: 'Active', lat: null, lng: null }] } });
  const data = JSON.parse(html.match(/id="app-data">([\s\S]*?)<\/script>/)[1]);
  const lat = data.members.cols.indexOf('lat');
  assert.equal(data.members.rows[1][lat], 0);
  assert.equal(data.members.empty.lat, null);
  const cdnHtml = await build({ cfg, geo: { generatedAt: '2026-09-28', members: [evil] }, cdn: true });
  assert.match(cdnHtml, /cdn\.jsdelivr\.net\/npm\/leaflet@1\.9\.4\/dist\/leaflet\.js" integrity="sha384-/);
  assert.equal(html.includes('</script><script>alert(1)'), false);
  assert.equal(publishable(evil, cfg.publish).email, '');
  assert.equal(publishable(evil, cfg.publish).tier, '');
});
