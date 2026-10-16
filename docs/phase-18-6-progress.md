# Phase 18.6 progress

**Phase 18.6: CLOSED — staging verified (approved by the user 2026-10-11).**

| | |
|---|---|
| Final deployed commit | aed3b61 (staging, Netlify; CI passed) |
| Unit | 1,281 |
| Emulator | 2,944 (40 files) |
| Release mutations | 34/34 killed |
| Billing mutations | 28/28 killed |
| Live release probe | 48/48 |
| Live billing probe | 23/23 |
| Responsive / live UI | 82/82 (1280 / 820 / 390) |
| Phase 19 | not started |

Post-close fix (2026-10-11, recorded separately): the Baby / Bridal planning Total budget now counts ACTIVE categories only. Deactivating a category takes its budget out and reactivating it brings it back; expenses and history are untouched (setCategoryStatus recomputes the total). Targeted tests: unit 538 (baby, wedding, billing, shared), emulator 37 (baby + wedding concurrency, baby rules). See "Post-close" below for the deploy.

Owner pilot: the user is now testing Luna as a tenant across the four workspaces and Super Luna. Track their observations below; consolidate them (possibly a "Phase 18.7 — Owner Pilot Polish", only if the user asks). No speculative changes while they test.

## Post-close
- c3992c5 (2026-10-11): active-categories-only planning total, deployed to staging (CI passed, Netlify ready). No rules or index changes. Staging data needed no change: the adopt-baby-category-totals dry run reported every Baby / Bridal tenant already on the active-category total (no tenant has a budget on an inactive category).

## Owner pilot observations

### 2026-10-11: Household Staff account, permissions and payroll (fixed, `cc293f9`)
- **Report:** the kasambahay was added from Users as Manager / Admin, and staff, payroll and login felt like separate enrollments.
- **Root cause:**
  - Add member in a household offered only "manager", so the kasambahay ("Yanie", `rwp-d419`) got Manager access with no staff link.
  - The real staff-login flow (Household Staff → Create login) lived only on the staff page.
  - Payroll was prepared one person at a time, and inactive staff had no end date.
- **Fix:** one staff record is the employee master.
  - **Users page:** Add member asks for the access type (Household Staff is the default). Household Staff logins are always linked to a staff record. The ⋯ menu has **Make household staff**, which converts a mistaken Manager / Admin login in one audited transaction.
  - **Payroll:** "Prepare payroll → Everyone on payroll" includes everyone employed in their own pay period (start / end date, status), skips the rest with a reason, and never enrolls anyone twice.
  - **Deactivation** sets the end date to today, keeps the history and excludes later periods. Reactivation clears that end date.
  - **Corrections:** correcting a day the employee sent needs a reason, which is kept in its history with before / after / editor / time.
  - **Label:** the role is now "Household Staff".
- **Tests:**
  - Unit: 1293 pass, including the new `tests/functions/household-access.test.js`.
  - Emulator batch (rules payroll + membership, payroll + safe-deletes concurrency): 55/55.
  - Build: OK.
- **Staging smoke test** on a temporary household `p186h-home-tmp` (deleted afterwards):
  - 31/31 API checks: real activation → own password → sign-in; attendance, leave and advance requests; Owner-only approve / release (staff 403); a correction needs a reason; the advance is deducted; Prepare-all includes Yanie and skips a Dec 1 starter; own salary only; Owner release → staff "received"; Super Luna and other tenants 403; Make household staff; deactivate / reactivate.
  - Headless browser, 8/8: the staff login ID opens only the staff portal (typed `/payroll` and `/users` URLs stay on the portal). The Owner's Users page shows "Household Staff".
- **Yanie converted (2026-10-11, approved by the user):**
  - Her staff record was created on `rwp-d419` from the user's details: All around helper, ₱411.00 a day, semi-monthly, started 2026-06-07. Riza is a different person and was left untouched.
  - Make household staff was run as the Owner (audit `member.updated`, actor Carlo): "Changed from Manager / Admin to Household Staff, linked to Yanie".
  - Same uid, email and password; no duplicate account, member or staff record.
  - The Users page shows Yanie — Household Staff — Active. She is eligible from Jun 1–15 onward, including the current Oct 1–15 period, and not before.
  - With her own account: the session is Household Staff, `/api/me` loads only her records, and Owner / Manager endpoints return 403.
- **Polish candidate (18.7, not done):** when an advance is larger than the pay earned so far, the staff portal shows a negative "Estimated take-home". Release is already blocked with "move an advance to the next payroll".

### 2026-10-11: Household Staff pay-period attendance (polish, `5af4472`, `7f349e9`)
- **Report:** the staff portal only allowed marking today; the user asked for multi-date attendance for a pay period (e.g. Oct 1–15).
- **Staff portal, "My attendance":**
  - Shows the pay period (‹ Sep 16 – 30 · Oct 1 – 15 · Oct 16 – 31 ›), one compact row per date with a status dropdown.
  - Future days offer leave / rest day only.
  - Bulk actions: select days → Present / Rest Day, Clear selection, Select all open days.
  - "Review N days" lists the changes, then "Submit attendance" sends them as ONE submission.
  - Locked rows: days before the start date or after the end date, Owner-approved days ("Approved", read-only), days in a paid salary, and days more than 14 days back (the existing rule).
  - Pending days show "Waiting" and can be changed until approved. Rejected days say so and can be sent again.
  - Navigation: from the start-date period (at most about 2 months back) up to 90 days ahead, never past the end date.
- **Server:** `/api/me` `attendanceDays { days: [{date, status}], note? }`.
  - Runs in one transaction, all or nothing: any refused day sends nothing and names each refused date (409 `days-not-allowed`).
  - Uses the linked staff id only; a staffId in the body is refused (400).
  - Writes one request per day with its own revision and history, plus one notification for the Owner.
  - Retrying the same submission is a no-op: no new history and no new notification.
  - `GET /api/me?period=` returns the sheet; the single-day request now also refuses dates after the end date.
- **Owner Attendance page:** requests are grouped per person and pay period, e.g. "Yanie · Oct 1 to Oct 15 · 3 days: 2 Rest Day, 1 Paid Leave", with **Approve all / Reject all**.
  - `attendance` `decideMany` decides each day in its own transaction, the same as a single decision, so per-day history and payroll updates are kept.
  - Per-day Approve / Reject is kept.
  - The requests cards (Attendance, Advances) got the missing inner padding.
- **Tests:**
  - Unit: 1304 pass, including the new `tests/functions/household-sheet.test.js` (8) and UI tests for the sheet, review, period navigation and Approve all.
  - The database rules are unchanged, so the emulator rules batch was not rerun.
  - Build: OK.
- **Staging** (temporary household, deleted afterwards):
  - 18/18 live API checks: own-password sign-in, sheet and period navigation, an approved day refused with nothing sent, future Present refused, another employee refused, 11 days in one submission, retry no-op, pending change, rejected resend, staff Approve-all 403, Owner Approve all 11, payroll counts 6 present + 2 paid leave = 8 × ₱411.
  - Headless browser at 390px and 1280px, 12/12: sheet rows, review, submit, period navigation, the Owner's grouped list; no sideways scroll; every control labelled.

### 2026-10-11/12: Household improvement batch (polish, `f987e89`, `daa7531`, `f9c9c9e`, `9adcc5b`, `35e73f3`)
- **Request:** one batch so Household reads "Staff submits → Owner reviews → Payroll updates automatically → Owner pays": approvals by helper, pending requests by helper, a working phone notification panel, automatic payroll periods (custom cutoffs too), early salary payment, a per-helper cash advance limit. Items 1–2 (pay-period sheet, navigation) were already live from `5af4472`.
- **Attendance approvals:** "Waiting for your approval" has its own Employee filter (All employees / each person with a count). With All employees, requests are grouped per helper, then per pay period ("Oct 1–15 · 6 pending", Reject all / Approve all 6). Approve all / Reject all act only on the visible requests of that group; hidden people are never decided. The lower part is titled "Attendance history: review and correct recorded days". `?staff=<id>` opens the list filtered.
- **Dashboard:** "Pending requests" lists only helpers with something pending: name, total, and types (Attendance / Leave / Advance). A tap opens Attendance filtered to them (or Advances when that's all they have; a second link when they have both). The server summary returns `pending.byStaff`. "This cutoff, per person" now uses the same eligibility rule as Payroll (someone starting next month isn't listed or counted).
- **Notifications:** on phones the bell opens a sheet inside the viewport (8px margins, wrapped text, 44px Close and links); desktop keeps the 360px popover. Request copy is plain: "Attendance request · Yanie submitted 6 days for Oct 1–6. 4 Present, 1 Absent, 1 Paid Leave." (Leave request when all days are leave). "Review requests" closes the panel and opens Attendance filtered to that helper; an advance request opens Advances filtered to that request's helper.
- **Pay cycles:** semi-monthly 1–15 / 16–end (unchanged), monthly, and custom semi-monthly cutoffs on the staff record (e.g. 14 and 29: periods 30th–14th and 15th–29th). The second cutoff stops at the month's last day (Feb 28/29), so no day is lost or repeated. Changing the cycle or cutoffs still requires no unpaid stored payroll. A day already paid in an earlier payroll is never counted again after a cycle change.
- **Automatic payroll:** no Prepare step in the UI. Payroll opens "By period" on the current period, with history in a selector (newest first, from each person's start date, up to 24 periods). Everyone eligible by status, start and end date, and cycle is listed. A period nobody touched is worked out on the fly from approved attendance, approved leave, released advances and bonuses / deductions; looking stores nothing, so there are no duplicates. The first real action (pay, bonus, deduction) stores it once (keyed person + period start). When helpers' cutoffs differ, "Now (everyone)" shows each person in their own current period. The old `prepare` / `prepareAll` actions still exist on the server.
- **Early salary payment:** the period end no longer blocks payment; a future payment date is still refused, and nothing is stored when refused. Paying before the period end is labelled "Early salary payment" with the warning that attendance after the payment date may still change the final salary. Stored: `paymentTiming: early`, `salary.paidDate`, `salary.amount`, the period. Days up to the payment date lock; days after it stay open (staff can send them, the Owner can approve them) until the period closes; nothing is marked absent. The original payment is never rewritten. The payroll shows "Paid ₱X on Oct 12 … final take-home is now ₱Y: ₱Z more / less than paid". The receipt stays the employee's own step. Pay also checks the take-home the Owner saw (`expectedNetPay`), refused if it changed.
- **Cash advance limit:** an optional per-helper limit on Household Staff (blank = no limit, 0 = no advances, negative refused). Available = limit − outstanding released balance − approved-not-released. Staff see Limit / Outstanding / (Waiting) / Available and can't ask above it. Messages: "You can request up to ₱2,000.00 right now." and "You still have ₱5,000.00 to repay before you can request another advance." The limit is re-checked on approval, on the Owner's own record or raise, and on release. Each of those writes the staff document, so parallel actions can't pass the limit. Lowering the limit keeps the debt and blocks new requests; payroll deductions free the room automatically. Staff can't edit the limit, approve or release (403).
- **Rule kept:** an advance released while an earlier unpaid payroll is open is still deducted from that next unpaid payroll (the Phase 14 rule). A change I tried mid-batch broke existing tests, so it was reverted.
- **For a possible 18.7 (not built):** settling an early payment's difference into the next payroll automatically (today the difference is shown; the Owner adds a bonus or deduction).
- **Tests:**
  - Unit: 1338 pass. New `tests/functions/household-batch.test.js` (20): periods (1–15/16–end, monthly, 14/29, February, leap year, a year of contiguous periods), eligibility, no duplicates, history, mixed cycles, early payment and open days, a future date refused, advance-limit cases, notification copy, dashboard grouping, no double-count after a cycle change.
  - UI tests: the approval filter, bulk actions on the filtered employee only, `?staff=`, the period selector, early payment, cutoffs and limit on the staff form, the staff's limit view, the dashboard grouping, and the notification links.
  - Emulator (targeted, `payroll-concurrency` + `rules/payroll`): 28/28, including parallel requests, approvals and releases never passing the limit, and an early payment racing attendance edits. Database rules unchanged.
- **Staging** (temporary household, deleted afterwards):
  - Live API: 32/32 checks, covering automatic periods with mixed cycles, nothing stored by viewing, the advance-limit flow, early payment and open days, notification copy, and the dashboard grouping.
  - Headless browser at 390px and 1280px, 29/29: dashboard, Attendance approvals, the notification sheet, Advances, Payroll (Now / single period, early detail, early modal), the staff form, and the staff advance view.
  - The browser check found and I fixed: Payroll opening on one helper's period when cutoffs differed (`daa7531`), a 30px Close button on the phone sheet and unfiltered advance links (`f9c9c9e`), the squeezed approval heading / cut-off "Now" label at 390px (`9adcc5b`), and the dashboard listing a not-yet-employed helper plus the unpadded Pending requests card (`35e73f3`).

### 2026-10-12/13: Early salary, prepaid days, salary overpayment carryover (polish, `34cc460`, `8774a3f`)
- **Rule (user):** Attendance records reality. Salary payments record money actually given. Prepaid salary bridges the gap when salary is paid before upcoming workdays happen. Salary overpayment reconciles anything ultimately not earned. A cash advance stays separate borrowed money. The helper views, understands and confirms; financial decisions stay with the Owner.
- **Attendance:** an upcoming day can't be marked at all. The earlier rule that allowed planning leave and rest days ahead is replaced (server-side for every path, including approval of older staff requests). Upcoming rows show "Upcoming" (disabled, no tick box); the period list stops at the current period. Paying early never creates attendance.
- **Paying early:** the pay dialog offers "Also pay upcoming days (prepaid salary)?". The default is all upcoming days; fewer or none can be chosen. Prepaid = days × daily wage, from the day after the payment.
  - Stored on the payment: `salary.amount` (total), `earned` (net as of the payment), `prepaid {days, from, to, dailyWage, amount}`, paid date, proof / reference. Never rewritten.
  - More prepaid days than are left is refused before anything is stored (found on the staging check, fixed in `8774a3f`).
- **Reconciliation (after the period ends):** final salary (what attendance earned) vs total paid (payment + any additional payments).
  - **Equal** → Settled.
  - **Less earned** → **salary overpayment**. It's carried automatically to the next unpaid payroll as its own line ("Previous salary overpayment · from Oct 1–15"), and rolls on if that payroll was already paid. It drops only when a paid payroll deducts it, a separate repayment is recorded, or the Owner waives it (reason kept).
  - **More earned** → **Additional salary due**, with "Record additional payment" (kept as `salary.additional`; the original stays).
  - **Days still unrecorded after the period** → Luna waits ("Record the remaining N days") instead of treating a forgotten day as not earned.
  - The ledger lives on the paid payroll (`overpayment {plan, applied, repayments, waivers}`). Stored unpaid payrolls are kept in step in the same transaction. Voiding the payroll that took it makes it owed again; a source whose overpayment was already taken can't be voided first.
- **Owner actions** (payslip ⋯ on the source or on the line): Keep on next payroll / Move to another payroll / Mark repaid separately / Waive (reason), plus View source. There is no destructive delete.
- **Separate from cash advances:** separate lines and separate balances. The advance limit counts only cash advance debt.
- **Helper view:** My Salary shows Earned through (date) · Prepaid for (days) · Total received, with View proof and "I received my salary" (= the money received, not upcoming days). "Previous salary adjustment ₱411: your Oct 1–15 salary was paid early… planned to come off your Oct 16–31 salary." The helper can't change any of it (403).
- **Dashboard:** "Additional salary due" and "Days to record (paid early)" per helper.
- **Tests:**
  - Unit: 1370 pass, including the new `tests/functions/household-prepaid.test.js` (11) with the exact scenario. It also covers all days earned (₱0), additional due, move, repayment, waive, next payroll already paid (rolls on), two sources as two lines, unrecorded days wait, staff 403, a void reversing it, and prepaid-days validation.
  - Older tests that planned leave ahead were updated to the new rule.
  - Emulator: 32/32, including the next payment racing waive / move / repayment (never taken twice; the early payment unchanged).
- **Staging** (temporary household, deleted; staging today = Oct 13, so period-end reconciliation is covered by the tests above):
  - Live API 14/14.
  - 390px browser check 9/9: Upcoming rows, payslip earned / prepaid / total / "final salary so far", pay dialog prepaid options, helper salary view, no sideways scroll.

### 2026-10-12: Owner can delete payrolls and advances (polish, `cc43000`)
- **Request:** an easy ⋯ → Delete for payrolls and cash advances (to clean up wrong pilot entries without a database script), financially safe by state. Built as a general Owner capability; no names or business ids in code.
- **Payroll ⋯ (row and payslip), destructive item last after a separator:**
  - **Saved, unpaid → Delete payroll** (`deleteDraft`, payroll.manage). Plain confirmation. Removes the saved record and its manual lines (bonus, deductions, 13th month). Attendance, staff, advances and their repayment plans stay, so the period shows as worked out automatically again, and viewing never re-stores it. Light audit (`payroll.deleted`, with the manual lines).
  - **Paid → Void payroll** (`void`, payroll.release). Requires a reason, then an explicit confirmation. Reversals:
    - advance deductions it took go back to what's owed (planned again for that period);
    - its attendance days unlock;
    - the receipt link stops working.
  - The record moves to `voidedPayrolls`, keeping the payment, the proof (the Storage file stays with it, still metered, not orphaned), the helper's confirmation and the reason. The period shows as unpaid again. Full audit (`payroll.voided`, with reversals).
  - An unsaved automatic period has nothing to delete (only View details).
- **Advance ⋯, destructive item last:**
  - **Never given → Delete advance** (requested, approved or rejected): removed; light audit.
  - **Given → Delete / Void advance**, reason required: owed is cancelled, its planned deductions leave any unpaid payroll, and separate repayments are reversed and recorded. The record moves to `voidedAdvances` with proof and confirmation; full audit with reversals.
  - If a PAID salary already took a deduction from it, voiding is refused and names that payroll ("Void that payroll first"). The paid salary is never silently changed.
- **Voided records:** a small link on Payroll and Advances lists them (who, period / amount, reason, when). Not readable by browsers directly (no client rule); served by the API to payroll.view / advances.view.
- **Safety:**
  - Every delete or void is one transaction; retries are harmless (`alreadyGone` / `alreadyVoided`).
  - Staff get 403 for all of it, the voided lists included.
  - Limit room recalculates on its own (based on what's actually owed).
- **Tests:**
  - Unit: 1359 pass, including the new `tests/functions/household-void.test.js` (7) and 3 UI tests (menus, confirmations, reason before void).
  - Emulator: 31/31, including a void racing a repayment and a plan change.
- **Staging** (temporary household, deleted):
  - Live API 14/14, including the proof file still in Storage after a void.
  - 390px menu check 10/10: menus inside the screen with 44px items, no sideways scroll.

### 2026-10-12: Household simplification batch (polish, `99acd9b`)
- **Report:** the helper found self-service confusing. New principle: **Owner records and manages; helper reviews and confirms.** Every Household tab keeps only the controls it really needs.
- **Attendance:** one helper + one pay period (Employee ▾, Period ▾), one row per date with a status dropdown; tick days and mark them together (`attendance setMany`). The "By day / By employee" toggle is gone. A compact "Needs review" appears only when the helper reported a correction (or an older request waits), with Open / Done. The helper's confirmation shows per period ("confirmed on …", or "changed since"). Correcting a day the helper sent still asks for a reason (kept in history). `?staff=&period=` opens that helper / period.
- **Helper screen:** Home / Attendance / Salary / Advances.
  - Home lists what to confirm.
  - Attendance shows totals (Present 11 days…), View details, **Confirm attendance**, and **Report a correction** (optional day + one sentence).
  - Salary shows paid salaries with **View proof** and I received / I didn't receive it, plus this period so far.
  - Advances shows amount received, date, remaining balance, planned deduction (read-only), **View proof** and **I received this advance**.
  - The helper can no longer edit attendance, send day requests or ask for advances here (the server actions still exist, and older requests still show for the Owner).
- **Advances (Owner-led):** "Give an advance" records and releases in one step (limit checked; method, reference, proof as screenshot or PDF). The page shows, per helper: Outstanding balance · Next planned deduction · Balance after planned (and Limit · available). Each advance row has ⋯ Details / Edit repayment plan / Record a repayment / View or add proof.
- **Repayment model:** advance → outstanding balance → repayment plan → actual repayment (`advance.schedule`: planned / applied / not_taken / repaid).
  - One advance can be spread over several payrolls, and one payroll can deduct several advances, one traceable line each.
  - A new advance is planned for the first payroll not yet paid, from its release date, so a salary paid early never takes it.
  - Owed (and the limit room) drops only on a paid payroll's deduction or a separate repayment (`repaidAmount`, `repayments`). A plan never changes it, and planned + not taken never exceed what's owed.
  - Planning into a paid payroll is refused.
  - When a salary is paid without a planned deduction (taken off with "Remove from this payroll"), that amount becomes **"Scheduled deduction not taken"**: still owed, with Move to next payroll / Mark repaid separately / Edit repayment plan. The salary paid is never rewritten.
  - Stored unpaid payrolls are kept in step with the plans in the same transaction. Every plan, repayment and payment writes the staff document, so they serialize.
- **Payroll:** Employee (Everyone / one helper) + Period only; the "Not confirmed / All records" tabs are gone. A payroll reads like a payslip, and each line has its own action:
  - Basic pay: View calculation (days × wage) and View attendance.
  - Bonus and other deductions: ⋯ Edit / Delete until paid (`payroll editLine`, history keeps before / after).
  - 13th month: ⋯ Remove.
  - Advance lines: ⋯ View advance / Edit amount / Move to another payroll / Remove from this payroll.
  - A paid salary is never edited in place: **Correct payment** (`correctPayment`) needs a reason and keeps the original (before / after, who, when).
  - Luna has no "absence deduction" line: basic pay is paid days × daily wage, so absence simply isn't paid. "View calculation" shows that.
- **Dashboard:** "Needs your attention" per helper, only helpers with something: attendance correction, salary / advance not confirmed yet (last 31 days), salary not received, deduction not taken, older requests. A tap opens the right page focused on that helper.
- **Notifications** name the helper: "Loriza confirmed receiving the ₱1,100.00 advance (Oct 2).", "… confirmed the attendance for Oct 1–15.", "… reported an attendance correction for Oct 8: "…"". The wording is neutral, with no assumed pronouns. Links open filtered.
- **Security:** the new helper actions take the staff id from the account only. Proofs are served through the API to the Owner, or to the helper they belong to, and never by URL. Staff are refused (403) for setMany, plans, repayments, give, editLine, correctPayment, deferAdvance and limits. The new collections (`attendanceCorrections`, `attendanceConfirmations`) have no client rule, so browsers can't read them directly. Rules unchanged.
- **Staging data migration (one time, through the same server code, history entry "Repayment plan: …"):** every released advance still owed got the plan the old rule implied. In rwp-d419: Yanie ₱2,000 → Oct 1–15 (her unpaid payroll unchanged), and Loriza Ibanez ₱1,100 → Oct 1–15, which the Owner can now split / move. Seven demo advances (₱2,000, Ana) → Oct 5–11. Nothing else was changed.
- **Tests:**
  - Unit: 1349 pass, including the new `tests/functions/household-simplify.test.js` (12) with the exact pilot scenario (₱1,100 → 600 / 500, early payment without the 600, not taken, moved forward, a new advance Oct 13 → Oct 16–31, two traceable lines, cash repayment, limit room only after real repayment). It also covers payroll lines, attendance confirmation / corrections, own proofs, staff 403s and the dashboard. Rewritten UI tests cover Attendance, Payroll lines, Advances, the helper screen and the dashboard.
  - Emulator (targeted): 30/30, including plan changes racing the payment and repayments racing each other.
- **Staging** (temporary household, deleted):
  - Live API 32/32.
  - Headless browser at 390px and 1280px, 24/24, no sideways scroll. Line ⋯ menus stay inside the screen with 44px items, and the helper's PDF proof opens.
- **For a possible 18.7 (not built):** the old helper self-service code paths (day requests, advance requests) could be retired once the pilot confirms they're no longer wanted.


Resume file for Phase 18.6 (usability, Baby payers, household self-service and payroll, one-sheet exports, Users page, usage meter). Started 2026-10-11 from `0769cff`. Checkpoint tag: `phase-18-6-start`.

Scope boundaries: staging only (Firebase `luna-business-os`, Netlify `luna-business-os`). No production deploy, no Phase 19, no rule weakening, no pricing changes, never delete `C:\MONPRA~1`.

### 2026-10-13 · Household cleanup: payroll eligibility, Remove user, payroll ⋯, Paid Leave allowance (6e8f8f8)

Reported: Payroll's Everyone list still showed Riza and Yanie (only Loriza works now) while the Employee dropdown showed only Loriza, so "still to pay" was wrong; Users only had No access; Payroll seemed to have no delete; plus a Paid Leave allowance.

- **Root cause (rwp-d419):** Riza and Yanie were deactivated on Oct 12. Deactivation set their employment end date to Oct 12, and the old rule kept a helper on payroll for any period their employment overlapped ("final period still payable"). The dropdown read active staff only, so the two disagreed. No orphaned or stale payroll records were involved: rwp-d419 has no saved payrolls.
- **Fix (general, no names or IDs):** one shared rule, `onPayroll` / `payrollEligibility` in `shared/payroll.js`, used by the Employee dropdown (the period view now returns `people`), the Everyone list, the still-to-pay total and the dashboard.
  - The Household Staff record decides: active, started by the period's end, no end date before its start, and a valid pay cycle with the period being one of their own.
  - A deactivated helper gets no payroll worked out, not even the period they left in. Pay what's owed before deactivating, or reactivate. The Deactivate confirmation now says so.
  - Saved payrolls of a deactivated helper stay visible as history in their own periods.
  - Nothing was deleted or changed in the real data.
- **Real household verified (read-only, through the server code):** Payroll · Everyone · Oct 1–15 shows only Loriza Ibanez, ₱4,932.00 (12 days), still to pay ₱4,932.00; the dropdown shows Everyone + Loriza Ibanez. Users: Carlo = Owner, Loriza = Household Staff (active), Yanie = Household Staff (No access, left as is until the Owner chooses Remove user).
- **Users:** three distinct states.
  - **Active.**
  - **Deactivate access:** temporary; shows as No access, with Restore access.
  - **Remove user** (bottom of the ⋯, destructive):
    - Removes this business's membership for good (`members` `remove`, `removeMember` in provisioning), takes this business out of `users/{uid}.businessIds` (the default moves to another business), deletes a pending activation link, signs the person out and writes an audit entry `member.removed`.
    - The Household Staff record stays (employment unchanged) but is unlinked, with a history line "Luna access removed". Attendance, payroll, advances and confirmations stay.
    - The Firebase Auth account is never deleted, since it may belong to other businesses.
    - Re-adding (Create login / Add member → Household Staff) links the same staff record; no duplicate.
    - The account owner and you yourself can't be removed. Staff get 403. Retrying is harmless. A Restore racing a Remove can't leave a stale login on the staff record.
- **Payroll ⋯ (Delete / Void already existed since cc43000):** the Owner's real payrolls were all automatic (nothing saved), so the menu only had View details.
  - Every unpaid row now shows **Delete payroll**. On an automatic row it explains that nothing is saved; how to stop paying someone is Household Staff.
  - Paid rows show **View details / Correct payment / Void payroll**.
  - The confirmation text follows the requested wording.
  - Deleting keeps the advance's planned deduction planned (still owed); the recalculated period shows it again.
- **Paid Leave allowance:**
  - **Allowance:** a household default (Household Staff → "Paid Leave allowance: 5 days a year per helper (Jan–Dec) · Change"; `settings/household`, 5 until changed). An optional per-helper number goes on the staff form; blank = the default.
  - **Year and counting:** the year is the calendar year (Jan 1–Dec 31), the same as the 13th month; it starts again at 0 on Jan 1. Used = days recorded as Paid Leave that year; Unpaid Leave never counts.
  - **Where it shows:** Attendance shows "Paid Leave 2026: used 2 of 5 days · 3 remaining"; the helper sees the same, read-only.
  - **When it's used up:** the server refuses a new Paid Leave day (`leave-allowance-used`). The Owner chooses "Unpaid Leave instead" or "Paid Leave anyway (override)" with a reason, kept on the day (`leaveOverride`) and in its history. This applies to approvals of old helper requests too (no override there).
  - **Payroll and history:** payroll follows the recorded status. Leave history stays with attendance through access deactivation or removal.
  - **Concurrency:** the staff record is touched on each new Paid Leave day, so parallel marks can't both take the last day.
- **Tests:**
  - **Unit:** 1388 pass. The new `tests/functions/household-cleanup.test.js` (11) covers the Loriza / Riza / Yanie regression, Remove user (another business untouched, re-add without a duplicate), delete / void reversals and the allowance rules. New UI tests cover the dropdown / list agreement, the ⋯ menus, the allowance dialog, the staff settings and the Users menu.
  - **Emulator (targeted):** 62/62. New: 8 parallel Paid Leave marks with 2 allowed → exactly 2; Remove user racing Restore. Rules: a helper can't write the allowance, their staff record or memberships.
- **Staging:** live API 23/23 on a temporary household (deleted afterwards). The 390px / 1280px browser check passed 20/21. The one miss was my own expectation: a login-ID helper's menu also has the existing "Reset password (new link)". No sideways scroll.
- **Owner decision (2026-10-13):** Paid Leave stays on the calendar year (Jan 1–Dec 31), not the employment anniversary. No automatic proration for mid-year hires: the household default applies unless the Owner sets a per-helper number. No carry-over of unused leave. Batch accepted; staging kept as is.

### 2026-10-16 · Household consolidated polish: dashboard money, simple payslip, Correct payroll, tap-grid attendance, one-step advances, safe bottom (8fa5746, 923fda0)

Items B (eligibility), C (payroll Delete / Void) and D (Remove user) were already live from 6e8f8f8 and were re-verified on the real household. New in this batch:

- **Dashboard (E–G, W):**
  - **Money card:** one compact card for this cutoff, with only an Employee filter (Everyone / each helper). It shows:
    - Salary paid.
    - Still to pay.
    - Prepaid salary, labelled "included in salary paid": it's part of Salary paid, not added on top.
    - Advances outstanding: real unrepaid balance; plans don't lower it; salary overpayments aren't included.
  - **Unpaid ended periods:** "₱X from ended pay periods is still not paid" now also catches an ended period that was never saved (worked out automatically) and nobody paid.
  - **Below the card:** Needs your attention, grouped per helper and following the filter. Then "This cutoff", one line per helper ("Paid ₱5,565 · Prepaid ₱822" plus a confirmation badge such as "Confirmed by Loriza on Oct 15"); a tap opens Payroll for that helper.
  - **+ Give advance** opens the form with the selected helper preselected.
- **Payslip (H–J):**
  - **First view:** the confirmation badge, then Basic pay, each bonus / deduction ("Advance deduction"), Prepaid salary (date range, "not a cash advance"), and Total paid (or To pay).
  - **Paid early:** Basic pay shows what was earned when paid; the payment now stores `salary.atPayment`.
  - **After payment:** "Actually paid / Final salary" (or "Corrected entitlement") with the existing Salary overpayment / Additional salary due / Settled status.
  - **Folded:** calculation, payment, receipt and history sit under View details.
- **Correct payroll (K–M):**
  - **Where:** on paid payrolls, row ⋯ = View details / Correct payroll / Correct payment / Void payroll.
  - **How:** Correct payroll puts a ⋯ on each line that can be wrong:
    - Bonus / manual deduction: edit amount or label, or remove.
    - Advance deduction: correct the amount or remove it. A lower amount leaves the rest owed as "not taken" for that period (Move to next payroll / Mark repaid). A higher amount trims later plans so they never exceed what's owed. The advance itself stays.
    - Prepaid salary: correct the days. Total paid stays the same; earned = paid − prepaid; the original is kept.
    - Basic pay can't be typed: it follows attendance.
  - **Rules:** a reason is required; history and `corrections` keep before / after, who and when. The payment record is never changed (only Correct payment does that). The overpayment, additional salary due and carryover to the next unpaid payroll recalculate.
- **Attendance (N–P):**
  - **Grid:** a calculator-style tap grid (P / A / PL / UL / R with a legend). Tap one or several days, tap a status (or Clear), then Save; a sticky save bar sits above the tab bar.
  - **Fill normal schedule:** shows Expected days (dashed) from the helper's usual rest day. That's a new Household Staff field, `restDays`, defaulting to Sunday.
  - **Confirm through today:** turns the expected days up to today into changes to save.
  - **Copy previous period:** repeats last period's pattern by weekday.
  - **Clear:** new on the server (`status: "clear"`). It takes a recorded day back to Not marked, moves an unpaid payroll's counts, and writes an audit entry (`attendance.cleared`). The usual locks apply.
  - Upcoming days are never recorded.
- **Advances (Q–V):**
  - **Form:** Helper, Amount, Deduct on (Next unpaid payroll / Split repayment / No payroll deduction).
  - **Available amount:** shown in the helper list and checked before sending ("Maximum available is ₱…"); the server still enforces it.
  - **More options (closed):** date (today), method (last used on this device, else Cash), reference, proof, note.
  - **Split** opens the plan editor right after. The server takes `plan: "none"`.
  - **Quick result:** Advance given / Outstanding / Next deduction / Still available / Waiting for confirmation.
  - **Per helper:** Outstanding / Available / Next deduction, plus a + Give advance button.
- **Phone safe bottom (X):**
  - Modals are sized to the visible screen (`dvh`); the body scrolls and the footer never does.
  - Footer menus scroll if they're long.
  - The viewport uses `interactive-widget=resizes-content` (the keyboard resizes the page).
  - The helper portal has safe-area padding at the bottom.
- **Not changed (Y, Z):** the early-salary model and everything the helper confirms ("I received my salary" / "I received this advance" / "I reviewed my attendance").
- **Tests:**
  - **Unit:** 1402 pass. New: `tests/functions/household-polish.test.js` (10). It covers the pilot's exact ₱5,565 → ₱5,315 → ₱250 overpayment case, bonus / deduction / advance / prepaid corrections, Correct payment vs Correct payroll, dashboard money (Everyone vs one, prepaid inside paid, voided excluded, unpaid ended period), Clear, rest days, and give with no deduction. Also rewritten UI tests for the grid, payslip, give flow and dashboard.
  - **Emulator:** 36/36, including Correct payroll racing repayments and itself.
- **Staging:**
  - **Live API:** 14/14 on a temporary household.
  - **Browser at 390px / 1280px:** 30/30. Every footer / Save / Give button is fully on screen and above the tab bar; no sideways scroll.
  - **Real household (rwp-d419), read-only:** Loriza only on Payroll and Dashboard; Oct 1–15 flagged "days to record" (paid early with 2 prepaid days); advances outstanding ₱500. Nothing was modified.

### 2026-10-17 · Household without a Dashboard: Payroll is home, the bell holds what needs attention, clearer buttons (5d27d7a)

Owner request: the Dashboard was redundant; Payroll is the financial home, Advances has its balances, and pending actions belong in the bell. CI for 923fda0 (previous batch follow-up) passed.

- **Navigation (Household only):**
  - **Sidebar:** Payroll · Attendance · Advances · Household Staff · Users (+ Subscription, Settings).
  - **Phone:** Payroll · Attendance · Advances · Staff · More, with the bell in the header.
  - **Home:** "/" (sign-in, the activation page's "Go to sign in", old links) redirects to Payroll and keeps the query.
  - **Dashboard kept, hidden:** the module stays allowed and entitled. The template now has `navHidden: ["dashboard"]` and `home: "payroll"`, and the validator checks both: a template without a Dashboard needs a home, and phones may have up to four tabs then.
  - **Other workspaces:** Distributor / Baby / Bridal keep their Dashboard and three tabs. The helper portal is unchanged.
- **The bell = Needs your attention:**
  - **Source:** GET /api/household-summary now returns `todos`, one plain sentence per open item, naming the helper. Kinds:
    - Days still to record after a salary was paid ("early" or "already paid", whichever applies).
    - Salary or advance not confirmed.
    - Salary reported not received.
    - Additional salary due.
    - Advance deduction not taken.
    - An ended period nobody paid.
    - An attendance correction reported.
    - Older helper requests.
  - **Links:** each item links to the exact tab / helper / period (Payroll now accepts `?period=<start>_<end>`).
  - **Display:** items are grouped by helper at the top of the bell drawer and of the Notifications page.
  - **Count:** the bell count = these items + unread notifications.
  - **Clearing:** items go away by themselves once handled (derived each time; nothing stored).
- **Buttons (Household screens and dialogs):**
  - **Styles:** primary buttons are solid and bold. Disabled buttons are grey (not just faded). Quiet links are underlined. On phones buttons are 44px tall (40px for compact) with more space between footer buttons. "View details" / "More options" are styled as links.
  - **Pay:** a solid Pay button on each unpaid payroll row opens the pay dialog directly.
  - **Correct payroll:** a visible button on a paid payslip; Delete / Void stay inside ⋯.
  - **Attendance:** "Confirm through today" is the primary button while days up to today are open; the save button reads "Save attendance".
- **Tests:**
  - **Unit:** 1411 pass. New `tests/app/household-nav.test.js` (7): redirect, deep links, sidebar / phone tabs, other workspaces keep / Dashboard, bell count / groups / links, Notifications section. Template validator tests; server bell sentences and links, gone once handled.
  - **Emulator:** not rerun; no rules, payroll or ledger code changed.
- **Staging:**
  - **Browser at 390px / 1280px:** 31/31 on a temporary household (deleted). Checks: lands on Payroll; no Dashboard and no "/" link; the bell count and items by helper; a bell item opens Payroll on that helper's period; solid Pay / Save attendance / Give an advance / + Add staff / + Add member (44px, one line); disabled buttons grey; Correct payroll visible; "Not yet confirmed" shown first; helper portal unchanged.
  - **Real household (read-only):** the bell will show 3 items for Loriza: 8 days of Sep 16–30 still to record (salary already paid), Oct 1–15 salary not confirmed, ₱500 advance (Oct 12) not confirmed.

### 2026-10-17 · Household consolidated UI simplification (f50521f, facdf89)

Items 1–4, 13–19, 29 and 30 of the request were already live (no Dashboard and Payroll as home in 5d27d7a; payslip, corrections, Delete / Void, Users, current staff in earlier batches) and were re-checked. New:

- **Advances (20–28):**
  - **Helper card:** one card per helper is the working area. It shows Outstanding / Available / Next deduction, then [Give advance] (solid) and [⋯ More]. ⋯ More holds Repaid advances, which opens a sheet.
  - **Current advances:** listed right under the figures, each as "₱500 · Oct 12 / ₱500 owed · Deduct ₱500 Nov 1–15" with a status chip (Not confirmed / Confirmed) and its own ⋯.
  - **Removed:** the "Open advances" heading and the page intro.
  - **Voided records:** a quiet link at the page bottom, outside the cards (Payroll too).
- **Attendance (7–12):**
  - **Removed:** the intro text. The work area is now Employee / Period, one summary line ("14 paid days · ₱5,754" plus the helper's confirmation chip), shortcuts, the grid, the status buttons and Save attendance.
  - **Details (folded):** the full breakdown, the confirmation sentence and Paid Leave.
  - **Shortcuts:** Confirm through today comes first and is the primary button while days up to today are open. Fill normal schedule and Copy previous period are quiet.
  - **Legend:** one short line.
- **Payroll home (13):** the period line shows Paid / Still to pay / Prepaid ("in paid", never added on top).
- **Text noise (5, 6):** page intros removed (Payroll, Attendance, Advances, Staff, Notifications); Users keeps "Who can sign in to Luna."
- **Tests:**
  - **Unit:** 1412 pass. Advances card structure (no Open advances, Give advance + ⋯ More, Voided outside the cards), Payroll home figures, updated Attendance.
  - **Browser (temporary household, deleted):** 27/27 at 390px / 1280px. Checks: lands on Payroll, no Dashboard, Payroll figures, the Advances card layout and solid Give advance, ⋯ More → Repaid sheet, Give advance preselected, the quiet Attendance header with Confirm through today first, a solid Save attendance above the tab bar, the payslip status first with Correct payroll visible, a bell item deep link. No sideways scroll and no clipped buttons.
  - **Emulator:** not rerun; no rules, payroll or ledger code changed.

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
| 7 Release gate | done | 709350f, d1d429e | unit 1259; emulator 2934 + re-runs; mutation 34/34 killed |

## Stage 7 log
- Supplier Paid? check: added an optional idempotency key to expense create (709350f); a retry returns the first expense (alreadyRecorded). Paid pre-fills only the unscheduled remaining balance; the server refuses paying beyond the agreed amount (over-agreed).
- Mutation (scratchpad mutate186.cjs, targeted tests, sha256 restore check): 34/34 killed. It found a real bug: the delivery-address history line was duplicated in the edit path and missing from the fulfilled-order correction path (fixed in d1d429e).
- Staging Firestore rules + indexes deployed 2026-10-11 (live rules == source for Firestore and Storage; Storage not redeployed). 8 new guests indexes were building.
- resync-permissions --all: every owner/manager gained attendance.self / advances.self / payroll.self (owner = ALL by design; manager = ALL minus 4). They're inert without member.staffId.
- Budget-total dry run: demo-baby-a 150,000 -> 150,000; demo-bridal-a 500,000 -> 390,000; sample-baby none -> 10,000; veah-bridal none -> none. No tenant has a budget on an inactive category, so the sums of all and of active categories are the same. Apply after the code push.

## Stage 8 log
- S1 0ac1ce4 workspace plans; S2 617258e billing backend; S3 28cd6af tenant Subscription page; S4 1531720 Super Luna screens; S5 e9caf0d layout polish; plus test commits.
- Mutation (scratchpad mutate186b.cjs): 28/28 killed after adding tests for decided-stays-decided, paid-through-never-back, suspension-kept, no-bill-for-suspended and Cancel-confirms-nothing.
- Emulator suite (re-run sequentially after a parallel-run mistake): 2944 tests / 40 files green, including billing races and billing rules.
- Staging 2026-10-11: indexes deployed (rules unchanged); seed-plans --overwrite (6 workspace plans created, Distributor plans tagged with the same prices and limits); adopt-workspace-plans: demo-baby-a / sample-baby -> baby-plus, demo-bridal-a / veah-bridal -> bridal-plus, demo-household-a / rwp-d419 -> household-plus, demo-household-b -> household-basic; Distributor tenants kept their plan and got monthlyAmount recorded. No usage alerts were sent. Fixed: operator warnings listed orders/imports limits for workspaces without those modules.

- Staging deploy 2026-10-11: code 60fca7a -> b09c2d7 (MRR aggregation indexes, found live) -> 9c76ccf (Subscription layout). 125 indexes READY; rules unchanged (live == source).
- Live: billing probe 23/23 (scratchpad probe-p186-billing.mjs, self-cleaning: reverses metrics and restores bank settings); release probe 48/48; live UI 82/82 at 1280 / 820 / 390 (incl. Subscription in all four workspaces). After a UI run as temp owners, run scratchpad clean-temp-bills.mjs (probe bills); counters then equal a recount (11 staging bills, outstanding = MRR ₱8,003).
- Staging now has October 2026 bills for the 11 billable staging businesses (made by the first billing run). Luna's bank settings are still EMPTY on staging: the Owner enters them in Super Luna -> Payments -> Payment settings.

## Phase 18.6 status
Complete on staging, pending the user's review. Do NOT start Phase 19.

## Deferred backlog (recorded 2026-10-11, not started)

Not part of any phase until the user asks for it:
- Automatic overdue / past-due scheduler for Luna subscriptions (today an operator marks a subscription past due).
- Editable plan catalog in Super Luna (plans stay seeded and read-only there).
- A dedicated Super Luna notification inbox (operators see the For Verification count on the Overview).
- Automated Firebase / Google Cloud billing integration.
- Netlify billing API integration.
- Automatic payment gateway / bank reconciliation.
- Production deployment.
- Phase 19.
- Bridal (approved concept, not built): customizable digital wedding invitation + secure per-guest / per-party RSVP links + QR codes. Don't start it during the owner pilot unless the user asks.

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
