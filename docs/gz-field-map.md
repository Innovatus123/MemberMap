# GrowthZone field map (confirmed)

Confirmed against GBCA's GrowthZone database with `npm run discover` on 2026-09-29. Field names
and value codes only; no member data. `src/gz/sync.js` implements this map.

## Behaviour that differs from GrowthZone's public docs

| Item | Docs suggest | GBCA's API actually does |
|---|---|---|
| `POST /memberships/all` paging | `Page`/`PageSize` in the body | Ignores them. Pages with OData `$skip`/`$top` on the query string. |
| `POST /memberships/all` status filter | `MembershipStatusTypeId` in the body | Ignored (also `$filter`). Returns every status; the sync filters to the configured statuses. |
| Status codes seen | 1, 2, 4, 8, 16, 32 | 1 Pending Approval, 2 Active, **5 Dropped** |

## Map record ← GrowthZone

| Map field | Source |
|---|---|
| company | `OrgGeneral.ContactDisplayName` (fallback: membership row `Name`) |
| membership type, tier | membership row `Type`, e.g. "GBCA Associate Member - $5 Million to $10 Million" |
| member since | membership row `StartDate` |
| organization vs individual | `OrgGeneral.SystemContactTypeId` and `memberships/types.OwnerContactTypeId`: 2 = organization, 1 = individual |
| phone | `OrgGeneral.ContactInfos` with `Type` 2, primary first, the "Main" line preferred over Fax/Toll Free |
| email | `ContactInfos` `Type` 1 |
| website | `ContactInfos` `Type` 4 ("Homepage") |
| primary contact, title | `OrgGeneral.Contacts[]` where `IsPrimary`: `Name`, `Title` |
| address lines | `ContactAddresses[]`: `Address1`, `Address2`, `City`, `StateProvince`, `PostalCode` |
| address type | `ContactInfos` with `Type` 3, linked by `EntryId` → `ContactAddresses.Id`; `AddressType` 1 Physical and Mailing, 2 Mailing, 3 Physical |

Address choice: physical (1 or 3) before unlabeled before mailing (2); primary first within a
rank; PO boxes last.

## Not used yet

- `OrgGeneral.Categories` (lists "Business Category", "MembeeStatus", "Bargaining Rights"): a
  candidate source for a type-of-work filter.
- `contacts/{id}/NotesAndFields` custom fields: certifications (MBE/WBE, etc.) if GBCA tracks them.
- `contacts/org/{id}/groups`: committee and group membership.
