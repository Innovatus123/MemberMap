#!/usr/bin/env bash
# Writes .env from the GrowthZone key PDF kept in Box (20_GBCA/80_Automations/00_Instructions,
# "Growthzone API.pdf", file id 2499294364680). Download the PDF to disk first, then:
#   scripts/gz-key-from-pdf.sh /path/to/Growthzone-API.pdf
# Never prints the key. Deletes the PDF and its text when done.
set -euo pipefail
pdf=${1:?usage: scripts/gz-key-from-pdf.sh <pdf>}
command -v pdftotext >/dev/null || { echo "gz-key: pdftotext not installed (apt-get install poppler-utils)" >&2; exit 1; }
txt=$(mktemp)
trap 'rm -f "$txt" "$pdf"' EXIT
pdftotext -layout "$pdf" "$txt"
key=$(grep -oE 'API key is[[:space:]]+[A-Za-z0-9]{30,}' "$txt" | awk '{print $NF}' | head -1)
[ -n "$key" ] || { echo "gz-key: no API key found in the PDF" >&2; exit 1; }
umask 077
printf 'GZ_BASE_URL=https://generalbuildingcontractorsassociationagc.growthzoneapp.com/api\nGZ_API_KEY=%s\n' "$key" > .env
chmod 600 .env
echo "gz-key: wrote .env (${#key}-character key)"
