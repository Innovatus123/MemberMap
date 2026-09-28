GBCA MEMBER MAP - FIRST DRAFT (September 28, 2026)
INTERNAL USE ONLY - Board of Directors and staff. Do not forward outside GBCA.

WHAT IS IN THIS FOLDER
  GBCA Member Map - DRAFT 2026-09-28.html   The interactive map and member directory.
  Member Map - Data Cleanup List.csv       46 records Membership needs to fix in GrowthZone.
  READ ME - GBCA Member Map.txt            This file.

HOW TO OPEN THE MAP
  1. Download the .html file (SharePoint does not run web pages inside the browser preview).
  2. Double-click the downloaded file. It opens in Chrome or Edge.
  3. An internet connection is required (for the map library and the street-map background).

WHAT IT DOES
  - Shows 339 member companies: 332 on the map, colored by membership type
    (Active = GCs, Associate = specialty contractors, Affiliate = suppliers and services).
  - Search by company, contact or city. Click a pin or a list row for the full record,
    including primary contact, email and a Google Maps directions link.
  - Filter by membership type, region (Philadelphia, PA Suburbs, South Jersey, Delaware,
    Other PA, Other NJ, Outside PA/NJ/DE) and dues tier.
  - County shading shows where members are concentrated. Click a county to filter to it.
  - "Members by region" table breaks down every region by membership type.
  - List view (sortable), Export CSV of whatever is filtered, Print.

LIMITS OF THIS DRAFT - READ BEFORE USING THE NUMBERS
  1. Source data. Built from two GrowthZone exports saved in SharePoint, not from a live
     GrowthZone connection:
       - 2026 Membership Directory mailing list (Sep 3, 2026) - who is on the map, and addresses
       - GrowthZone contacts report (May 25, 2026) - membership type, dues tier, primary contact
     The production version pulls straight from the GrowthZone API on a schedule.
  2. Locations are approximate. Pins sit at the centre of each member's ZIP code. Street-level
     placement is built in and will switch on at the first live run (the Census Bureau geocoder).
     County and region counts are reliable at ZIP level; individual pin positions are not.
  3. 11 members joined after May 2026 or were renamed, so their membership type shows as
     "Type not on file". 17 companies from the May report are not on the September mailing list
     (dropped, or missing an address). Both groups are on the Data Cleanup List.
  4. 7 members cannot be mapped (no address, or an unusable one), and 10 list only a PO box.
     The PO-box members are pinned at their ZIP code for now.
  5. Dues tier is member-reported revenue. Treat it as confidential.

NEXT STEPS
  - Membership works the Data Cleanup List in GrowthZone.
  - IT/COO confirms the GrowthZone API field map (a one-time check run with the API key).
  - Switch the source to the live GrowthZone sync and schedule a weekly refresh.
  - Decide whether a members-only version goes on the new website (see the plan in the code
    repository, docs/PLAN.md).

Source code and plan: GitHub repository innovatus123/membermap
