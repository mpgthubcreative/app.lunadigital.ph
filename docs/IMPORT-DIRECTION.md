# Excel import: hidden for now, and where it goes next

Updated 2026-10-19 (Owner pilot). **Status: hidden, not launched.** For now, data only flows out of Luna (Luna → Download Excel), not into it (Excel → Luna).

## Now

- No customer can open Imports in any workspace (Household, Bridal, Business, Baby). Only the Business (Distributor) workspace ever had it.
  - There is no navigation item, More menu item or route; `/imports` shows "Page not available".
  - Settings shows no Imports module line, limit or meter, and there are no "Coming soon" placeholders.
- **How the server blocks it:** `UNLAUNCHED_MODULE_IDS = ["imports"]` in `shared/modules.js`.
  - `canUseModule` treats the module as unusable.
  - `requireTenant` refuses every `/api/imports` request (403) for every tenant user, including the Owner, whatever they send.
  - Firestore and Storage rules only ever allowed *reading* old import job records; all writes go through the API.
- **What stays in place:**
  - Plans and entitlement snapshots still say `imports: true`, so existing subscriptions stay valid; nothing is migrated.
  - The import code stays and remains tested: `shared/imports.js` (autoMap, mapRows, convertRow), `netlify/functions/_lib/imports.js` (preview / commit / cancel, idempotent, resumable, plan limit), and the page in `src/modules/imports/`.
- To launch it, remove `"imports"` from `UNLAUNCHED_MODULE_IDS`, after the flow below is built.

## The future flow (do not build yet)

Exact Luna headers should be the fastest path, not a strict requirement.

1. Upload Excel.
2. Choose the sheet.
3. Luna reads the headers.
4. Luna suggests column matches (e.g. Item Name → Product, Qty On Hand → Stock, SRP → Selling Price). `autoMap` is a starting point.
5. The user maps any unmatched columns.
6. Preview the rows.
7. Validate:
   - required fields
   - duplicates, both within the file and against existing records
   - invalid dates
   - invalid amounts
   - unknown categories
   - negative stock where it isn't allowed
   - duplicate order numbers where relevant
8. Confirm the import (Ready rows; rows with warnings only when the user chooses).
