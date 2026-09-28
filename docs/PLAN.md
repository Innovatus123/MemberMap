# GBCA Member Map: Implementation Plan

**Status:** Draft v1 (2026-09-28)
**Owner:** J. Ellington, COO
**Reference build:** AGC New York State "Chapter Member Map Starter Kit" (Box: `20_GBCA/80_Automations/Member Map/Sample`)

---

## 1. Bottom line

Build the GBCA map on AGC NYS's design, with one structural change: **GrowthZone replaces the spreadsheet.** AGC NYS's kit relies on a person exporting a CSV, cleaning it, uploading it to the Census geocoder and re-running the build every time membership changes. GBCA has an API key for GrowthZone, so the whole chain can run on its own:

```
GrowthZone API ──► sync ──► normalize ──► geocode (Census, cached) ──► build ──► publish behind member login
     (nightly or weekly, unattended; staff handle only the exceptions report)
```

Result: a map and directory that stay current without staff touching it, and fix their own data gaps as they go (PO boxes, missing addresses, missing categories). It also lets GBCA add a staff-only prospect layer that AGC NYS can't build from a static spreadsheet (see Section 8).

**Recommendation:** Build it as a standalone pipeline in this repo. Don't make it part of the NK Interactive website project. NK's only task should be putting the finished file behind the member login on the WordPress site. That keeps the map off NK's critical path, and NK's timeline has already slipped.

---

## 2. What we are replicating (AGC NYS kit, as reviewed)

| Capability | AGC NYS implementation | GBCA version |
|---|---|---|
| Data source | Manual CSV export from their AMS | **GrowthZone API** (automated) |
| Geocoding | Census batch geocoder, manual upload | Census batch geocoder, **scripted POST + address-hash cache** |
| Output | One self-contained `member-map.html` (Leaflet, clusters, county choropleth) | Same |
| Search / detail panel / click-to-call / email / directions | Yes | Same |
| Multi-location firms (count once, pin at each site) | `office_label` rows | Driven by GrowthZone's multiple addresses per org |
| Filters | Region, category, type of work, certifications | Membership type, trade/category, certifications, region, county |
| List view (sortable), print, "Add as app" (PWA) | Yes | Same |
| County density shading | Single state (`stateFips`) | **Multi-state.** GBCA's footprint crosses state lines (confirm the list: PA / NJ / DE?) |
| Hosting | Upload to website | WordPress (WP Engine) behind member login, with the file itself protected |
| Refresh | Staff re-run `npm run build` | Scheduled job (GitHub Actions or equivalent) |

**Gap in what was shared:** the Box folder holds the **built output** (`member-map.html`, `styles.css`) and the docs. It does **not** include the kit's source: `config.json`, `package.json` and the `scripts/` folder (prepare-geocode, apply-geocode, build). **Action:** ask AGC NYS for the full kit. If they don't send it, we can rebuild the template from the built HTML, which embeds all of the front-end JS. Having their source saves about 3-5 days.

---

## 3. GrowthZone API: what we know

**Source:** the GrowthZone Platform Integrations ticket #1580422 (Apr 10, 2026), forwarded by M. Conrad, plus GrowthZone's public integration docs.

| Item | Value |
|---|---|
| Base URL | `https://generalbuildingcontractorsassociationagc.growthzoneapp.com/api` |
| Auth | Header `Authorization: ApiKey <key>` (server-to-server) |
| Key | Issued in the ticket above. **Never commit it.** Store it as the `GZ_API_KEY` secret (see `.env.example`). |
| Paging | `page`, `pageSize`; responses return `TotalRecordAvailable` + `Results[]` |
| Incremental sync | `GET /contacts/delta?since=<ISO datetime>` |
| Rate limits | Not published. Throttle to about 5 req/s and back off on HTTP 429. |

### Endpoints we expect to use

The public docs list these endpoints. Their exact response shapes need to be confirmed in Phase 1.

| Purpose | Endpoint |
|---|---|
| All contacts (orgs and people), paged | `GET /contacts` |
| Changed since last run | `GET /contacts/delta?since=` |
| Org profile (name, phone, fax, description, status) | `GET /contacts/OrgGeneral/{contactId}` |
| Addresses (physical, mailing, additional) | `GET /contacts/ContactAddresses/{contactId}` |
| Websites | `GET /contacts/lookup/{contactId}/contactwebsites` |
| Primary contact emails | `GET /contacts/PrimaryContact/Emails/{primaryContactId}` |
| Custom fields (certifications, trade, union status, etc.) | `GET /contacts/{contactId}/NotesAndFields` |
| Groups / directory categories | `GET /contacts/org/{contactId}/groups`, `POST /GroupsApi_GetGroupsByCategories` |
| Membership types | `GET /memberships/types` |
| Memberships by type and status | `POST /memberships/all` |

**Membership status codes** (`MembershipStatusTypeId`): 1 Prospective, 2 Active, 4 Courtesy, 8 Non-member, 16 Inactive, 32 Deleted. The public map shows **2 (and 4 if GBCA wants courtesy members listed)**.

**Call volume:** about 300 member orgs × about 5 detail calls = about 1,500 calls for a first full sync. After that, the delta endpoint handles changes. Small load.

**Security note:** the key was sent in plain text by email and has been forwarded internally. GrowthZone keys **don't expire and can't be revoked**. The only fix is to delete the API configuration and have a new key issued. Decide now whether to reissue before production. My recommendation is to reissue at go-live, store the key only in the CI secret store, and keep it out of email.

---

## 4. Data mapping (GrowthZone → map record)

The target schema is the AGC NYS `members-template.csv`, which keeps us compatible with their front end.

| Map field | GrowthZone source | Notes / decisions needed |
|---|---|---|
| `company` | Org `Name` | Organizations only. Exclude individual contacts. |
| `category` | Membership type name | e.g., GC, Specialty Contractor, Associate. Colors are assigned per type. |
| `region` | Derived from **county FIPS** returned by the geocoder | Or a GZ custom field, if GBCA already tags regions. |
| `office_label` | Address `Type` / label | "Headquarters", "Yard", "Branch". |
| `street`/`city`/`state`/`zip` | `ContactAddresses` | **Rule:** prefer Physical, fall back to Mailing, and flag PO boxes. |
| `phone`, `fax` | `OrgGeneral` | |
| `website` | `contactwebsites` | Normalize to https. |
| `emails` | Primary contact emails | **Privacy decision:** publish the general org email only, or the primary rep too? |
| `contacts` | Primary contact / org reps | Name and title only, unless members opt in. |
| `type_of_work` | GZ directory categories or groups | Confirm GBCA's taxonomy in GZ (trade / CSI division?). |
| `certifications` | Custom fields (MBE/WBE/DBE/DVBE, etc.) | Confirm the field names in Phase 1. |
| `description` | Org description / directory listing text | |
| `member_since` *(new)* | Membership join date | Optional "Member since" badge, which supports the retention message. |
| `latitude`/`longitude`, `county_fips` | Census geocoder (cached) | |

**Directory opt-out:** if GrowthZone has a "show in directory" flag, or members have opted out of the public directory, the sync has to follow it. Confirm this in Phase 1. It's a trust issue, not a technical one.

---

## 5. Architecture

```
repo/
  config/gbca.json          branding, states, filters, status codes to include
  src/gz/client.js          auth header, paging, throttle, retry/backoff
  src/gz/sync.js            full + delta pull → data/raw/*.json (gitignored)
  src/normalize.js          raw → members.json (map schema above), PO-box detection
  src/geocode.js            Census batch API (scripted), cache keyed by address hash
  src/build.js              inject data + config into template → dist/member-map.html
  template/                 front end adapted from AGC NYS (Leaflet + clusters + counties)
  reports/                  needs-attention.csv, change log per run
  .github/workflows/sync.yml  scheduled run; GZ_API_KEY from secrets
```

**Design principles**

1. **The key never reaches the browser.** The API is called only at build time. The published HTML contains only the fields we chose to publish.
2. **Geocoding is cached.** An address is geocoded once and re-geocoded only when it changes. The Census batch endpoint (`geocoding.geo.census.gov/geocoder/geographies/addressbatch`) accepts scripted POSTs and returns county FIPS, which drives both region and choropleth.
3. **Exceptions go to staff.** Each run writes `needs-attention.csv` (PO boxes, no match, missing category) and emails it to Membership (M. Conrad). Staff fix the record **in GrowthZone**, not in a spreadsheet, so the AMS improves over time.
4. **Deterministic builds.** The same GZ data always produces the same HTML, so each run's diff shows exactly what changed.
5. **Runtime:** Node 20, matching the AGC kit, with no server and no database.

---

## 6. Hosting and access control

The AGC NYS kit warns that a file in a WordPress uploads folder is public to anyone who has the link, even when the page linking to it is members-only. Because the map carries member contact data, GBCA needs one of these:

| Option | Protection | Effort | Recommendation |
|---|---|---|---|
| A. Upload to WP media | None (the link is public) | Trivial | **No** |
| B. WP page, members-only, file served through an auth-checking endpoint or a protected-file plugin | Real | Low. NK can do it in hours. | **Yes, for launch** |
| C. Two builds: a public "find a contractor" map (name, trade, city, website) plus a members-only full directory | Real, plus marketing value | Medium | **Yes, as Phase 5.** A public GC/sub finder is a lead source for members and a selling point for membership. |

The WordPress site is being built by NK Interactive on WP Engine, and NK has asked separately for GrowthZone API access. **Don't hand NK the key for this project.** Give them a finished file and one integration task: put it behind the login.

---

## 7. Phased plan

| Phase | Work | Output | Est. effort |
|---|---|---|---|
| **0. Access and governance** (Week 1) | Decide on key reissue. Store the key as a secret. Request the full kit source from AGC NYS. Name a data owner (Membership). Confirm states and footprint. | Decisions logged | 2-3 hrs |
| **1. API discovery spike** (Week 1) | Call each endpoint above against GBCA's database. Save sample responses. Confirm field names for addresses, categories, certifications and the directory opt-out flag. | `docs/gz-field-map.md`, sample JSON (redacted) | 1-2 days |
| **2. Data audit** (Week 2) | Full pull of active members. Measure: % with a physical address, # of PO boxes, # of multi-location firms, category and certification coverage. | Data-quality scorecard, PO-box call list | 1 day + staff time |
| **3. Pipeline** (Weeks 2-3) | Client, sync, normalize, geocode cache, exceptions report. | `npm run sync && npm run build` works end to end | 3-4 days |
| **4. Front end** (Weeks 3-4) | Adapt the AGC template: GBCA branding and logo, multi-state counties, GBCA filters, "Member since". Accessibility and mobile QA. | `dist/member-map.html` | 2-3 days |
| **5. Publish and automate** (Week 4) | Scheduled workflow. NK places the file behind member login (Option B). Staff verify every listing against a printed list, as AGC NYS did. | Live members-only map | 1 day + NK task |
| **6. Launch** (Week 5) | "Confirm your listing" email to all members, which turns launch into a data cleanup pass. Board and member-meeting demo. | Announcement, cleaner GZ data | Comms |
| **7. Extensions** (later) | Public contractor finder (Option C). Staff prospect layer (Section 8). | | |

**Total:** about 4-5 weeks part-time, roughly 10-12 build days. Hard cost: about $0 beyond existing GrowthZone API fees and hosting.

---

## 8. Strategic extensions (GBCA-specific)

1. **Prospect and retention map (staff only).** Map GZ status 1 (Prospective) and 16 (Inactive) next to active members. The output is a white-space view: counties and trades with high contractor density and low GBCA penetration. It turns the directory into a membership-development tool, and it's the kind of analysis that works well in a board packet.
2. **Market-share metric.** Compare member counts by county with Census County Business Patterns (NAICS 236/238 establishment counts) to get GBCA penetration by county. That gives the Board a defensible growth KPI.
3. **Event and committee overlays.** The same pipeline can later plot event attendance or committee participation, which shows engagement by geography.
4. **Reusable pattern for other chapters.** AGC NYS shared its CSV kit. A **GrowthZone-connected** version is a step up that GBCA can offer back to AGC of America and to other chapters on GrowthZone. That builds GBCA's standing in the network, and it's a documented AI-assisted automation case study.

---

## 9. Open decisions (need COO input)

1. **Footprint:** which states and counties go on the base map?
2. **Who appears:** Active only, or Active + Courtesy? Associates and suppliers included?
3. **Contact exposure:** which emails and names are published to members? Is there a public tier at all?
4. **Key hygiene:** reissue the GrowthZone key before go-live? (Recommended: yes.)
5. **Refresh cadence:** nightly or weekly? (Recommended: nightly delta plus a weekly full rebuild.)
6. **Taxonomy:** what counts as "type of work" in GZ (groups, categories, custom field)?

---

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| GZ field layout differs from the public docs (some endpoints are only partly documented) | Medium | The Phase 1 spike happens before any build work |
| Poor address quality or PO boxes | High (AGC NYS saw about 2 dozen out of 643) | Exceptions report, fixes made in GZ, launch "confirm your listing" |
| Member data exposed publicly | Medium without controls | Option B hosting; field-level publish allowlist in config |
| API key leak (keys can't be revoked) | Medium | Secret store only; reissue at go-live; never sent to the browser |
| Dependence on NK timeline | Medium | NK has one small task; the map ships independently |
| Undocumented rate limits | Low | Throttle, backoff, delta sync |

---

### Sources
- GrowthZone ticket #1580422 (Platform Integrations, 2026-04-10): endpoint and key
- [GrowthZone API](https://integration.growthzone.com/growthzone-api/) · [Curated API reference](https://documentation.growthzoneapp.com/CuratedApi.html) · [API Key Authentication](https://helpdesk.growthzone.com/hc/en-us/articles/45934833176603-GrowthZone-API-Key-Authentication) · [Common GrowthZone API Calls](https://integration.growthzone.com/common-growthzone-api-calls/)
- Third-party OpenAPI profile: [api-evangelist/growthzone](https://github.com/api-evangelist/growthzone) (used to cross-check endpoint names; not authoritative)
- AGC NYS Member Map Starter Kit (README, PDF overview, template CSV, built sample)
