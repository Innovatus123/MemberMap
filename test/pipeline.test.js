import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameKey, pickStreet, parseMembershipType, zip5, regionFor, tierRank } from '../src/lib/normalize.js';
import { parseCsv, toCsv } from '../src/lib/io.js';
import { seed } from '../src/seed.js';
import { approximate, countyAt, censusBatch } from '../src/geocode.js';
import { GrowthZoneClient } from '../src/gz/client.js';
import { syncMembers, chooseAddress, pick } from '../src/gz/sync.js';
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
  const down = await censusBatch([{ id: 'k1' }], { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(down, null);
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
  const a = chooseAddress([
    { AddressType: 'Mailing', Line1: 'P.O. Box 5', City: 'Ambler' },
    { AddressType: 'Physical', Line1: '10 Main St', City: 'Ambler' },
  ]);
  assert.equal(a.Line1, '10 Main St');
  assert.equal(pick({ postalcode: '19103' }, ['PostalCode']), '19103');
});

test('syncMembers maps GrowthZone responses to member records', async () => {
  const gz = new GrowthZoneClient({
    baseUrl: 'https://x.growthzoneapp.com/api', apiKey: 'k', requestsPerSecond: 1000,
    fetchImpl: mockFetch({
      'GET /memberships/types': () => ({ body: { TotalRecordAvailable: 1, Results: [{ MembershipTypeId: 7, Name: 'GBCA Active Member - Over $100 Million' }] } }),
      'POST /memberships/all': () => ({ body: { TotalRecordAvailable: 1, Results: [{ ContactId: 42, MembershipTypeId: 7, JoinDate: '1938-01-02T00:00:00' }] } }),
      'GET /contacts/OrgGeneral/42': () => ({ body: { Name: 'Test Builders, Inc.', Phone: '215-555-0100', ContactType: 'Organization', PrimaryContactName: 'Pat Doe' } }),
      'GET /contacts/ContactAddresses/42': () => ({ body: [{ AddressType: 'Physical', Line1: '36 S 18th St', City: 'Philadelphia', StateProvince: 'PA', PostalCode: '19103' }] }),
      'GET /contacts/lookup/42/contactwebsites': () => ({ body: ['www.example.com'] }),
    }),
  });
  const cfg = { growthzone: { includeStatusIds: [2], pageSize: 100 } };
  const { members } = await syncMembers(gz, cfg);
  assert.equal(members.length, 1);
  const m = members[0];
  assert.equal(m.company, 'Test Builders, Inc.');
  assert.equal(m.category, 'Active');
  assert.equal(m.tier, 'Over $100 Million');
  assert.equal(m.street, '36 S 18th St');
  assert.equal(m.website, 'https://www.example.com');
  assert.equal(m.memberSince, '1938-01-02');
  assert.equal(m.contactName, 'Pat Doe');
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
