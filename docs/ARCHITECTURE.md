# Luna Business Operations Platform — Architecture

Approved 2026-10-07. This is the reference for every build phase. Change it
deliberately, in the same commit as the code that changes the design.

## Principles

1. Security before convenience.
2. Tenant isolation never depends on frontend code.
3. Don't build features that haven't been validated.
4. Business logic lives in reusable, shared code.
5. No Hayst-Kopi-specific (or any single-client) assumptions in shared code.
6. Plans, modules, permissions and limits are configuration, not code.
7. Onboarding a business never needs a new codebase, deployment or Firebase project.
8. Critical writes are validated server-side.
9. Important operational changes are auditable.
10. Build for Client #1 on a foundation that scales to hundreds.

## Stack

- **Frontend:** Vite and plain JavaScript ES modules (no framework). Two entry points:
  - `index.html`: tenant app
  - `console/index.html`: Luna Super Admin
- **Backend:** Netlify Functions behind `/api/*`, bundled with esbuild, using the Firebase Admin SDK.
- **Data:** a single Firebase project for Luna (Auth, Firestore, Storage). It is separate from Hayst Kopi.
- **Shared code:** the `shared/` folder holds pure ESM imported by both the browser and the functions. It is the single definition of permissions, modules, plans, entitlements and subscription policy.

## Environments

| Environment | Firebase project | CLI alias | Firestore | Functions | Data |
|---|---|---|---|---|---|
| Local / emulator | `demo-luna` (offline) | `default` | emulator | `netlify dev` | throwaway |
| **Staging / prototype** | `luna-business-os` | `staging` | `us-east5` (Columbus) | Netlify `cmh` (Ohio) | **fake demo data only** |
| Production | *not created yet* | — | decided at production-readiness review | — | real clients |

- The staging environment must never hold real paying-client data.
- A plain `firebase deploy` targets the offline `demo-luna` project. Cloud deploys must name the alias (`--project staging`). No `prod` alias exists until production is created.
- Before Client #1, a production-readiness review chooses between (A) keeping production in Ohio and (B) a new Singapore production project, with Netlify Pro and functions in `sin`.
- **Portability:** project IDs, URLs, the environment name and credentials all come from environment variables (`.env.example`). Business logic never assumes a region, so moving environments is a configuration change.
- On Netlify's Free plan, environment variables can't be scoped, so server secrets are also visible to the build step. This is acceptable because Vite only bundles `VITE_*` variables. Scope them to functions only once on Pro.

## Tenancy

Every tenant record lives under `businesses/{businessId}/...`. Server code
gets collection references only through a tenant-scoped helper, never raw
`db.collection()` calls. A `businessId` sent by the browser is only a
selector; it is always checked against the caller's membership.

```
plans/{planId}                    editable plan catalog (seeded from shared/plans.seed.js)
users/{uid}                       { defaultBusinessId, businessIds[] }       server-written
platformAudit/{id}                super-admin actions incl. support access to tenant data
businesses/{bid}                  profile, timezone, orderPrefix, subscription{planId,status,...},
                                  moduleOverrides, limitOverrides, entitlements (server snapshot)
  members/{uid}                   { roleTemplate, permissionOverrides, permissions{}, status, isAccountOwner }
    inbox/{id}                    in-app notifications (client may only set readAt)
  products/{id}                   master data + onHand, reserved, available, isLowStock   (inventory.view)
  productCosts/{id}               avgCostUnits, lastReceiptUnitCost, inventoryValue       (inventory.costs)
  skuIndex/{SKU}                  { productId }: per-business SKU uniqueness              (server only)
  inventoryTransactions/{id}      append-only movement log, quantities before/after       (inventory.view)
  inventoryTransactionCosts/{id}  the same movement's costs before/after                  (inventory.costs)
  orders/{id}                     order + line snapshots + statusHistory                (orders.view)
  orderCosts/{id}                 per-line cost consumed, COGS, gross profit            (dashboard.financials + Orders module)
  idempotencyKeys/{key}           create-once guard for orders                          (server only)
  counters/orders-{YYYYMMDD}      per-business, per-local-day order sequence            (server only)
  customers/{id}  payments/{id}  paymentRefs/{method_ref}
  counters/{name}  usage/{YYYY-MM}
  metrics/{YYYY-MM-DD | YYYY-MM | current}           operational counts (dashboard.view)
  financialMetrics/{YYYY-MM-DD | YYYY-MM | current}  money in centavos (dashboard.financials)
  expenses/{id}                   Phase 10 (module registered in Phase 5, not built)
  reports/{id}                    server-generated report snapshots (added Phase 3)
  imports/{id}/rows/{n}  auditLog/{id}  settings/{section}  integrations/{provider}
```

## Session and tenant resolution (Phase 2)

1. The browser signs in with Firebase Auth (email and password) and sends its ID token to `GET /api/session`. Optionally it adds `X-Luna-Business-Id` to choose a business.
2. The server verifies the token, checking for revocation, so a disabled account is refused immediately.
3. The server picks a business:
   - If one was requested, it uses that business only and never falls back to another.
   - Otherwise it uses the user's `defaultBusinessId`, then their other `businessIds`.
4. Access requires an **active** `businesses/{bid}/members/{uid}` document. The `users/{uid}.businessIds` list is only an index and is never trusted on its own. "Not a member" and "no such business" return the same 403, so business IDs can't be discovered by probing.
5. The subscription policy is applied:
   - An unknown status is refused.
   - Suspended accounts are read-only.
   - Cancelled accounts admit the account owner only, with export-only permissions.
6. The server returns the permissions stored on the member record, filtered to known keys set to `true`, plus the entitlements snapshot and usage summary.

Every future endpoint repeats this through `requireTenant(event, { permission, module, write })`, so a browser's earlier session response is never reused for authorization.

## Security rules and tenant isolation (Phases 3-4)

`firestore.rules` and `storage.rules` share one model:

- A browser read is allowed only when `businesses/{bid}/members/{request.auth.uid}` exists with `status == "active"`. The member document's ID must be the caller's uid; a `uid` field inside the data doesn't count. `users/{uid}.businessIds`, custom claims, `roleTemplate`, URLs and headers are never consulted.
- Each collection needs one permission key, which must be `=== true` in the stored `permissions` map. Truthy non-booleans, non-map permission values and unknown keys grant nothing.
- **Phase 4:** module data also needs the module to be switched on in a valid entitlement snapshot, through `canAccessModule(bid, module, permission)`, which requires all of:
  - active membership
  - the subscription policy allowing reads
  - the exact permission
  - a snapshot with `schemaVersion == 1`, computed for the business's current `subscription.planId`, whose plan document still exists, with every module, limit and feature well-formed
  - `modules[module] == true`

  A permission never unlocks a module the business isn't entitled to.
- The subscription rule mirrors `accessPolicy` + `effectivePermissions`:
  - active, past_due and suspended read normally;
  - cancelled lets the `isAccountOwner` member read with the export-only permissions;
  - any other value (missing, unknown, wrong case, non-string) is refused.
- Business IDs must match the `isValidBusinessId` format. This is defense in depth, because the server never creates other IDs.
- There is no browser write anywhere (Firestore or Storage).

| Browser-readable | Module | Permission |
|---|---|---|
| `businesses/{bid}` (get only, no list) | none | active membership |
| `members/{uid}` | users (core) | self, or `users.view` (list needs `users.view`) |
| `products`, `inventoryTransactions` | inventory | `inventory.view` |
| `productCosts`, `inventoryTransactionCosts` | inventory | `inventory.costs` |
| `customers` | customers | `customers.view` |
| `orders` | orders | `orders.view` |
| `payments` | payments | `payments.view` |
| `metrics` | dashboard (core) | `dashboard.view` |
| `financialMetrics` | dashboard (core) | `dashboard.financials` |
| `orderCosts` | dashboard (core), plus the Orders module | `dashboard.financials` |
| `reports` | reports | `reports.view` |
| `settings` | settings (core) | `settings.view` |
| `imports`, `imports/*/rows` | imports | `imports.run` |

This mapping lives in `shared/modules.js` (`collections`, `storage`). The rules keep their own copy, and `tests/shared/rules-registry.test.js` fails if the two drift.

Server-only, never readable from the browser: `users`, `plans`, `platformAudit`, `paymentRefs`, `counters`, `usage`, `auditLog`, `integrations`, `members/*/inbox`, and every collection-group query. The inbox `readAt` write is deferred to Phase 13 (Notifications).

In Storage, `tenants/{bid}/{products|payments|imports|exports}/**` belongs to the inventory, payments, imports and reports modules, and is readable with `inventory.view`, `payments.view`, `imports.run` and `reports.export` respectively. It uses the same membership, subscription and entitlement checks through cross-service Firestore reads. To keep it to two document reads, Storage skips the plan-existence check. Everything else is denied, and there are no browser uploads. Deployed to staging in Phase 8 (bucket in us-west1) and verified live. The cross-service reads need the Firebase Storage service agent to hold `roles/firebaserules.firestoreServiceAgent`; the Firebase CLI deploy does not grant it, so it is a one-time account-side IAM step per project.

The proof is `npm run test:rules`: `tests/rules/` runs on the real emulators with `@firebase/rules-unit-testing`. It runs in CI (`.github/workflows/ci.yml`) and before every `deploy:rules:staging`.

## Identity, roles and permissions

- Firebase Auth uses email and password. The only custom claim is `platformAdmin`, which is set by a CLI script.
- Membership documents are the source of truth for tenant access, so revoking access takes effect immediately.
- **Roles are permission templates only** (`shared/permissions.js`). The initial templates are Owner, Manager / Admin and Staff. Code checks permission keys and never role names. New roles such as Warehouse, Sales or Finance are new template entries.
- `isAccountOwner` on the member record (not the role name) protects the business's owner account from being demoted or removed by other users.
- Super Admin has no access to tenant data through the rules. Support access goes through an audited, time-limited server path.

## Plans, modules, entitlements (Phase 4)

**Access to a module = active membership AND the exact permission AND the module enabled for the business.** This is enforced in three places from one registry:

- Firestore and Storage rules: `canAccessModule`
- the server: `requireTenant` always checks the permission's own module (`PERMISSIONS[key].module`) plus any `module` passed in
- the browser: `canUseModule` drives both navigation and a guard on every navigation. A hidden URL shows a generic "Page not available" that never says why.

**Registry.** `shared/modules.js` lists, for each module:

- `id`, `label`, `path` and `icon`
- the view `permission`
- `available` (built yet) and `core`
- the Firestore `collections` and Storage areas it owns

Dashboard, Users and Settings are core: part of every package, always `true` in the snapshot, and never overridable. They are still checked, so a broken snapshot denies them too.

**Plans** live in Firestore `plans/{planId}`, seeded from `shared/plans.seed.js`. Prices are in centavos:

- Starter: ₱4,990 setup + ₱990/mo
- Growth (recommended): ₱9,990 + ₱1,990/mo
- Pro: ₱19,990+ + ₱2,990+/mo

Every plan is validated by `validatePlan` against `LIMIT_DEFINITIONS` and `FEATURE_DEFINITIONS`. Today all three plans include every built module and differ in limits and features only.

**Effective entitlements** = the plan + per-business `moduleOverrides`, `limitOverrides` and `featureOverrides`, within the business's workspace template (Phase 8.5, see Workspace templates), computed by `computeEntitlements`. Overrides are strict: exact booleans, non-negative integers, values from the feature definitions, and no unknown keys or core modules. The snapshot is stored at `businesses/{bid}.entitlements`:

```
{ schemaVersion: 2, planId, planName,
  workspaceTemplateId, workspaceTemplateVersion,   (Phase 8.5)
  modules  { every MODULE_ID: boolean },
  limits   { users, ordersPerMonth, storageBytes, importsPerMonth: int >= 0 },
  features { reportsLevel, inAppNotifications, pushNotifications, googleSheets,
             advancedPermissions, workflowCustomization, support },
  computedAt }
```

**Fail closed.** `validateEntitlementsSnapshot` on the server and the same checks in the rules reject the snapshot when:

- it is missing
- `schemaVersion` is anything other than 2 (1 only during the Phase 8.5 migration window)
- its workspace template is missing, unknown, not the business's, or not the current version (Phase 8.5)
- it was computed for a different plan than `subscription.planId` (stale)
- the plan document no longer exists
- any module, limit or feature is missing, unknown or mistyped

On the server this returns 503 `business-misconfigured`. In the rules, every module read is denied. Anything that counts members against the user limit also refuses to proceed rather than skipping the limit.

**Changes** go only through operator tooling, which is server-side and never reachable from the browser:

- `assignPlan`, `updateOverrides` and `refreshEntitlements` in `provisioning.js` each validate, recompute the snapshot in one transaction, and write the same audit record to `businesses/{bid}/auditLog` and `platformAudit`. Each change requires a reason.
- The CLI wrappers are `set-plan`, `set-overrides`, `recompute-entitlements` and the read-only `show-entitlements`. Writes need `--confirm <projectId>`.
- A downgrade below the active user count warns and removes nobody. Adding or re-enabling members is blocked until the business is back under the limit.

**Visibility.** `/api/session` returns the plan name, limits and usage only to members with `billing.view`. Everyone gets module switches and feature flags (for navigation). Settings shows the package only to `billing.view` holders.

`GET /api/reports` started as a guard-only endpoint exercising the Reports gate; since Phase 11 it serves the reports (see Reports).

## Subscription states

| Status | Access |
|---|---|
| active | full |
| past_due | full + warning banner (grace period) |
| suspended | read-only |
| cancelled | owner only, export only |
| unknown | deny all |

Data is never deleted automatically because of non-payment.

## Products and inventory (Phase 6)

**Quantities** (`shared/quantity.js`, the only place they're converted):
- Stored as integers with 3 implied decimals (`QTY_SCALE = 1000`), so 12.5 kg is stored as `12500`.
- Each unit has its own precision: pcs, box, case, pack, dozen, set, sack, bottle, roll, g and mL are whole numbers; kg, L and m allow up to 3 decimals.
- Input is parsed from its decimal text, never with floating-point maths. NaN, Infinity, exponents, signs and too many decimals are rejected.
- The maximum is 10^9 units.

**Money** is integer centavos.

**Average cost** is stored in *cost units* (centavos × 10,000 per whole unit) so repeated receipts don't drift. ₱53.333333 is stored as `53333333`. Intermediate products use BigInt, and results round half-up.

**Moving weighted average (perpetual).** On a receipt:

  newAvg = (onHand × avg + received × unitCost) / (onHand + received)

For example, 100 @ ₱50 + 50 @ ₱60 = 150 @ 53,333,333 cost units = ₱53.33.

| Movement | On hand | Reserved | Average cost |
|---|---|---|---|
| opening | set (only before any movement) | — | set to the unit cost |
| receipt | + | — | recomputed |
| adjustment_increase | + | — | unchanged; refused if the product has no cost yet |
| adjustment_decrease | − (can't cut into reserved) | — | unchanged |
| reservation (Phase 7) | — | + (≤ available) | unchanged |
| release (Phase 7) | — | − (≥ 0) | unchanged |
| fulfillment (Phase 7) | − | − | unchanged; returns the cost consumed |

- **No overselling:** there's no backorder policy yet.
- **Low stock** = `active && available ≤ reorderLevel`, stored as `isLowStock` on every change. It uses available rather than on hand because reserved stock can't fill another order.

**COGS snapshot.** `costOfQuantity(qty, avg)` is what Phase 7 stores on the order line at fulfillment. The same amount goes into `financialMetrics.cogs`. A later cost change can't reach it.

**Inventory value** = on hand × moving average. It's an operational estimate, not a statutory valuation. It is stored per product (`productCosts.inventoryValue`); the business total is a `sum()` aggregation, not a gauge, because a gauge would be a business-wide write hot spot.

**Writes, server only** (`netlify/functions/_lib/inventory.js`). Every change is a Firestore transaction (`maxAttempts: 10`) that reads the product and its cost document, plans with `planMovement`, and writes:
- the product balances and the cost document
- one `inventoryTransactions` and one `inventoryTransactionCosts` record. Each holds before and after values for on hand, reserved, available, average cost and value, plus the unit cost, cost consumed, reason, note, reference, actor and timestamp, and `seq` (the product's movement number).
- `metrics/current.lowStockProducts` (±1), only when a product's `isLowStock` flips

`prepareMovements(tx, …)` + `commit()` let Phase 7 move several products inside one order transaction: all reads first, all checks before any write.

**SKU uniqueness.** SKUs are unique per business and case-insensitive (normalized to upper case). The same SKU may exist in another business. The `skuIndex/{SKU}` document is created with `tx.create` in the product's transaction, so two simultaneous creates can't both win.

**Product lifecycle.**
- Create, update and activate/deactivate are audited in `auditLog`.
- Delete is allowed only when the product has no movements and no stock.
- The unit locks after the first movement.
- A product with reservations can't be deactivated.
- Editing never rewrites history: the log keeps the SKU and name as they were.

**Endpoints.**
- `POST /api/products` (`products.manage`): create, update, setStatus, delete.
- `POST /api/inventory`: receipt (`inventory.receive`), and opening, adjustment_increase and adjustment_decrease (`inventory.adjust`).

Each checks sign-in, membership, permission, the Inventory module, subscription write access and a strict payload. Balances, costs and unknown fields are refused. Authentication runs before any body validation.

**Permissions.**
- New: `inventory.receive` and `inventory.costs`.
- Owner and Manager templates have all inventory permissions. Staff keeps `inventory.view` only, so staff see quantities, never cost.
- Costs live in separate documents because rules can't hide fields (the same pattern as `financialMetrics`).

**Screen** (`src/modules/inventory/`):
- Firestore Lite queries: 25 per page, cursor on (nameLower, id).
- Filters: status, low stock, name prefix or exact SKU.
- Cost columns and the cost side of history appear only with `inventory.costs`.
- History is paginated 20 at a time, newest first.

**Dashboard.** Low stock (the gauge) and the low-stock list (`isLowStock == true`, limit 5) are live. Sales, profit, COGS, payments and orders stay "No data yet".

**Indexes** (`firestore.indexes.json`): products (status, nameLower), (status, isLowStock, nameLower), (status, categoryLower, nameLower); inventoryTransactions (productId, seq desc).

## Orders (Phase 7)

**Operational sales-recognition policy.** This is Luna's reporting rule, not statutory revenue recognition.

| Event | Inventory | Metrics |
|---|---|---|
| Created (pending) | reserve every line (all or nothing) | `metrics/{created day}.orderCount` +1, `usage/{month}.ordersCreated` +1, pending +1, unpaid +1, receivables += total. **No sales, no COGS.** |
| Fulfilled | consume stock (on hand −, reserved −), snapshot the cost consumed per line | on the business-local **fulfilment** day: `grossSales` += subtotal, `discounts` += discount, `cogs` += the snapshotted cost, `fulfilledOrders` +1, pending −1 |
| Cancelled (pending only) | release every reservation | `cancelledOrders` +1 on the cancel day; pending −1, unpaid −1, receivables −= balance. Created and usage counts stay. **No sales, no COGS.** |

- A fulfilled order can't be cancelled; reversals will be handled by Returns.
- Fulfilment is not payment: a fulfilled order stays unpaid until its payments are recorded (Phase 8).
- An order created yesterday and fulfilled today counts toward today's sales.

**Model** (`orders/{id}`, `shared/orders.js`):
- Identity: `orderNumber`, `orderDate` (business-local creation day), `source` (+ `sourceNote`, required for Other).
- Customer: `customer {name, phone, notes}` snapshot and `customerId` (null for a walk-in; linked to a saved customer since Phase 9).
- Lines: `items[] {lineId, productId, sku, name, unit, quantity, unitPrice, lineSubtotal}`, a snapshot taken from the product inside the create transaction.
- Money: `subtotal`, `discount`, `total`, `amountPaid` (0), `balance`, `paymentStatus` (unpaid).
- Status: `fulfillmentStatus` (pending, fulfilled or cancelled) and `statusHistory[]` (created, edited with changes, fulfilled, cancelled with reason; actor and time on each).
- Bookkeeping: `revision`, `idempotencyKey`, and created/updated/fulfilled/cancelled by and at, plus `cancellationReason`.

**Trust.**
- **What the browser sends:** product IDs and scaled quantities, customer, source, notes, the discount and an idempotency key.
- **What the server does:** re-reads every product in the transaction, prices each line with `lineAmount` (the product's selling price), and totals with `computeTotals` (subtotal − discount ≥ 0).
- **What's refused:** prices, names, costs, totals, stock and payment fields.

**Edits** (pending only, `orders.update`, optional `expectedRevision`):
- Only the reservation difference moves: 20 → 15 releases 5, and 20 → 30 must reserve 10 more or the whole edit fails.
- Existing lines keep their price snapshot; new products use the current price. Explicit repricing isn't supported yet.
- Changing the discount needs `orders.discount`.

**Discounts:** one order-level discount in integer centavos, at most the subtotal. It needs the new `orders.discount` permission, which Owner and Manager templates have and Staff doesn't.

**Numbering:** `PREFIX-YYYYMMDD-###` from `counters/orders-{YYYYMMDD}` in the same transaction, using the business-local date. The prefix is `businesses/{bid}.orderPrefix` (2–6 letters or digits), defaulting to `ORD`.

**Idempotency:** `idempotencyKeys/{key}` is created in the create transaction and stores `{orderId, requestHash, uid}`.
- The same key with the same request returns the original order.
- The same key with a different request returns 409.
- When identical requests race, the loser gets ALREADY_EXISTS, which the service turns into a replay.

**Plan limit:** `usage/{YYYY-MM}.ordersCreated` is read and incremented inside the create transaction against the validated `entitlements.limits.ordersPerMonth` (so overrides apply). Cancelling doesn't decrement it.

**COGS:** fulfilment uses the Phase 6 `fulfillment` movement and its `costConsumed`. The result is stored once in `orderCosts/{id}` and added to `financialMetrics.cogs`; it's never recomputed.

**Endpoint:** `POST /api/orders` with these actions: create (`orders.create`), update (`orders.update`), fulfill (`orders.fulfill`, new; Staff has it) and cancel (`orders.cancel`).
- It checks sign-in (first), the Orders and Inventory modules, write access and a strict payload.
- The fulfil response includes COGS and profit only for `dashboard.financials`.

**Screen:**
- 25 newest per page, filtered by fulfilment, payment, source and date, each with its own `(field, createdAt desc)` index.
- New and edit dialog with product search, availability, a live preview of totals, and one idempotency key per dialog.
- Detail view with history; COGS and gross profit appear only for `dashboard.financials`.

**Dashboard:** orders today, unpaid orders, for fulfilment, unpaid balance, net sales and gross profit are live, and recent orders is a live list. Since Phase 8, paid today is live too, and since Phase 10 operating expenses and estimated operating profit (`LIVE_DATA_SOURCES`).

**Corrections and accidental orders (Phase 7.1).** Users see a single **Edit → Save** for every order; the server decides what Save means:
- **Open orders:** pending now, and preparing/ready later, since `FULFILLMENT_STATUSES[...].open` covers them. This is the existing edit path (`orders.update`).
- **Fulfilled orders:** a correction, which needs the new `orders.correct` permission (Owner and Manager templates; not Staff). A reason is required only when quantities, products or the discount change.
  - Units removed or reduced come back through a `correction_in` movement at the line's **original cost snapshot**, so COGS falls by exactly what was booked, even if the product's average cost has moved since. The returned units enter the moving average at that cost.
  - Units added or increased leave stock through a `correction_out` movement at today's average.
  - Line prices keep their snapshot; added products use today's price.
  - The changes in sales, discount and COGS post to the order's **original fulfilment day** (and its month), so that day's figures become correct.
  - History is appended, never rewritten. The order's `statusHistory` gets a `corrected` entry (who, when, reason, quantity before → after, the inventory effect, sales before → after; no cost figures, since Staff can read it). `orderCosts.corrections` records COGS and net sales before → after for financial users.
  - The original fulfilment and inventory movements stay as they were.
- **Cancelled orders:** not editable.
- **Delete** (in ⋯ More, needs `orders.cancel`): only for open, unpaid, never-fulfilled orders. It releases reservations, removes the order from its day's `orderCount` and from the open/unpaid exposure, and writes an `auditLog` entry (`order.deleted`) with a full snapshot. Plan usage keeps counting it. Fulfilled orders can never be deleted.
- **Corrections are not returns.** A correction is for "we typed 10, it was 8". "Received 10, returned 2" belongs to the future Returns module.
- **Screen:** cancel and delete live under ⋯ More. The activity log reads "time • person • Qty changed 10 → 8", followed by "Inventory corrected +2" and "Sales adjusted ₱750.00 → ₱600.00".

**Scale note:** the counter, usage and `metrics/current` documents are shared by every order in a business. That's fine for SMB volumes; sharding is needed if a tenant sustains more than about one order per second.

**Fulfilment stages (Phase 8).** The Fulfillment ▾ dropdown offers Pending, Preparing, Ready, Fulfilled and Cancelled.
- Moving between the open stages (pending, preparing, ready) is the `stage` action (`orders.fulfill`). It only adds a history entry and touches no stock or metrics.
- Fulfilled always goes through the protected fulfil engine, and Cancelled through the protected cancel (reason required).

## Payments (Phase 8)

**Payment and fulfilment are separate.** An order has two independent states: Payment (Unpaid / For Verification / Partially Paid / Paid) and Fulfilment. Payments never create sales or COGS; those are still recognised at fulfilment only.

**One order, many payments** (`payments/{id}`, `shared/payments.js`): `orderId`, `orderNumber`, `customerName`, `amount` (centavos), `method`, `reference` (normalized), `referenceKey`, `note`, `proof {path, contentType, size}`, `state` (for_verification, verified or voided), `receivedDay`, `history[]`, `revision`, and created/updated/verified/voided by and at.

**The order carries only derived totals,** written in the same transaction as the payment: `verifiedPaid`, `pendingPaid`, `amountPaid` (= verified + pending), `balance` (= total − amountPaid), `paymentStatus`, `paymentCount`, `lastPaymentRef` and `lastProofPaymentId`. `amountPaid` is never set on its own. `paymentStatus` is derived on the server (`derivePaymentStatus`):

| Condition | Status |
|---|---|
| nothing paid | Unpaid |
| any payment awaiting verification | For Verification |
| verified total < order total | Partially Paid |
| verified total = order total | Paid |

**Rules of a payment:**
- **Methods:** Cash, GCash, Maya, Bank Transfer, COD and Other. GCash, Maya and Bank Transfer need a reference; Cash and COD don't.
- **No overpayment:** live payments can never add up to more than the order total. Order corrections that would bring the total below what's been paid are refused (`below-paid`).
- **Cancelled orders take no payments.** An order with live payments can't be cancelled or deleted; remove the payments first.
- **Who verifies:** a payment from someone with `payments.verify` (Owner and Manager) is verified at once. A payment from someone with only `payments.record` (Staff) waits For Verification until a verifier marks it verified.

**References and duplicates.**
- References are normalized on the server: uppercase, with spaces and `- _ . / #` removed, 4–40 letters or digits. "abc-123" and "ABC 123" are the same reference.
- `paymentRefs/{method_REFERENCE}` is a per-tenant uniqueness index. It's checked and created in the payment transaction, and `tx.create` fails if the entry already exists, so two simultaneous submissions can't both win. A second use gets "This payment reference has already been used."
- The index is scoped to the business, so the same reference in another business is allowed, and a duplicate check never reveals anything about other tenants.
- Removing a payment frees its reference; editing a reference moves the index entry.
- `paymentRefs` is server-only (no rule).

**Screenshots (proof of payment).**
- Path: `tenants/{bid}/payments/proofs/{orderId}/{paymentId}-{random}.{ext}`, written only by the server through the Admin SDK. No download token is created, so there is no public URL.
- The server checks: the caller's business, `payments.record`, a JPEG, PNG or WebP type found by its magic bytes (not the declared type), and at most 2.5 MB. The browser first shrinks the image (longest side 1600 px, JPEG).
- If the payment fails, the uploaded file is deleted.
- **View screenshot** calls `POST /api/payments {action: "proof"}` (`payments.view`). The server loads the payment from the caller's own tenant, checks the stored path is under that tenant's prefix, and returns the bytes. They're shown in place as a `data:` image.
- `storage.rules` also allows reading the payments area with `payments.view` in the same business. Writes from the browser are denied.

**Corrections, verification and removal** (`payments.verify`):
- **Edit → Save** changes amount, method, reference, note or screenshot. The order's totals and the day's `paymentsReceived` move by the difference. The activity log shows "Reference changed X → Y" and "Payment amount changed ₱a → ₱b".
- **Mark verified** moves the amount from pending to verified.
- **⋯ More → Remove payment** (reason required): the payment becomes `voided`, stays in history, stops counting, and its reference is freed.

**Metrics:**
- `financialMetrics/{day,month}.paymentsReceived` counts the payment's received day, adjusted by edits and removals. This is "Paid today", and "Payments received" for the day and month.
- `financialMetrics/current.receivablesOutstanding` is the unpaid balance.
- `metrics/current.unpaidOrders` counts open-balance orders and changes only when a balance appears or disappears.
- Sales and COGS are untouched.

**Endpoint:** `POST /api/payments` with these actions:
- `record` (`payments.record`)
- `update`, `verify` and `void` (`payments.verify`)
- `proof` (`payments.view`, read-only, so it works while suspended)

It checks sign-in first, then the Payments and Orders modules and a strict payload (max 4.5 MB). Errors are explicit: `duplicate-reference` and `overpayment` are 409, `proof-too-large` is 413.

**Screens:**
- **Orders row:** `Order # | Time | Customer | Items | Total | Reference | Proof | Payment ▾ | Fulfillment ▾ | View details`. Picking Paid or Partially Paid opens one small popover (method, amount defaulting to the balance, reference, screenshot); Save returns to the list. Paid on a For Verification order verifies it. Without the permission, the cells are read-only badges.
- **Payments page:** `Date/Time | Order # | Customer | Amount | Method | Reference | Proof | Status | View`, 25 per page, filterable by status and method (indexes `(state, createdAt desc)` and `(method, createdAt desc)`; an order's payments use `(orderId, createdAt asc)`).

**Not built (by design):** OCR, automatic verification, bank or e-wallet APIs, refunds, returns, customer credit, reconciliation.

## Workspace templates (Phase 8.5)

**Model.** Luna Core → Workspace Template → Enabled Modules → Tenant Configuration. One codebase, one auth system, one tenant and security model, one permission model, one subscription and entitlement system, one design system. Luna is not a no-code builder: templates are data that Luna controls, and tenants can't supply code, HTML, CSS, collection names or routes.

**Template vs plan.** These are independent dimensions:
- `businesses/{bid}.workspaceTemplateId` says what kind of workspace the business runs.
- `subscription.planId` sets price, limits and plan features.

There are no combined ids such as `distributor-growth`. Every plan works with every template, and Starter/Growth/Pro prices and limits are unchanged.

**Registry** (`shared/workspaces.js`, frozen and versioned). Each template defines:

| Field | Meaning |
|---|---|
| `id`, `version`, `name`, `description`, `status` | stable id; integer version; `live` or `planned` |
| `modules` | the **operational** modules the template allows: registered and built, using existing module ids (core included). This is a ceiling. |
| `navigation` | module ids in display order |
| `dashboard.widgets`, `dashboard.empty` | registered widget ids in order, and the empty state |
| `labels.modules` | plain-text display names (for example `expenses` → "Wedding Expenses"). Ids, permission keys and rules never depend on labels. |
| `settings` | default workspace settings (plain values) |
| `plannedModules` | roadmap metadata only: never a route, a permission, an entitlement or a navigation item. An entry is either a registered module that isn't built yet (for example `customers`) or a future capability id (for example `wedding-tasks`). |

`validateWorkspaceTemplate` (run by the tests) rejects:
- unknown keys, modules or widgets
- an unbuilt module listed as operational
- a built module still listed as planned
- widgets needing a module the template neither allows nor plans
- unsafe labels (markup, over 40 characters) and non-plain settings

| Template | Status | Allows (besides Dashboard, Users, Settings) | Planned (metadata only) |
|---|---|---|---|
| `distributor` (v4) | live | orders, payments, inventory, customers (Phase 9), expenses (Phase 10, "Operating Expenses"), reports (Phase 11) | imports, suppliers, production, returns, notifications |
| `household-payroll` | planned | — | household staff, payroll, salary payments, receipt confirmation, advances, deductions, payroll history, reports |
| `baby-expense` | planned | — | expenses ("Baby Expenses"), budget, categories, providers, payments, due dates, milestones, reports |
| `bridal-expense` | planned | — | expenses ("Wedding Expenses"), budget, suppliers, supplier payments and balances, payment due dates, wedding tasks, guests, RSVP, reports |

**Effective modules** (`computeEntitlements(plan, overrides, workspaceTemplateId)`, which has no default template):

- Core modules are always on.
- Any other module must be **built** (`available` in `shared/modules.js`) and allowed by the template (a hard ceiling). It is then the operator override if one is set, otherwise the plan default.
- An override may switch a module off. It may also grant a plan add-on, a Phase 4 behaviour that is kept, but only within the template.
- An override for a module the template doesn't allow is refused, never silently dropped. That includes every unbuilt or unknown module.
- **An unbuilt module is always `false` in a snapshot.** The validator and both rule sets reject any snapshot that says otherwise. Since the Phase 8.5 cleanup, the operational set is Dashboard, Orders, Payments, Inventory, Users and Settings; the Customers, Reports and Imports placeholders left the navigation until each is built.

**Activating a module** (for example Customers in Phase 9) is always explicit:
1. Build it and mark it `available` in `shared/modules.js`.
2. Move it from `plannedModules` to `modules` (and `navigation`) in each template that should get it, and bump those templates' `version`.
3. Update the rules' copies; the drift test enforces this.
4. Roll out: deploy rules and code that accept both versions, run `recompute-entitlements --all`, then drop the old version.

Shipping module code alone activates nothing: stored snapshots hold `false` for unbuilt modules, and the registry tests fail if a built module is still planned.

The Distributor dashboard keeps its Operating expenses and Estimated operating profit cards as "No data yet". A widget may depend on a module the template *plans*, without that module being enabled.

**Snapshot schemaVersion 2** adds `workspaceTemplateId` and `workspaceTemplateVersion`. It is rejected (server 503 `business-misconfigured`, rules deny) when:
- the template is missing, malformed or unknown
- it differs from the business's `workspaceTemplateId` (the template changed without a recompute)
- its version isn't the registry's current version (stale)
- it has a module on that the template doesn't allow

Module access also re-checks the template in `isModuleEnabled` (server and browser) and in `moduleEnabled` / `canAccessModule` (Firestore and Storage rules). A forged snapshot can't carry Orders into a bridal workspace. The rules keep a copy of each template's version and allowed modules, which `tests/shared/rules-registry.test.js` compares with the registry. No extra document reads were added anywhere.

**Access** = active membership AND exact permission AND valid subscription AND plan entitlement AND the workspace allows the module AND no disabling override. A permission never implies a module (Orders permission + bridal workspace = no Orders), and a module never implies a permission (Staff still lacks `inventory.adjust`). Owner, Manager and Staff behave exactly as before.

**Browser.**
- Navigation follows the template's order and labels; Distributor's is unchanged.
- A disabled route shows the generic "Page not available" and never loads the module or its data.
- The dashboard asks the template which widgets exist. A non-Distributor workspace lists none, so no metric document or list is fetched, and it shows the template's own empty state ("Your wedding workspace is being prepared"). Nothing fabricates a 0.

**Operator tooling** (server-side; nothing customer-facing):
- `create-business --template <id>` (required).
- `set-template --business --template --reason [--change-template]`. Assigning a first template needs a reason. Changing one also needs `--change-template`; modules the new template doesn't allow switch off, data is kept, and overrides the new template doesn't allow are refused until cleared.
- `migrate-workspaces` (one-off).

Every assignment or change runs through `changeEntitlements`: one transaction that recomputes the snapshot and writes an append-only audit record to the tenant `auditLog` and `platformAudit`. The record holds the type (`workspace.template-assigned` / `workspace.template-changed`), a summary such as "Workspace template changed: distributor → bridal-expense", the actor, the time, the reason, and before/after values.

**Zero-downtime rollout (staging).** The Phase 5 outage happened because snapshots became invalid before everything accepted them. Phase 8.5 used three steps:
1. **Compatible:**
   - Rules first, then code.
   - Both accept the old `schemaVersion 1` (no workspace; read as distributor) and the new 2.
   - `LEGACY_SNAPSHOTS_ACCEPTED = true`.
2. **Migrate:** `migrate-workspaces --template distributor` gives every business an explicit template and a v2 snapshot, then re-validates them all.
3. **Enforce:**
   - `LEGACY_SNAPSHOTS_ACCEPTED = false`, and the rules' legacy branch is removed (rules first, then code).
   - From then on a missing template fails closed; there is no permanent "missing = distributor".

Future template changes follow the same order: deploy rules and code that accept the new version, run `recompute-entitlements --all`, then remove the old version.

**Reuse infrastructure, not business meaning.** These are shared:
- auth, tenancy, permissions and entitlements
- audit logs, file storage and attachments
- compact tables, modals, pagination, dates
- notifications and exports

Domain records stay separate wherever their behaviour differs:
- A wedding guest is not a Customer.
- A wedding task is not an Order.
- A salary payment is not an Order Payment.
- Salary receipt confirmation is not payment verification.

The Phase 8 Payments module stays an **order-payment** domain: it depends on order totals, balances, the order lifecycle and unpaid-order metrics, so no other template enables it. A shared payment primitive can be extracted later if several domains prove they need the same one.

**Future domain notes** (design room only; nothing is built):

- **Household / Kasambahay payroll.**
  - Three distinct facts, never merged: *payroll calculated* → *payment released* → *employee confirmed receipt*.
  - Example: "Maria Santos · Oct 1–15 · Net ₱7,500 · Released Oct 15 6:15 PM · Confirmed Oct 15 6:18 PM".
  - A confirmation record needs room for: payroll/payment id, employee id, amount acknowledged, release date, confirmation status, confirmed at, method, actor, notes, and immutable history.
  - The confirmation must be attributable to the employee. Possible methods: tap to confirm, secure link, PIN, signature. A manual owner acknowledgement is allowed only as an exception, with a reason. The method is not decided yet.
  - Possible states: not released / released, awaiting confirmation / confirmed received. Labels are not locked.
- **Baby expense tracker.**
  - A budget-and-expense workspace: budget, spent, remaining, upcoming payments, by category.
  - It reuses the `expenses` module id, labelled "Baby Expenses".
- **Bridal / wedding command center.**
  - Budget, suppliers, supplier payments and balances, due dates, tasks, guests and RSVP; later perhaps seating, timeline and contracts.
  - **Tasks:** title, category, due date, priority, status, assignee, notes, related supplier, completion date. Categories are tenant data, not hard-coded.
  - **Guests:** guest or household, group/side, contact, invitation status, RSVP status, party size, confirmed count, notes, table later, sent and RSVP dates.
  - Statuses use stable internal ids (`invited`, `attending`, `declined`, `awaiting`) with configurable display labels; no logic depends on display text.
  - Compact row: Guest | Group | Invited | Party Size | RSVP | Confirmed | Table | View.

**Cleanup rollout (staging).** It used the same staged pattern as the main 8.5 rollout:
- **A, tolerant:** rules, then code (`c0e3024`). Old snapshots holding `true` for an unbuilt module were still accepted.
- **B:** `recompute-entitlements --all`.
- **C, strict:** unbuilt modules must be `false`, enforced in the validator and in both rule sets.

**Not built in 8.5:** payroll, employees, release or confirmation flows, baby or bridal screens, suppliers, tasks, guests, RSVP, seating, generic contacts, accounting, payments, custom fields, tables or forms, page or workflow builders, custom code or themes, tenant label overrides (`isSafeLabel` exists for when they come), and Customers (Phase 9).

## Customers (Phase 9, Distributor)

**A Distributor customer** is a store, reseller or regular buyer the business sells to. It is deliberately not a generic people or contacts engine. Wedding guests, wedding suppliers, household staff and baby-related providers will be their own domain records in their own workspaces.

**Model** (`customers/{id}`, `shared/customers.js`):
- Contact: `name` (required), `company`, `phone` (+ `phoneKey`), `email`, `address`, `notes`, `status` (active / inactive).
- `stats` written only by the server: `orderCount`, `totalOrdered`, `outstandingBalance`, `lastOrderAt`, `lastOrderNumber`.
- `history[]`, `revision`, and created/updated by and at.
- No credit terms yet; they can be added later without changing the order link.

**Contact changes** (`POST /api/customers`, `customers.manage`):
- Actions: `create`, `update` (Edit → Save, only the fields sent, optional `expectedRevision`), `setStatus`, and `delete`.
- Delete works only for a customer **no order has ever referenced** (a mistaken entry); anyone with order history is deactivated instead. Deletes write an `auditLog` snapshot.
- A second customer with the same phone (`+63 917…` = `0917…`) gets a "possible duplicate" hint, never a block, because shops and households share numbers.
- The activity log reads "time • person • Phone changed A → B".

**The order link:**
- An order either links a saved customer (`customerId`) or stays a walk-in name, as before.
- When linked, the server reads the customer inside the order transaction and copies its name and phone into the order's own snapshot. Later contact edits never rewrite past orders, and a typed or forged name is ignored.
- Linking or changing a link needs the Customers module and `customers.view`. Keeping an existing link doesn't.
- An inactive customer can't be linked to a new order. Orders already linked to them stay editable.
- Moving an order to another customer, or unlinking it, is part of the normal Edit → Save (and of Phase 7.1 corrections).

**Statistics move in the same transaction as the business event:**

| Event | orderCount | totalOrdered | outstandingBalance |
|---|---|---|---|
| order created (linked) | +1 | + total | + total |
| order edited / corrected | — | + total change | + balance change |
| order moved A → B | A −1, B +1 | A − old, B + new | A − old balance, B + new balance |
| payment recorded / edited / removed | — | — | follows the order balance |
| order cancelled or deleted | −1 | − total | − balance |

So a customer's `outstandingBalance` always equals the sum of its non-cancelled orders' balances. The unit and emulator race tests assert exactly that after every interleaving. Updates are `FieldValue.increment`s on one document per customer, so no read is added to payments.

**Reads** come straight from Firestore under the rules:
- `customers` with `customers.view` (Customers module on).
- A customer's order history (`orders` where `customerId ==`, newest 25) also needs `orders.view`.
- Indexes: `customers (status, nameLower)` and `orders (customerId, createdAt desc)`.

**Screens:**
- **Customers page:** `Customer | Company | Phone | Orders | Total ordered | Balance | Last order | Status | View details`, 25 per page, search by name, filter Active/Inactive. View details shows contact, stats, order history and activity; the footer has ⋯ More (Deactivate/Reactivate, Delete when never ordered), Edit and Close.
- **Order editor:** "Find saved customer" → Use (name and phone lock to the record, "Unlink" returns to walk-in). Without `customers.view` it's walk-in only.

**Activation** (the Phase 8.5 procedure, first real use):
1. Customers marked `available`.
2. The Distributor template went v1 → v2 with `customers` in `modules` and `navigation`, and `upgradingFrom: [1]` during the window.
3. The rules accepted versions [1, 2].
4. `recompute-entitlements --all` ran, then strict: `upgradingFrom` emptied and the rules accept [2] only.

Old v1 snapshots never enabled Customers by themselves.

## Dashboard and metrics (Phase 5)

**Summary documents, not scans.** The dashboard never downloads orders, payments, inventory or expenses to add them up. It reads a few tenant-scoped summary documents, which server functions update with `FieldValue.increment` inside the same transaction as the business event (`netlify/functions/_lib/metrics.js`):

| Document | Holds | Read permission |
|---|---|---|
| `metrics/{YYYY-MM-DD}` | operational flows for one business-local day: `orderCount`, `fulfilledOrders`, `cancelledOrders` | `dashboard.view` |
| `financialMetrics/{YYYY-MM-DD}` | money flows in centavos: `grossSales`, `discounts`, `returns`, `cogs`, `operatingExpenses`, `paymentsReceived` | `dashboard.financials` |
| `metrics/{YYYY-MM}`, `financialMetrics/{YYYY-MM}` | the same flows rolled up per month (written in the same transaction) | as above |
| `metrics/current` | gauges: `pendingFulfillment`, `unpaidOrders`, `lowStockProducts` | `dashboard.view` |
| `financialMetrics/current` | gauge: `receivablesOutstanding` | `dashboard.financials` |

- **Two collections:** Firestore rules secure whole documents, not fields. Putting money in its own collection is the only way to show staff the order counts without the profit.
- **What's stored:** only components. Derived figures are computed by `shared/finance.js`, so they can't disagree with their inputs.
- **Writer guarantees:** every write sets all counters, so a document never has a partial set. Unknown fields or non-integer deltas fail the transaction.
- **Schema:** field definitions live in `shared/metrics.js` (`schemaVersion: 1`).

**Financial definitions** (`shared/finance.js`, the only place they exist):

- Net Sales = Gross Sales − Discounts − Returns/Refunds
- Gross Profit = Net Sales − COGS
- Estimated Operating Profit = Gross Profit − Operating Expenses

A figure is `null` ("No data yet") when any input is missing or not an integer. It is never treated as 0. The last figure is called **Estimated Operating Profit**, never net income or net profit, and carries a note that it may exclude taxes, depreciation, financing costs and other accounting adjustments.

**Sales recognition is not decided yet.** Whether a sale counts when the order is created, confirmed, fulfilled or paid is decided with the Orders lifecycle in Phase 7. The writer takes the recognition instant from its caller; the dashboard doesn't care which event it is.

**COGS (decision).** Each sale records the unit cost in force at that moment on the order line (`unitCostAtSale`) and on its `inventoryTransactions` record. The same snapshotted amount is added to `financialMetrics.cogs`. Historical profit is never recomputed from a product's current cost, so a cost change from ₱50 to ₱60 never changes last month's profit. The cost method is proposed for Phase 6: weighted average cost on the product, updated on receipts.

**Business-local dates.** `businessDate(timezone, instant)` uses the business's IANA timezone through `Intl`, so 00:30 Manila time counts toward that Manila date. An invalid timezone throws instead of guessing UTC. Manila is only the default for new businesses.

**Ranges.** `resolveRange` covers today (the default), yesterday, this week (starting Monday, configurable), this month, and custom ranges of up to 366 days. `metricDocIdsForRange` returns the fewest documents: whole months as rollups, the remaining days individually. A year is 12 reads.

**Visibility.** `shared/dashboard.js` lists every widget with its source document, permission and the modules it depends on. A widget shows when the member holds its permission and the business is entitled to all its modules. A module that is entitled but not built yet shows "No data yet".

| Permission | Who has it by default | Widgets |
|---|---|---|
| `dashboard.view` | everyone | operations: orders today, unpaid orders, for fulfillment/delivery, low stock |
| `dashboard.financials` | Owner and Manager templates; not Staff | sales and profit: today's sales, gross profit, operating expenses, estimated operating profit, paid today, unpaid balance |

`dashboard.financials` can be granted to or revoked from any member individually.

**Reads per dashboard load.**

- **Owner:** at most 4 documents (`metrics/{today}`, `metrics/current`, `financialMetrics/{today}`, `financialMetrics/current`).
- **Staff:** 2 documents.

The reads use Firestore Lite (one-shot over REST, about 32 KB gzipped, measured).

**Cost.** The rules' membership, business and plan lookups are billed too, so one dashboard load costs about 4 billed reads per document, roughly 16 for an owner and 8 for staff. Plus the `/api/session` call.

**Lists.** Recent orders (`orders` ordered by `createdAt`, limit 5), low-stock products (`isLowStock == true`, limit 5) and recent activity stay empty states with no queries until their phases set `ready: true`.

## Expenses (Phase 10)

Expenses exist so an owner can answer "Magkano talaga kinita namin?". This is a simple operating-expense tracker, not accounting software. There are no payables, ledger, chart of accounts, tax or VAT, no recurring generation, no reconciliation, and no receipts yet.

**Record** at `expenses/{id}` (`shared/expenses.js`):
- `date`: business-local `YYYY-MM-DD`, and `month`.
- `category`: a stable id from `DEFAULT_EXPENSE_CATEGORIES` (Rent, Utilities, Transportation / Delivery, Salaries / Labor, Marketing / Advertising, Supplies, Packaging, Repairs / Maintenance, Fees, Miscellaneous). A tenant-defined list can come later under the same stable-id rule, with no migration.
- `amount`: integer centavos, > 0, at most ₱100M per expense.
- `payee` (+ `payeeLower`), `method` (Cash, GCash, Maya, Bank Transfer, Card, Other), `reference`, `notes`.
- `recurring`: a yes/no flag only.
- `status`: active or removed; plus `history[]`, `revision`, and created/updated/removed by and at.

There is no customer link and no template-specific fields.

**References:** there is no uniqueness rule. An expense is not an order payment, and the Phase 8 order-payment service is not used.

**Recognition:** the amount is an **Operating Expense on its business-local date**, with no accrual. Future dates are refused; back-dated expenses are allowed and land on their own day and month.

**Every write is one transaction:**

| Action | Operating Expenses metrics |
|---|---|
| create | + amount on its day and month |
| edit amount | + (new − old) on its day and month |
| edit date | − old on the old day and month, + new on the new day and month |
| edit category, payee, method, reference or notes | no change |
| remove (⋯ More, reason required) | − amount; the record stays with `status: removed` |

The metrics are `FieldValue.increment` writes to `financialMetrics/{day}` and `/{month}`, with no read. Expenses on different days never contend, and there's no business-wide hot document. Sales, COGS, payments, inventory and customers are never touched.

The activity log reads "Added Packaging expense ₱2,000", "Amount changed ₱2,000 → ₱1,500", "Category changed Packaging → Supplies" and "Removed expense ₱2,000 · Reason: Duplicate entry".

**Dashboard:** `LIVE_DATA_SOURCES.expenses = true`. Operating expenses and Estimated operating profit (= Gross Profit − Operating Expenses, from `shared/finance.js`) are live:
- A day with any activity shows real figures, including ₱0 of expenses. Every metrics write fills all financial counters.
- A day with no activity still says "No data yet".
- It's still called *Estimated* Operating Profit, never net income.

**API:** `POST /api/expenses` with actions `create` (`expenses.create`), `update` (`expenses.update`, optional `expectedRevision`) and `remove` (`expenses.delete`). It checks sign-in first, the Expenses module, write access and a strict payload. The server sets createdBy, timestamps and metrics; the browser can't.

**Reads** come from Firestore with `expenses.view`. Owner and Manager templates hold all four `expenses.*` permissions; Staff hold none, so Staff see no expenses or financial figures unless explicitly granted. The page queries are paginated (25) and filtered by date range, category, method, and a payee prefix or exact reference. Indexes: `(status, date↓)`, `(status, category, date↓)`, `(status, method, date↓)`, `(status, category, method, date↓)` and `(status, payeeLower)`.

**Screen:**
- **Table:** `Date | Category | Vendor / Payee | Method | Reference | Amount | Recurring | View details`.
- **Add expense:** one form whose date defaults to the business's today.
- **View details:** every field, who and when, and the activity log. Edit → Save; ⋯ More → Remove expense.
- **Title:** for Distributor the page and its navigation item are titled "Operating Expenses" (template label).

**Templates:**
- Activated for **Distributor only**: template v2 → v3, with `upgradingFrom: [2]` during the rollout, then recompute, then strict.
- Baby and Bridal keep `expenses` in `plannedModules` (labelled "Baby Expenses" / "Wedding Expenses"). A planned module may be built: the template's `modules` list alone decides where it's operational, and a forged snapshot can't lift that ceiling in the server, browser or rules.

## Reports (Phase 11, Distributor)

Reports answer an owner's everyday questions: sold, collected, unpaid, gross profit, spent, estimated operating profit, top products and customers, low stock. It is not an accounting package or a BI tool: no ledger, balance sheet, tax, aging, custom builder, forecasting or AI.

**One server endpoint:** `GET /api/reports?from=YYYY-MM-DD&to=YYYY-MM-DD` (Reports module + `reports.view`). It is read-only, so it also works while suspended.
- **Range:** business-local days, **inclusive at both ends**, at most **366 days**, never past the business's today. Presets (Today, Yesterday, This week (Monday start), This month, Last month) come from the business-local today, never the device clock.
- **Strict query:** `from` and `to` only. A `businessId`, cursor or any other parameter is a 400; the business is always the caller's resolved tenant.

**Where the numbers come from** (no transaction lists are downloaded):
- **Totals:** the same restated `financialMetrics` / `metrics` day and month documents the Dashboard reads, summed and passed through the same `financialSummary()`. Dashboard and Reports therefore can't disagree, and tests assert they match for the same day.
- **Reads:** ranges ≤ 62 days read day documents (with a by-day series). Longer ranges read whole-month documents plus the partial edge days (a by-month series), at most about 72 per collection for a full year.
- **Breakdowns:** `reportRollups/{day}` and `/{month}`, one small **server-only** document per business per period, new in Phase 11. It holds maps of `products` (qty, net sales, COGS, sku/name), `customers` (orders, net sales; walk-ins under `_walkin`), `paymentMethods` (count, amount), `expenseCategories` and `expenseMethods` (count, amount).
  - It's updated by increments in the **same transaction** as fulfilment, fulfilled-order correction, payment record/edit/void, and expense create/edit/remove.
  - It posts to the event's own day (fulfilment day, payment received day, expense date), so corrections restate history exactly like the metrics.
  - The rollup is read only by the server (no browser rule), so money in it never reaches a user without `dashboard.financials`.
- **Current gauges:** unpaid balance and unpaid orders "now", and low stock (bounded query, 50 rows).
- **Rows:** rankings return the top 50 with a total count.

**Definitions (shared/finance.js):** Net Sales = Gross Sales − Discounts − Returns; Gross Profit = Net Sales − COGS; Estimated Operating Profit = Gross Profit − Operating Expenses; Gross Margin % = Gross Profit ÷ Net Sales. It is never called net income or net profit.
- **Sales vs Payments:** sales and COGS are recognised at fulfilment (Phase 7). Payments Received is money collected in the period. Paying before fulfilment moves payments, not sales.
- **Products:** sales are **after order discounts**. Each order's discount is shared across its lines by subtotal (largest remainder), so product sales add up to Net Sales exactly. COGS is each line's cost snapshot from fulfilment, never today's cost.
- **Customers:** fulfilled orders and net sales in the period (the same recognition as Sales), plus outstanding balance and last order from the Phase 9 customer record, labelled "now". Walk-ins are one separate row.
- **Payments:** live payment records by method (voided ones never count), using the same rule as `paymentsReceived`.
- **Expenses:** active expenses only, by category and by method.

**No fabricated data:** a period with no summary document returns `null` ("No data yet"). A document that exists gives real values, including 0.

**Permissions** (enforced in the server's response, not by hiding columns):

| Section | Needs |
|---|---|
| Orders overview, series counts | `reports.view` |
| Payments | Payments module + `payments.view` |
| Products sold | Orders module + `orders.view` |
| Customers | Customers and Orders modules + `customers.view` and `orders.view` |
| Expenses | Expenses module + `expenses.view` |
| Low stock | Inventory module + `inventory.view` |
| Any money: sales, COGS, profit, margin, AOV, payment and unpaid amounts, per-product and per-customer money | additionally `dashboard.financials` |

Without `dashboard.financials` the server never reads `financialMetrics` and returns counts and quantities only. Owner and Manager templates hold `reports.view` and `reports.export`; Staff hold neither.

**Screen:** a date control (preset or custom), with Overview / Sales / Products / Customers / Payments / Expenses tabs. Tabs the user can't see are absent. Tables are compact, with no chart framework. Each table has **Download CSV** (`reports.export`), built client-side from the rows already returned. Cells that look like formulas (= + - @) are neutralised. No server export framework yet.

**Activation and backfill:**
- Reports was marked built; the Distributor template went v3 → v4 (`upgradingFrom: [3]` during the window), then recompute, then strict. Baby, Bridal and Payroll keep Reports off; forged snapshots fail closed in the server and rules.
- `npm run rebuild-report-rollups` recomputes the rollups from fulfilled orders + `orderCosts`, live payments and active expenses. It covers history recorded before Phase 11, and the tests use it as an oracle: the incremental rollups must equal a rebuild, including under concurrency on the real emulator. Run it while the business is quiet.

**Scale note:** `reportRollups/{day}` is written by every fulfilment, payment and expense that day, like `financialMetrics/{day}`. That's fine for SMB volumes, and the documents stay small (one entry per product or customer active that day).

## Performance

- The dashboard reads at most four summary documents (see above), plus small limited list queries once Orders and Inventory exist.
- Lists are paginated (25–50 records per page) with server-side `where()` filters and indexes.
- Every query is scoped to a single tenant.

## Usage metering

- `usage/{YYYY-MM}` counters are incremented inside the same transaction as the action they meter. Limits are enforced there, on the server.
- Firestore read and write counts are Super Admin infrastructure metrics and are never shown to customers.

## Security baseline

- Rules deny by default. All operational writes go through functions that check login, membership, permission, module, subscription and plan limits.
- Storage lives under `tenants/{bid}/...` and nothing is publicly readable.
- An automated tenant-isolation test suite (Firebase emulator) must pass before deploys.
- The UI escapes every interpolated value by default (`src/lib/html.js`).
- Netlify sets security headers and a strict CSP: no inline scripts or styles.

## UI standard: compact operational tables (2026-10-08)

Luna should feel like an operations control sheet: compact, scannable, quick to edit, with few clicks. Validation, audit, transactions and security happen behind the scenes.

- **One record = one compact row** (`.table-compact`). No tall cards.
- **Inline edits** for safe common fields such as price, reorder level and status, using a cell button that opens a one-field popover, or an inline select.
- **Stock is never typed over.** Changes go through a row **Adjust** action (a signed quantity plus a reason, logged server-side).
- **One View details per row** holds the full record, history and transaction log, notes, and uncommon or destructive actions.
- **Cost and profit columns** appear only with the matching permission.
- **Mobile:** secondary columns (`.col-secondary`) hide under 760 px wide; their data stays in View details.

Columns by screen:

| Screen | Columns |
|---|---|
| Inventory (Phase 6/7) | SKU | Product | Category | Unit | On hand | Reserved | Available | (Avg cost | Value) | Reorder at | Price | Status | Adjust / View details |
| Orders (Phase 7) | Order # | Time | Customer | Items | Total | Reference | Proof | Payment | Fulfillment | View details |
| Payments | Order # | Customer | Amount | Method | Reference | Proof | Verification | Date | View |
| Expenses | Date | Category | Vendor | Amount | Method | Reference | Status | View |
| Customers | Customer | Contact | Orders | Total purchases | Last order | Status | View |
| Users, Suppliers, Returns | the same pattern |

On Orders, Reference and Proof show "—" until Payments (Phase 8) fills them in.

## Build phases

1. Foundation ✅
2. Auth and multi-tenant business/user model ✅
3. Rules and tenant-isolation tests ✅
4. Plans, modules, permissions ✅
5. Dashboard and metrics framework ✅
6. Products and inventory ✅
7. Orders ✅
8. Payments ✅
8.5. Workspace templates ✅
9. Customers ✅
10. Expenses ✅
11. Reports (incl. operating P&L) ✅
12. Imports
13. Notifications
14. Super Admin console
15. Usage metering views
16. Reliability, backups and recovery

- Phases 6 and 7 are in this order because orders need products to reserve and a cost to snapshot.
- Expenses come before Reports so the P&L has operating expenses to subtract.
- Expenses don't depend on Customers, so Phases 9 and 10 could swap if that helps.
