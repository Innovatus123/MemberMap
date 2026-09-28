// Build dist/gbca-member-map.html: one self-contained file (map library, county boundaries,
// member data and app code all inline). Only the basemap tiles load from the internet;
// without them the county boundaries and pins still render.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { minify } from 'terser';
import { feature } from 'topojson-client';
import { readJson, loadConfig, p } from './lib/io.js';
import { tierRank } from './lib/normalize.js';

const require = createRequire(import.meta.url);
const read = (f) => fs.readFileSync(f, 'utf8');
const mod = (m) => require.resolve(m);

const FIPS_ST = { '10': 'DE', '24': 'MD', '34': 'NJ', '36': 'NY', '42': 'PA' };

function roundCoords(geom, d = 3) {
  const f = 10 ** d;
  const r = (c) => (typeof c[0] === 'number' ? [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f] : c.map(r));
  return { ...geom, coordinates: r(geom.coordinates) };
}

export function boundaries(footprint) {
  const topo = require('us-atlas/counties-10m.json');
  const counties = feature(topo, topo.objects.counties).features
    .filter((f) => footprint.includes(f.id.slice(0, 2)))
    .map((f) => ({ type: 'Feature', id: f.id, properties: { name: f.properties.name, st: FIPS_ST[f.id.slice(0, 2)] || '' }, geometry: roundCoords(f.geometry) }));
  const states = feature(topo, topo.objects.states).features
    .filter((f) => footprint.includes(f.id))
    .map((f) => ({ type: 'Feature', id: f.id, properties: {}, geometry: roundCoords(f.geometry) }));
  return { counties: { type: 'FeatureCollection', features: counties }, states: { type: 'FeatureCollection', features: states } };
}

/** Keep only the fields the page needs, honouring the publish settings. */
export function publishable(m, publish) {
  return {
    id: m.id, company: m.company, category: m.category,
    tier: publish.showDuesTier ? m.tier : '',
    street: m.street, suite: m.suite, city: m.city, state: m.state, zip: m.zip, poBox: m.poBox,
    phone: m.phone, website: m.website,
    email: publish.showEmail ? m.email : '',
    contactName: publish.showPrimaryContact ? m.contactName : '',
    memberSince: m.memberSince,
    lat: m.lat, lng: m.lng, precision: m.precision, countyFips: m.countyFips, county: m.county, region: m.region,
  };
}

// Pinned CDN copies of the map library. jsDelivr serves the exact npm files, so the
// integrity hashes are computed from the installed packages and always match.
const CDN = [
  ['leaflet', '1.9.4', 'dist/leaflet.css'],
  ['leaflet.markercluster', '1.5.3', 'dist/MarkerCluster.css'],
  ['leaflet.markercluster', '1.5.3', 'dist/MarkerCluster.Default.css'],
  ['leaflet', '1.9.4', 'dist/leaflet.js'],
  ['leaflet.markercluster', '1.5.3', 'dist/leaflet.markercluster.js'],
];
function cdnTag([pkg, ver, file]) {
  const installed = require(`${pkg}/package.json`).version;
  if (installed !== ver) throw new Error(`${pkg} ${installed} installed but CDN pin is ${ver}`);
  const sri = 'sha384-' + crypto.createHash('sha384').update(fs.readFileSync(mod(`${pkg}/${file}`))).digest('base64');
  const url = `https://cdn.jsdelivr.net/npm/${pkg}@${ver}/${file}`;
  return file.endsWith('.css')
    ? `<link rel="stylesheet" href="${url}" integrity="${sri}" crossorigin="anonymous">`
    : `<script src="${url}" integrity="${sri}" crossorigin="anonymous"></script>`;
}

/** Break JSON into short lines at commas outside strings (valid JSON; easier to diff and transfer). */
export function wrapJson(json, width = 150) {
  let out = '';
  let col = 0;
  let inStr = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    out += ch;
    col++;
    if (inStr) {
      if (ch === '\\') { out += json[++i]; col++; } else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === ',' && col >= width) { out += '\n'; col = 0; }
  }
  return out;
}

/** Column-wise member table: much smaller than an array of objects. */
function columnar(members) {
  const cols = Object.keys(members[0] || {});
  // blanks are stored as 0; `empty` says what each column's blank really is
  const empty = Object.fromEntries(cols.map((c) => [c, c === 'lat' || c === 'lng' ? null : c === 'poBox' ? false : '']));
  const isBlank = (v) => v === '' || v === null || v === undefined || v === false;
  return { cols, empty, rows: members.map((m) => cols.map((c) => (isBlank(m[c]) ? 0 : m[c]))) };
}

export async function build({ cfg, geo, now = new Date(), cdn = false, wrap = false }) {
  const members = geo.members.map((m) => publishable(m, cfg.publish)).sort((a, b) => a.company.localeCompare(b.company));
  const tiers = [...new Set(members.map((m) => m.tier).filter(Boolean))].sort((a, b) => tierRank(a) - tierRank(b));
  const { counties, states } = boundaries(cfg.footprintStates);

  const data = {
    config: {
      categories: cfg.categories, regions: cfg.regions.map((r) => ({ name: r.name })),
      mapCenter: cfg.mapCenter, mapZoom: cfg.mapZoom, publish: cfg.publish,
    },
    members: columnar(members),
    tiers,
    tierRank: Object.fromEntries(tiers.map((t, i) => [t, i]).concat([['', 999]])),
    counties,
    states,
  };

  const approx = members.filter((m) => m.precision !== 'street' && m.lat != null).length;
  const asOf = new Date(geo.generatedAt || now).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const sourceNote = geo.source === 'growthzone'
    ? `Source: GrowthZone, synced ${asOf}.`
    : `Source: GrowthZone exports saved to SharePoint (2026 Membership Directory mailing list, Sep 3 2026; contacts report, May 25 2026).`;
  const banner = `<b>DRAFT - internal only.</b> ${sourceNote} ` +
    (approx ? `${approx} of ${members.length} pins are placed at the ZIP-code centre until street-level geocoding runs on the live GrowthZone sync. ` : '') +
    `Dues tier reflects member-reported revenue - do not share outside GBCA.`;

  const brand = cfg.brand;
  const styles = read(p('template/styles.css'))
    .replace('__RED__', brand.red).replace('__NEAR_BLACK__', brand.nearBlack).replace('__DARK_GRAY__', brand.darkGray)
    .replace('__OFF_WHITE__', brand.offWhite).replace('__HEAD_FONT__', brand.headingFont).replace('__BODY_FONT__', brand.bodyFont);

  const css = CDN.filter((c) => c[2].endsWith('.css'));
  const js = CDN.filter((c) => c[2].endsWith('.js'));
  const leafletCss = cdn ? css.map(cdnTag).join('\n') : `<style>${css.map((c) => read(mod(`${c[0]}/${c[2]}`))).join('\n')}</style>`;
  const leafletJs = cdn ? js.map(cdnTag).join('\n') : `<script>${js.map((c) => read(mod(`${c[0]}/${c[2]}`))).join('\n;\n')}</script>`;
  const appJs = wrap ? read(p('template/app.js')) : (await minify(read(p('template/app.js')), { compress: true, mangle: true })).code;

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const tokens = {
    __TITLE__: esc(cfg.mapTitle),
    __SHORT_NAME__: esc(cfg.shortName),
    __SUBTITLE__: esc(cfg.subtitle),
    __UPDATED__: esc(`Membership current as of ${asOf}`),
    __BANNER__: banner,
    __CHAPTER__: esc(cfg.chapterName),
    __CLASSIFICATION__: esc(cfg.classification),
    __LEAFLET_CSS__: leafletCss,
    __STYLES__: wrap ? styles : styles.replace(/\s*\n\s*/g, '').replace(/\/\*.*?\*\//g, ''),
    // JSON inside <script>: escape "<" so member text can never close the tag
    __DATA__: (wrap ? wrapJson(JSON.stringify(data)) : JSON.stringify(data)).replace(/</g, '\\u003c'),
    __LEAFLET_JS__: leafletJs,
    __APP_JS__: appJs,
  };
  let html = read(p('template/map.html'));
  for (const [k, v] of Object.entries(tokens)) html = html.split(k).join(v);
  return html;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  const geo = readJson(p('data/members.geo.json'));
  // --sharepoint: map library from the CDN and short lines, for upload through the Microsoft 365 connector
  const sharepoint = process.argv.includes('--sharepoint');
  const cdn = sharepoint || process.argv.includes('--cdn');
  const html = await build({ cfg, geo, cdn, wrap: sharepoint });
  fs.mkdirSync(p('dist'), { recursive: true });
  const out = p(sharepoint ? 'dist/gbca-member-map.sharepoint.html' : cdn ? 'dist/gbca-member-map.cdn.html' : 'dist/gbca-member-map.html');
  fs.writeFileSync(out, html);
  console.log(`build: ${out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${geo.members.length} members)`);
}
