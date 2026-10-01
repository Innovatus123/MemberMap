#!/usr/bin/env bash
# Publishes the built map and cleanup list to the OneDrive 01_Member_Map folder straight from disk
# through Microsoft Graph (no retyping through a connector). Moves the current map into Archived
# first, named with its last-modified date.
#
# Needs an Entra app registration with the Microsoft Graph *application* permission
# Files.ReadWrite.All (admin consented), exposed as environment variables:
#   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
# Never echoes the secret or the access token.
#
# Usage: scripts/onedrive-publish.sh [map.html] [cleanup.csv]
set -euo pipefail

MAP=${1:-dist/gbca-member-map.html}
CSV=${2:-reports/data-cleanup.csv}
DRIVE=${ONEDRIVE_DRIVE_ID:-b!o1yXh0en1U-d6ZF749F0wwUWKHW40rhDjLbdywQLJDNIQuGMQ1oFS6HClQF7D4IX}
FOLDER=${ONEDRIVE_FOLDER_ID:-01LIGXNCHVNYROTXRIJ5FIZHQD6JIU7QWB}     # .../Components/01_Member_Map
ARCHIVE=${ONEDRIVE_ARCHIVE_ID:-01LIGXNCDSG6OKXMILC5B2FZPBU4P37U4J}   # .../01_Member_Map/Archived
MAP_NAME="GBCA Member Map.html"
CSV_NAME="Member Map - Data Cleanup List.csv"
G=https://graph.microsoft.com/v1.0

for v in MS_TENANT_ID MS_CLIENT_ID MS_CLIENT_SECRET; do
  [ -n "${!v:-}" ] || { echo "onedrive: $v is not set; skipping OneDrive publish" >&2; exit 2; }
done
[ -s "$MAP" ] && [ -s "$CSV" ] || { echo "onedrive: missing $MAP or $CSV" >&2; exit 1; }

TOKEN=$(curl -sS --fail-with-body -X POST "https://login.microsoftonline.com/$MS_TENANT_ID/oauth2/v2.0/token" \
  --data-urlencode "client_id=$MS_CLIENT_ID" --data-urlencode "client_secret=$MS_CLIENT_SECRET" \
  --data-urlencode "scope=https://graph.microsoft.com/.default" --data-urlencode "grant_type=client_credentials" \
  | jq -r '.access_token // empty') || { echo "onedrive: token request failed" >&2; exit 1; }
[ -n "$TOKEN" ] || { echo "onedrive: no access token returned" >&2; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN")
enc() { jq -rn --arg s "$1" '$s|@uri'; }

# 1. Archive every map .html currently in the folder (current name or a legacy dated name).
curl -sS --fail-with-body "${AUTH[@]}" "$G/drives/$DRIVE/items/$FOLDER/children?\$select=id,name,lastModifiedDateTime,file&\$top=200" \
  | jq -c '.value[] | select(.file != null) | select(.name | test("^GBCA Member Map.*\\.html$"))' \
  | while read -r item; do
      id=$(jq -r .id <<<"$item"); name=$(jq -r .name <<<"$item"); day=$(jq -r '.lastModifiedDateTime[0:10]' <<<"$item")
      dated=$name; [[ $name =~ [0-9]{4}-[0-9]{2}-[0-9]{2} ]] || dated="GBCA Member Map - $day.html"
      body=$(jq -n --arg p "$ARCHIVE" --arg n "$dated" '{parentReference:{id:$p},name:$n}')
      curl -sS --fail-with-body -X PATCH "${AUTH[@]}" -H "Content-Type: application/json" \
        "$G/drives/$DRIVE/items/$id?@microsoft.graph.conflictBehavior=rename" -d "$body" \
        | jq -r '"onedrive: archived \"'"$name"'\" as \"" + .name + "\""'
    done

# 2. Upload the new map and the cleanup list (simple upload, replace on conflict), then check sizes.
put() {
  local file=$1 name=$2 out size
  out=$(curl -sS --fail-with-body -X PUT "${AUTH[@]}" -H "Content-Type: application/octet-stream" --data-binary "@$file" \
    "$G/drives/$DRIVE/items/$FOLDER:/$(enc "$name"):/content?@microsoft.graph.conflictBehavior=replace")
  size=$(jq -r .size <<<"$out")
  [ "$size" = "$(stat -c %s "$file")" ] || { echo "onedrive: size mismatch for $name ($size bytes)" >&2; exit 1; }
  echo "onedrive: uploaded \"$name\" ($size bytes) $(jq -r .webUrl <<<"$out")"
}
put "$MAP" "$MAP_NAME"
put "$CSV" "$CSV_NAME"
