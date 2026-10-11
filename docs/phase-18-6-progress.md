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

## Stage 8 (added 2026-10-11): Luna subscriptions, tenant payments, Super Luna revenue and platform costs

The user added this to Phase 18.6 after the Stage 7 staging release (fb21e2a / 20b427a, verified live). Decisions, chosen as the simplest safe option where the brief leaves room:

- **Workspace-scoped plans.** Each plan has `workspaceTemplateId`.
  - Distributor keeps starter / growth / pro with the same prices and limits; their non-Distributor module flags become false (no effective change, since the template already excludes them).
  - New plans:
    - Household: household-basic ₱149 / household-plus ₱299
    - Baby: baby-basic ₱149 / baby-plus ₱249
    - Bridal: bridal-basic ₱199 / bridal-plus ₱399
    - All are pricing hypotheses with no setup fee.
  - Limits use the existing keys only (users, storage; orders and imports are 0 because those modules don't exist in personal workspaces).
  - assignPlan / createBusiness refuse a plan from another workspace.
  - Migration (`scripts/adopt-workspace-plans.js`, dry run first) moves personal tenants off Distributor plans: starter -> Basic, growth/pro -> Plus.
  - Order: seed the new plans -> migrate -> overwrite the Distributor plans.
- **Subscription money on the business.** `subscription.monthlyAmount` (centavos snapshot of the plan price), `paidThrough`, `nextRenewal`. MRR uses Firestore aggregate sum() over active/past_due businesses (no scan).
- **Invoices.** `subscriptionInvoices/{businessId}_{YYYY-MM}` (top level, server-only):
  - Fields: plan + price snapshot, amountDue, amountPaid, status due | for_verification | paid.
  - A monthly billing run creates the period's invoices once (`platformMetrics/{YYYY-MM}.invoicesGenerated`). A business added later gets its invoice when its owner or an operator opens it.
- **Payments.** `subscriptionPayments/{id}` (top level, server-only), status for_verification | paid | rejected.
  - The tenant Owner submits through `/api/subscription`. The proof is sent to the server, which checks type and size and stores it at Storage `platformBilling/{businessId}/{paymentId}`.
  - That path is denied to browsers and NOT metered: it is Luna's billing file, not tenant storage.
  - Operators see the proof through `/api/operator` (returned inline, no public URL).
- **Confirm / reject (operator).** One transaction each: payment, invoice, business subscription (paid-through / next renewal; past_due -> active on full payment; suspended is left to the operator), `platformMetrics/{verified month}` and a platformAudit record. Idempotent: an already-decided payment returns alreadyDecided and changes nothing.
- **Collected this month** = Σ verified payments by verification month (cash basis). **Still to collect** = Σ (amountDue − amountPaid) of open invoices. **For verification** is reported separately.
- **Payment settings.** One `platform/billingSettings` document (bank name, account name and number, instructions), edited by operators and read by every workspace.
- **Platform costs (Luna's own, never tenant Expenses).**
  - `platformExpenses/{id}`: month, category (firebase_gcp, netlify, resend, domain_dns, other_saas, other), description, amount, recurring | one_time, notes, reference. Firebase/GCP and Netlify items count as the actual infrastructure bill.
  - "Copy recurring items from last month" is idempotent per month.
- **Cost rate card.** `platformCostRates/{id}` is append-only and versioned by effectiveFrom: provider, resource, unit, ratePerUnit (centavos, decimals allowed), currency, freeAllowance (platform-wide, never given to one tenant). A month uses the rates in effect on its first day.
- **Measured infrastructure.** Storage retained (usage storageBytes) and export downloads (new `exportBytes` counter, from now on). Firestore reads/writes/deletes and function execution aren't metered per tenant, so they show as **Unavailable** and are never guessed from orders.
- **Profit.** Estimated Platform Gross Profit = verified revenue − platform expenses entered for the month. Estimated gross margin = GP ÷ revenue. Per workspace / plan / tenant uses DIRECT estimated usage cost only (shared costs are not allocated), labelled so.
- **Super Luna tabs:** Overview (money story), Businesses, Subscriptions, Payments, Plans (grouped by workspace, subscriber counts), Usage (usage + cost; platform costs and rate card in sub-sections), Audit.
- **Tenant:** a Subscription page (Owner, billing.view), outside the module registry like Notifications, so no entitlement snapshot changes. Notifications: tenant Owner gets submitted / confirmed / rejected; operators see the For verification count in the console (Notification Core is per tenant).

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
| 1 Distributor | done | fff5cc2 | unit (targeted) green |
| 2 Baby | done (exports in stage 5) | see git log | unit 1200/1200 |
| 3 Household access | done | 1c889d9 | unit 1218, rules payroll 18/18 (emulator) |
| 4 Household payroll | done | 373a05f | unit 1227/1227 |
| 5 Shared | done | a53a43f + (users commit) | unit full suite green |
| 6 UI polish | done | fdea8e2, 9cc8c0d, 0d1c972 | unit 1242/1242; 22 pages × 390px + 1280px audited (no horizontal overflow, no unnamed buttons/links, no unlabelled inputs) |
| 7 Release gate | in progress (feature freeze 2026-10-11) | 709350f, d1d429e | unit 1259; emulator 2934 + re-runs; mutation 34/34 killed |

## Stage 7 log
- Supplier Paid? check: added an optional idempotency key to expense create (709350f); a retry returns the first expense (alreadyRecorded). Paid pre-fills only the unscheduled remaining balance; the server refuses paying beyond the agreed amount (over-agreed).
- Mutation (scratchpad mutate186.cjs, targeted tests, sha256 restore check): 34/34 killed. It found a real bug: the delivery-address history line was duplicated in the edit path and missing from the fulfilled-order correction path (fixed in d1d429e).
- Staging Firestore rules + indexes deployed 2026-10-11 (live rules == source for Firestore and Storage; Storage not redeployed). 8 new guests indexes were building.
- resync-permissions --all: every owner/manager gained attendance.self / advances.self / payroll.self (owner = ALL by design; manager = ALL minus 4). They're inert without member.staffId.
- Budget-total dry run: demo-baby-a 150,000 -> 150,000; demo-bridal-a 500,000 -> 390,000; sample-baby none -> 10,000; veah-bridal none -> none. No tenant has a budget on an inactive category, so the sums of all and of active categories are the same. Apply after the code push.

## Known blockers
- Low memory on the dev machine (about 280 MB free at the start). Unit tests run with `--maxWorkers=2`, emulator suites in small foreground batches.
- I can't sign in to staging in a browser with real passwords, so screenshots use the preview harness with realistic data.

## Next action
Stage 7 release gate: full unit, emulator in foreground batches, mutation, build, staging deploy (rules first), `adopt-baby-category-totals` dry run then `--apply`, `resync-permissions --all`, live probes, CI.

User request (2026-10-11, mid stage 7): order form uses a dropdown of every active SKU, a source dropdown (note only for Other) and an optional Delivery address (`orders.deliveryAddress`, max 300; in details, history and the Orders export). Done in 0d1c972.

Stage 7 emulator suite: ALL GREEN, 2934 tests / 38 files in 8 foreground batches (79, 64, 64, 72, 35, 186, 1696, 738). Fixed stale fixtures: Baby concurrency + safe-deletes (manual Baby total now refused), emulator Orders export (one-sheet layout).

User requests 2026-10-11 (Wedding), DONE:
- W1 88cf9d0: Wedding total budget = sum of category budgets (server; setTotal refused). Staging: run `adopt-baby-category-totals` (now covers Baby + Wedding) dry run, then `--apply`.
- W2 b548120: Wedding dashboard: Needs attention removed; Payments coming up leads with the total of all upcoming payments.
- W3 307abfc: Wedding Suppliers rows carry Paid? (Unpaid / Partly paid / Paid -> records one expense) and Scheduled (open / mark paid / schedule). Supplier Payments left the menu (still reachable as Payment history).
- W4 (this commit): guest Category (fixed list; old free-text group kept as a note), RSVP dropdown per row (Attending = whole party), category filter (+8 guests indexes, deploy before the code), dashboard guest list by category (guestTotals.byCategory, server-kept). Older guests have no category: they show as "Not set" until edited; no migration.

Stage 6 notes: terms are now Budget left / Still to pay / Coming up (UI + Excel); inventory Adjust uses In stock / left after orders set aside; phone KPI hints wrap to 2 lines instead of an ellipsis. The audit script (CDP device emulation on the preview build) lives in the session scratchpad, not the repo.

## Staging steps still to run (stage 7)
- `scripts/adopt-baby-category-totals.js` dry run, then `--apply`, on staging Baby tenants (demo-baby-a).
- `resync-permissions --all` after the new role and permission keys land (stage 3).
