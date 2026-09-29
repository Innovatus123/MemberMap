// Geocode data/members.json -> data/members.geo.json
//
// Precision ladder, best first:
//   1. cache       - an earlier result for the identical address (data/cache/geocode.json)
//   2. street      - U.S. Census Bureau batch geocoder (free, no key, 10k rows per request)
//   3. zip         - ZIP code centroid (offline, bundled data), used when the Census service is unreachable
//   4. city        - city/state centroid when the ZIP is missing or belongs to a different state
// County FIPS always comes from a point-in-polygon test against Census county boundaries,
// so the county shading and regions work at every precision level.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
import { geoContains } from 'd3-geo';
import { readJson, writeJson, toCsv, parseCsv, loadConfig, p } from './lib/io.js';
import { regionFor, STATE_FIPS } from './lib/normalize.js';

const require = createRequire(import.meta.url);
const zipcodes = require('zipcodes');
const zctaCentroids = require('us-zips');
const countiesTopo = require('us-atlas/counties-10m.json');

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/addressbatch';
const CENSUS_BATCH = 9000;
const CENSUS_ATTEMPTS = 3;

export const addressKey = (m) =>
  crypto.createHash('sha1').update([m.street, m.city, m.state, m.zip].join('|').toLowerCase()).digest('hex').slice(0, 16);

const counties = feature(countiesTopo, countiesTopo.objects.counties).features;
export function countyAt(lat, lng) {
  for (const f of counties) {
    if (geoContains(f, [lng, lat])) return { fips: f.id, name: f.properties.name };
  }
  return null;
}

/** Offline fallback: ZIP centroid if the ZIP belongs to the stated state, else city centroid. */
export function approximate(m) {
  const z = m.zip && zipcodes.lookup(m.zip);
  const zipStateOk = z && (!m.state || z.state === m.state);
  if (m.zip && zipStateOk) {
    const c = zctaCentroids[m.zip] || z;
    return { lat: c.latitude, lng: c.longitude, precision: 'zip' };
  }
  if (m.city && m.state) {
    const hits = zipcodes.lookupByName(m.city, m.state);
    if (hits.length) {
      const lat = hits.reduce((s, h) => s + h.latitude, 0) / hits.length;
      const lng = hits.reduce((s, h) => s + h.longitude, 0) / hits.length;
      return { lat, lng, precision: 'city', note: z ? `ZIP ${m.zip} is in ${z.state}, not ${m.state}` : '' };
    }
  }
  return null;
}

/** Street-level batch geocode via the Census Bureau. Returns Map(id -> {lat,lng}) or null if unreachable. */
export async function censusBatch(rows, { fetchImpl = fetch, retryDelayMs = 5000 } = {}) {
  const out = new Map();
  for (let i = 0; i < rows.length; i += CENSUS_BATCH) {
    const chunk = rows.slice(i, i + CENSUS_BATCH);
    const csv = chunk.map((r) => [r.id, r.street, r.city, r.state, r.zip].map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')).join('\n');
    const form = new FormData();
    form.append('addressFile', new Blob([csv], { type: 'text/csv' }), 'addresses.csv');
    form.append('benchmark', 'Public_AR_Current');
    form.append('vintage', 'Current_Current');
    // id, input, Match|No_Match|Tie, Exact|Non_Exact, matched address, "lon,lat", tiger id, side, state, county, tract, block
    // The service sometimes answers 200 with no result rows; treat that like an outage and retry.
    let results;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetchImpl(CENSUS_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        results = parseCsv(await res.text()).filter((cols) => /^(Match|No_Match|Tie)$/.test(cols[2]));
        if (!results.length) throw new Error('response had no result rows');
        break;
      } catch (err) {
        if (attempt < CENSUS_ATTEMPTS) { await new Promise((r) => setTimeout(r, retryDelayMs * attempt)); continue; }
        console.warn(`geocode: Census geocoder unavailable (${err.message}); using ZIP/city centroids`);
        return null;
      }
    }
    for (const cols of results) {
      if (cols[2] !== 'Match' || !cols[5]) continue;
      const [lng, lat] = cols[5].split(',').map(Number);
      if (Number.isFinite(lat) && Number.isFinite(lng)) out.set(cols[0], { lat, lng, precision: 'street', matched: cols[4] });
    }
  }
  return out;
}

export async function geocodeMembers(members, { cache = {}, offline = false, fetchImpl } = {}) {
  const cfg = loadConfig();
  const todo = members.filter((m) => m.street && !m.poBox && !cache[addressKey(m)]?.precision?.startsWith('street'));
  let census = null;
  if (!offline && todo.length) {
    census = await censusBatch(todo.map((m) => ({ ...m, id: addressKey(m) })), { fetchImpl });
  }

  const issues = [];
  const out = members.map((m) => {
    const key = addressKey(m);
    let geo = census?.get(key) || cache[key];
    if (!geo || geo.precision !== 'street') geo = census?.get(key) || approximate(m) || null;
    if (geo) cache[key] = geo;

    let county = null;
    if (geo) county = countyAt(geo.lat, geo.lng);
    const rec = {
      ...m,
      lat: geo ? round(geo.lat) : null,
      lng: geo ? round(geo.lng) : null,
      precision: geo?.precision || 'none',
      countyFips: county?.fips || '',
      county: county?.name || '',
      region: county ? regionFor(county.fips, county.fips.slice(0, 2), cfg.regions)
        : geo ? regionFor('', STATE_FIPS[m.state], cfg.regions) : 'Not mapped',
    };

    if (!m.street && !m.city) issues.push({ company: m.company, issue: 'No address on file', detail: '' });
    else if (m.poBox) issues.push({ company: m.company, issue: 'PO box only - needs a street address', detail: `${m.street}, ${m.city} ${m.state} ${m.zip}` });
    if (!geo && (m.street || m.city)) issues.push({ company: m.company, issue: 'Could not locate address', detail: `${m.street}, ${m.city} ${m.state} ${m.zip}` });
    if (census && geo && geo.precision !== 'street' && m.street && !m.poBox) {
      issues.push({ company: m.company, issue: 'Street address not matched - placed at ZIP/city center', detail: `${m.street}, ${m.city} ${m.state} ${m.zip}` });
    }
    if (geo?.note) issues.push({ company: m.company, issue: 'ZIP/state mismatch - placed at city centroid', detail: `${geo.note}; ${m.street}, ${m.city} ${m.state}` });
    return rec;
  });
  return { members: out, issues, streetLevel: Boolean(census) };
}

const round = (n) => Math.round(n * 1e5) / 1e5;

if (import.meta.url === `file://${process.argv[1]}`) {
  const offline = process.argv.includes('--offline');
  const input = readJson(p('data/members.json'));
  const cache = readJson(p('data/cache/geocode.json'), {});
  const { members, issues } = await geocodeMembers(input.members, { cache, offline });
  writeJson(p('data/cache/geocode.json'), cache);
  writeJson(p('data/members.geo.json'), { ...input, geocodedAt: new Date().toISOString(), members });
  fs.mkdirSync(p('reports'), { recursive: true });
  fs.writeFileSync(p('reports/needs-attention.csv'), toCsv(issues, ['company', 'issue', 'detail']));
  const by = members.reduce((a, m) => ((a[m.precision] = (a[m.precision] || 0) + 1), a), {});
  console.log(`geocode: ${members.length} members`, by, `| ${issues.length} items -> reports/needs-attention.csv`);
}
