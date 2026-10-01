# Weekly refresh runbook

A cloud Routine runs this every Saturday night (America/New_York) in a fresh Claude Code session in
the "GBCA Applications" environment. It always builds from the live GrowthZone API. Do not use
`npm run draft` or the SharePoint seed exports.

## Destinations

| | Box: `20_GBCA/80_Automations/05_Member_Map` | OneDrive: `0 - GBCA SharePoint/Dashboards/Components/01_Member_Map` |
|---|---|---|
| Folder id | `422232673476` | drive `b!o1yXh0en1U-d6ZF749F0wwUWKHW40rhDjLbdywQLJDNIQuGMQ1oFS6HClQF7D4IX`, item `01LIGXNCHVNYROTXRIJ5FIZHQD6JIU7QWB` |
| Archived folder id | `423257843094` | `01LIGXNCDSG6OKXMILC5B2FZPBU4P37U4J` |
| `GBCA Member Map.html` | file `2495160066391` (new version each week) | Written by the Power Automate flow "GBCA Member Map: Box to OneDrive" (Sunday 2:00 AM) |
| `Member Map - Data Cleanup List.csv` | file `2493452932646` | Uploaded by the Routine (company-level data only) |
| `READ ME - GBCA Member Map.txt` | file `2493457458677` | - |

Never paste the map HTML or member data into a tool call's text. A safety check blocks retyping
member contact details. Box uploads go straight from disk (`get_upload_url` plus `curl`). The map
reaches OneDrive through the Power Automate flow, which copies Box to OneDrive in the cloud.

## Steps

1. **Code.** Work in a checkout of `innovatus123/membermap` on branch `ccr-b36ec192-n6mlh5`.
2. **Network.** `curl` must reach `generalbuildingcontractorsassociationagc.growthzoneapp.com`
   and `geocoding.geo.census.gov`. If either is blocked, stop and report it.
3. **Key.** Use `GZ_API_KEY` from the environment if it is set. Otherwise read it from the Outlook
   email "FW: [GrowthZone] Support Ticket 1580422 Confirmation: GZ API Access for General Building
   Contractors Association has been updated" (Apr 10, 2026). Write `.env` with
   `GZ_BASE_URL=https://generalbuildingcontractorsassociationagc.growthzoneapp.com/api` and the key,
   then `chmod 600 .env`. Never print, log or commit the key.
4. **Build.** `npm install && npm test && npm run all`.
5. **Verify.** Trust the proxy CA for Chromium if the container has one:
   `mkdir -p ~/.pki/nssdb && certutil -d sql:$HOME/.pki/nssdb -N --empty-password; certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n agent-proxy -i /root/.ccr/agent-proxy-ca.crt`
   (install `libnss3-tools` if `certutil` is missing). Then `node scripts/verify-map.mjs` must
   print `VERIFY OK`. Never run `playwright install`.
6. **Compare.** Download the current Box map (file `2495160066391`) to a scratch folder with
   `get_download_url` plus `curl`, then `node scripts/diff-maps.mjs <previous.html> dist/gbca-member-map.html`.
7. **Gate.** Stop without archiving or uploading anything if the tests, sync, build or verify fail,
   or if the member total is under 300 or dropped more than 10% from the previous map.
8. **Box.**
   - Archive: copy file `2495160066391` into Archived (`423257843094`) as
     `GBCA Member Map - <YYYY-MM-DD>.html`, using the previous build's date (the file's
     `content_modified_at`). If that name already exists, skip the copy.
   - Upload `dist/gbca-member-map.html` as a new version of `2495160066391`. Keep the name
     `GBCA Member Map.html` and confirm the SHA-1 matches the local file.
   - Upload `reports/data-cleanup.csv` as a new version of `2493452932646`.
   - Rewrite the read-me (download the current one first) with this run's date, counts and
     "changes since last build", then upload it as a new version of `2493457458677`.
9. **OneDrive.**
   - Archive: move any map `.html` in 01_Member_Map (for example `GBCA Member Map.html`, or a
     legacy dated name) into Archived, renamed `GBCA Member Map - <YYYY-MM-DD>.html` using its
     build date. If the name is taken, add a suffix. The Power Automate flow writes the new
     `GBCA Member Map.html` early Sunday.
   - Upload `reports/data-cleanup.csv` with `sharepoint_upload_file` as
     `Member Map - Data Cleanup List.csv`, `conflictBehavior` "replace", `expectedBytes` = its
     byte size.
   - Check: at the start of each run, if last week's archive step ran but 01_Member_Map has no
     `GBCA Member Map.html`, the flow failed. Say so in the report.
10. **Git.** Commit and push only code or docs changes, never data, reports, builds or `.env`.
11. **Report.**
    - Member counts by type and region, and street-level versus approximate placement.
    - Members added or dropped, and type or tier changes, against the previous build.
    - The top cleanup items, and whether any were fixed since last week.
    - Box link: https://app.box.com/file/2495160066391
    - Anything that failed or was skipped.

## Power Automate flow (one-time setup, runs in Microsoft's cloud)

"GBCA Member Map: Box to OneDrive"

1. **Trigger:** Recurrence, weekly, Sunday 2:00 AM, time zone Eastern.
2. **Box, Get file content using id:** File Id `2495160066391`.
3. **OneDrive for Business, Create file:**
   - Folder Path: `/0 - GBCA SharePoint/Dashboards/Components/01_Member_Map`
   - File Name: `GBCA Member Map.html`
   - File Content: the Box output.

The Routine moves last week's map into Archived first, so Create file never collides with it.
