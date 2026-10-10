# Phase 18.6 progress

Resume file for Phase 18.6 (usability, Baby payers, household self-service and payroll, one-sheet exports, Users page, usage meter). Started 2026-10-11 from `0769cff`. Checkpoint tag: `phase-18-6-start`.

Scope boundaries: staging only (Firebase `luna-business-os`, Netlify `luna-business-os`). No production deploy, no Phase 19, no rule weakening, no pricing changes, never delete `C:\MONPRA~1`.

## Plan (decisions made from the brief)

### Stage 1: Distributor
- **Order source:** one "Where did the order come from?" box with suggestions (Messenger, Viber, Walk-in…). It is parsed into the existing structured `source` id plus `sourceNote` (`shared/orders.js` `parseSourceText` / `sourceText`). Filters, reports and stored data are unchanged; anything that matches no known source is saved as Other plus the typed note.
- **Inventory labels:**
  - "Stock left" (= available) is the main column.
  - "In stock" (on hand) and "Set aside for orders" (reserved) are secondary, with a one-line explanation.
  - "Opening balance" becomes "Starting stock".
- **Product costs:**
  - **Where they show:** inside Inventory/Products, with no new module. With `inventory.costs`, rows show the average cost and the estimated profit per unit; details show the cost history (stock received with unit costs) and the costing method.
  - **Costing method (unchanged, now documented):** moving weighted-average cost.
  - **COGS:** each order line snapshots its cost when it is fulfilled. Old profits are never recalculated with today's cost.

### Stage 2: Baby
- **Who paid:** expenses get **Paid by**, a list of `{name, amount}` (split contributions, which must add up to the amount). Provider (a saved directory entry), Payee (who received the money) and Paid by are separate. Reference moves to optional details.
- **Payer totals:** `budgets/current.spentByPayer`, server-maintained. Older expenses with no payer show as "Not set" (spent − Σ payers), with no migration.
- **Partial payments:** a scheduled payment can be paid in parts. Each part is one expense, and Upcoming counts only the unpaid remainder.
- **Dashboard:**
  - Three cards: Total spent, Still to pay (upcoming remainder) and Spent this month.
  - A card per payer.
  - Coming up, kept from before.
  - Removed: the budget card, the expense count, Recent and Needs attention.
- **Budget:** Total budget = the sum of category budgets, maintained server-side. Manual total entry is refused for Baby; Bridal is unchanged.
  - **Category rows:** Edit, then Delete if the category is unused, otherwise Hide (archive).
  - **Existing tenants:** a staging migration recomputes their total.

### Stage 3: Household access and attendance
- **Staff accounts:** a new `household_staff` role with self-service permission keys. The account is linked to its `householdStaff` record (`memberUid` ↔ `member.staffId`).
- **Activation:** the Owner creates the account and gets a one-time activation link to share (hashed, expiring, single use). The staff member chooses their own password. A login ID works when the person has no email.
- **Staff screen:** a simple, separate screen that reads only through `/api/me` (no direct Firestore reads of household data).
- **Attendance statuses:**
  - Present and Paid Leave (the existing `official_leave` id) are paid.
  - Absent, Unpaid Leave and Rest Day are unpaid.
  - Staff submit a request; the Owner approves or rejects it. Pending or rejected requests never touch attendance or payroll.
- **Rest day legal note:** see "Payroll legal notes" below.
- **Cash advances:** Requested → Approved (not released) → Released → deducted per payroll by installment until the remaining balance is 0, or Rejected. A released amount is never deducted twice: one payroll owns the next deduction at a time.

### Stage 4: Household payroll
- **Payroll lines:** additions (Bonus, 13th Month Pay) and deductions. Gross = basic pay + additions; Net = gross − deductions.
- **13th month pay:** entitlement for the year = 1/12 of the basic pay earned in the calendar year, minus 13th-month pay already paid or on another payroll.
  - It is checked when added and again at release, and serialized through the staff document.
- **Salary payment:** Cash, GCash or Bank Transfer (Maya and Other are kept for older records), with optional proof upload (storage-metered).
  - The Owner's payment status is independent of the staff member's "I received my salary". The staff member can also report "Not received" (disputed).
- **Dashboard:** "Total salary to pay, next cutoff", plus a row per staff member (estimated net, advance to deduct, payment status, receipt status) and pending approvals. It comes from `GET /api/household-summary`.

### Stage 5: Shared
- **Excel:** one worksheet per download.
  - Layout: title and info rows, ONE header row (frozen, with filters), peso number format, real dates, and a totals row only where it can't double count.
  - Multi-part reports use a "Record type" column.
- **Users page:** member list (name, role, status, actions); Add member; change role; remove access; new activation link; role templates in a small section at the bottom.
  - Server checks: `users.manage`, no self-change, no Owner role grants, the account owner is protected, user limits apply, and everything is audited.
- **Usage meter:** exports were already counted server-side (`usage/{month}.exportsGenerated`). Settings showed the usage captured at sign-in and never refreshed it.
  - Fix: Settings reloads current usage from `/api/usage`, and a finished download refreshes it.
  - Shown as "Excel exports: N this month". There is no export limit, because adding one would change plans and pricing.

### Stage 6: UI polish
Terminology pass, desktop/390px checks and accessibility.

### Stage 7: Release gate
Unit, emulator (in batches), mutation, build, staging deploy, live probes, CI.

## Payroll legal notes (Kasambahay Law, RA 10361 and IRR)

Recorded so the calculation method is explicit. Not legal advice: confirm with DOLE or an adviser before real payroll.

- **Weekly rest:**
  - The law requires at least 24 consecutive hours of rest a week.
  - Luna pays by DAILY wage only (no monthly-rated staff yet), so a Rest Day is simply a day not worked and not paid ("no work, no pay"). That is not a deduction from a wage that already covers it.
  - If monthly-rated staff are ever added, rest days must stay paid inside the monthly wage and must never be deducted.
- **Work on a rest day:** if the person works on their rest day, mark them Present (paid at the daily wage). Luna adds no rest-day premium automatically; any agreed premium can be added as a Bonus. *Needs the Owner's confirmation.*
- **Paid Leave:** paid at the daily wage. This covers the 5-day yearly service-incentive leave after one year of service.
- **13th month pay:**
  - The amount is 1/12 of the total basic salary earned in the calendar year, for workers with at least 1 month of service, paid no later than December 24.
  - Basic salary = Luna's basic pay (paid days × daily wage, including paid leave). It excludes bonuses and 13th-month pay itself.
  - The year is the payroll's period-end year.

## Progress

| Stage | Status | Commits | Tests |
|---|---|---|---|
| 0 Plan + checkpoint | done | (this file) | n/a |
| 1 Distributor | pending | | |
| 2 Baby | pending | | |
| 3 Household access | pending | | |
| 4 Household payroll | pending | | |
| 5 Shared | pending | | |
| 6 UI polish | pending | | |
| 7 Release gate | pending | | |

## Known blockers
- Low memory on the dev machine (about 280 MB free at the start). Unit tests run with `--maxWorkers=2`, emulator suites in small foreground batches.
- I can't sign in to staging in a browser with real passwords, so screenshots use the preview harness with realistic data.

## Next action
Stage 1: order source box, then inventory labels, then product cost visibility.
