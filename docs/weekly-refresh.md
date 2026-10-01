# Weekly refresh runbook

A cloud Routine runs this every Saturday night (America/New_York) in a fresh Claude Code session in
the "GBCA Applications" environment. It always builds from the live GrowthZone API. Do not use
`npm run draft` or the SharePoint seed exports.

## Destinations

| | Box: `20_GBCA/80_Automations/05_Member_Map` | OneDrive: `0 - GBCA SharePoint/Dashboards/Components/01_Member_Map` |
|---|---|---|
| Folder id | `422232673476` | drive `b!o1yXh0en1U-d6ZF749F0wwUWKHW40rhDjLbdywQLJDNIQuGMQ1oFS6HClQF7D4IX`, item `01LIGXNCHVNYROTXRIJ5FIZHQD6JIU7QWB` |
| Archived folder id | `423257843094` | `01LIGXNCDSG6OKXMILC5B2FZPBU4P37U4J` |
| `GBCA Member Map.html` | file `2495160066391` (new version each week) | `scripts/onedrive-publish.sh` (Microsoft Graph, from disk) |
| `Member Map - Data Cleanup List.csv` | file `2493452932646` | `scripts/onedrive-publish.sh`, or the Microsoft 365 connector (company-level data only) |
| `READ ME - GBCA Member Map.txt` | file `2493457458677` | - |

Never paste the map HTML or member data into a tool call's text. A safety check blocks retyping
member contact details, and the Microsoft 365 connector only accepts inline content. Every map
upload goes straight from disk: Box through `get_upload_url` plus `curl`, OneDrive through
Microsoft Graph with `scripts/onedrive-publish.sh`.

## Steps

1. **Code.** Work in a checkout of `innovatus123/membermap` on branch `ccr-b36ec192-n6mlh5`.
2. **Network.** `curl` must reach `generalbuildingcontractorsassociationagc.growthzoneapp.com`
   and `geocoding.geo.census.gov`. If either is blocked, stop and report it.
3. **Key.** Download Box file `2499294364680` ("Growthzone API.pdf" in
   `20_GBCA/80_Automations/00_Instructions`) to a scratch folder with `get_download_url` plus `curl`,
   then run `scripts/gz-key-from-pdf.sh <pdf>`. It writes `.env` (chmod 600) and deletes the PDF.
   Fall back to the Outlook email "FW: [GrowthZone] Support Ticket 1580422 ..." (Apr 10, 2026) only
   if the PDF is missing. Never print, log or commit the key.
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
9. **OneDrive.** The Microsoft 365 connector only accepts typed content, so OneDrive gets the split
   build: a small page plus 13 data files, each small enough for one upload.
   - Run `node src/build.js --onedrive`, which writes `dist/onedrive/`.
   - Check that no file contains a `\uXXXX` escape (`grep -rc '\\u[0-9A-Fa-f]\{4\}' dist/onedrive`
     must report 0 for every file). The connector rewrites these escapes, so a file containing one
     never matches its byte count.
   - Archive: move the current `GBCA Member Map.html` in 01_Member_Map into Archived
     (`01LIGXNCDSG6OKXMILC5B2FZPBU4P37U4J`), renamed `GBCA Member Map - <YYYY-MM-DD>.html` with its
     build date.
   - Upload each file in `dist/onedrive/GBCA Member Map files/` into the folder
     `GBCA Member Map files` (`01LIGXNCASF2A3NWABFJHYRPXEVFMX5LU3`) with `sharepoint_upload_file`,
     `conflictBehavior` "replace", `expectedBytes` = its byte size. Then upload
     `dist/onedrive/GBCA Member Map.html` into 01_Member_Map the same way.
   - Upload `reports/data-cleanup.csv` as `Member Map - Data Cleanup List.csv` the same way.
   - The page checks every data file when it opens, and shows a red warning if any file is missing
     or altered.
   - `scripts/onedrive-publish.sh` does the same from disk through Microsoft Graph, if
     `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET` are ever set.
10. **Git.** Commit and push only code or docs changes, never data, reports, builds or `.env`.
11. **Report.**
    - Member counts by type and region, and street-level versus approximate placement.
    - Members added or dropped, and type or tier changes, against the previous build.
    - The top cleanup items, and whether any were fixed since last week.
    - Box link: https://app.box.com/file/2495160066391
    - Anything that failed or was skipped.

## OneDrive credential (one-time, Microsoft 365 admin)

1. In Microsoft Entra admin center, go to App registrations, then New registration. Name it
   "GBCA Member Map publisher", single tenant, with no redirect URI.
2. Under API permissions, add Microsoft Graph, Application permissions, `Files.ReadWrite.All`.
   Then select Grant admin consent.
3. Under Certificates & secrets, add a new client secret (24 months). Copy its Value.
4. In the "GBCA Applications" cloud environment settings, add the environment variables
   `MS_TENANT_ID` (Directory (tenant) ID), `MS_CLIENT_ID` (Application (client) ID) and
   `MS_CLIENT_SECRET` (the secret Value).

`Files.ReadWrite.All` as an application permission reaches every user's files in the tenant. For a
tighter grant, IT can use `Sites.Selected` and give the app write access to the user's OneDrive
site only. The script works the same either way.
