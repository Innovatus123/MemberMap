# GBCA Member Map

An interactive map and directory of GBCA members, generated from GrowthZone. It is
modeled on AGC New York State's Chapter Member Map Starter Kit. See
[docs/PLAN.md](docs/PLAN.md) for the plan and design decisions.

Internal use only. Member data, reports and builds are gitignored and never committed.

## Setup

Requires Node 22.9 or later.

```
npm install
cp .env.example .env      # then add the GrowthZone API key; never commit .env
```

## Run it

| Command | What it does |
|---|---|
| `npm run discover` | One-time check: records the field names each GrowthZone endpoint returns (no member data) to `reports/gz-discovery.json` |
| `npm run all` | Live pipeline: GrowthZone sync → geocode → cleanup report → build |
| `npm run draft` | Interim pipeline from the SharePoint exports in `data/seed/` (used for the first draft) |
| `npm run build:sharepoint` | Build variant for upload through the Microsoft 365 connector (map library from CDN, short lines) |
| `npm test` | Unit tests |
| `node scripts/verify-map.mjs` | Headless browser check of the built map (Playwright, no console errors) |
| `node scripts/diff-maps.mjs <old.html> <new.html>` | Members added, dropped or changed between two builds |

Each step can also be run alone: `sync`, `seed`, `geocode` (add `-- --offline` to skip the
Census service), `report`, `build`.

## Weekly refresh

A cloud Routine rebuilds the map from live GrowthZone every Saturday night and delivers it to Box
and OneDrive, archiving the previous map. See [docs/weekly-refresh.md](docs/weekly-refresh.md).

## Outputs

- `dist/gbca-member-map.html`: the self-contained map (open it in Chrome or Edge)
- `reports/data-cleanup.csv`: the worklist for Membership (PO boxes, missing addresses, streets the
  Census geocoder could not match, type gaps)

## How it works

1. **Source.** `src/gz/sync.js` pulls active member organizations, membership types, addresses,
   phones, websites and primary contacts from the GrowthZone API (`Authorization: ApiKey …`,
   paged, throttled, with retry). The confirmed field map is in
   [docs/gz-field-map.md](docs/gz-field-map.md).
2. **Geocode.** `src/geocode.js` uses the U.S. Census batch geocoder for street-level points,
   falls back to ZIP or city centroids if that service is unreachable, and assigns each member
   a county and region by point-in-polygon against Census county boundaries. Results are cached
   by address, so an address is geocoded only once.
3. **Build.** `src/build.js` writes one HTML file containing the data, county boundaries and app.
   The API key is used only at sync time and never reaches the page.
