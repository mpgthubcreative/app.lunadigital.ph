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
    inbox/{id}                    Phase 13 notifications, one per recipient          (own uid + notifications.view)
    inboxState/summary            { unread } for the bell                            (own uid + notifications.view)
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

Server-only, never readable from the browser: `users`, `plans`, `platformAudit`, `paymentRefs`, `counters`, `usage`, `auditLog`, `integrations`, and every collection-group query. Since Phase 13 a member reads their OWN `members/{uid}/inbox` and `inboxState` (`notifications.view` + the plan's in-app notifications); read state changes only through `POST /api/notifications`.

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
| `distributor` (v5) | live | orders, payments, inventory, customers (Phase 9), expenses (Phase 10, "Operating Expenses"), reports (Phase 11), imports (Phase 12) | suppliers, production, returns (notifications became a core capability in Phase 13) |
| `household-payroll` (v2) | live (Phase 14) | household, attendance, payroll, advances | payroll reports |
| `baby-expense` (v2 only) | live (Phase 15) | expenses ("Baby Expenses"), budget (with categories), schedule (Payment Schedule), providers | milestones, reports |
| `bridal-expense` (v2 only) | live (Phase 16) | expenses ("Wedding Expenses"), budget ("Wedding Budget"), vendors (Wedding Suppliers), vendorpayments (Supplier Payments), tasks, guests (Guests & RSVP) | reports |

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

## Luna-wide product requirements (recorded after Phase 11)

These apply to every phase from Phase 12 on. Each module adopts them when it's built or next touched; they are not all implemented yet.

**1. Filter → View → Download.**
- Wherever Luna shows meaningful tabular or operational data, the active filters decide both what is displayed and what is exported. For example, Orders filtered to Oct 1–31, Paid, Fulfilled → Download Excel exports exactly those records.
- "Export all", if ever offered, is a separate, explicit choice.

**2. Excel (.xlsx) is Luna's business export format**, across every workspace template. Existing CSV (Reports) stays.
- There is one shared, controlled implementation (`shared/xlsx.js`, Phase 12), not a per-module one.
- An export respects tenant isolation, workspace template, module entitlement, user permissions, financial visibility, active filters and an explicit field selection.
- A workbook never contains a field the user couldn't receive through the app or API. Restricted data is never fetched and then hidden in the workbook.
- Every cell is written as a plain value, never a formula. Text that looks like a formula (`= + - @`, tab, CR) is neutralised.
- Small filtered results may be generated in the browser from rows the API already returned. Larger exports use protected server retrieval, paginated or chunked, with row limits. Asynchronous export jobs come only if volumes require them.

**3. Distributor Excel downloads (built in Phase 12.5, see "Exports and Dashboard periods"):** Products, Inventory, Orders, Payments, Customers, Expenses and Reports (Reports keeps CSV and gains .xlsx), plus Import History where useful.

**4. Distributor Dashboard date filter (built in Phase 12.5):**
- Presets: Today, Yesterday, This week, This month, Last month, Custom. They use the business timezone, the same presets as Reports (`reportPresets`).
- The filter drives period metrics (net sales, COGS, gross profit, operating expenses, estimated operating profit, payments received, orders, period activity) through the same summary documents and `financialSummary`, with no new formulas.

**5. Period metrics vs current-state metrics.** A date filter never pretends Luna stores historical snapshots it doesn't have.
- **Selected period:** sales, COGS, gross profit, expenses, estimated operating profit, payments received, orders in the period.
- **Current operations** (always "now", labelled so): low stock, available inventory, unpaid balance, orders awaiting fulfilment.
- Dashboard and Reports keep these two groups visually separate.

**6. Distributor module filters (target):** only filters an index serves; no unbounded scans.

| Module | Filters |
|---|---|
| Products | search, category, active/inactive |
| Inventory | search, category, low-stock/status |
| Orders | date range, payment status, fulfilment status, customer, source |
| Payments | date range, method, verification/payment status, customer/order/reference search |
| Customers | search, active/inactive, balance state (later, if efficient) |
| Expenses | date range, category, method, payee/reference search |
| Reports | the Phase 11 business-local ranges |

**7. Distributor Dashboard Excel download (built in Phase 12.5):** reflects the selected range. Possible sheets are Summary, Sales, Products, Customers, Payments and Expenses, including only the sheets and fields the user may access. A Staff user without financial permission never gets sales, COGS, profit or expense amounts through an export.

**8–15. Household / Kasambahay payroll (built in Phase 14, see "Household / Kasambahay Payroll").**
- **Modules:** Dashboard, Household Staff, Attendance, Payroll, Salary Payments, Employee Receipt Confirmation, Advances, Deductions, Payroll History, Reports, Excel Downloads.
- **Filtered Excel exports** of each. Example: Employee = Maria, Period = Oct 1–15 → her attendance and payroll for that period.
- **Daily attendance line items:** `Date | Day | Status | Daily Wage | Payable Amount | Notes`. Statuses are Present, Absent and Official Leave.
  - Present and Official Leave are payable; Absent is not.
  - Payable Days = Present + Official Leave. Base Pay = Daily Wage × Payable Days (₱600 × 12 = ₱7,200).
  - Luna calculates these; users never type Base Pay.
- **Inline attendance:** where permitted, status is changed inline (Present ▾ → Absent). Luna recalculates payable days, base pay and the payroll total, and records previous status → new status, actor and time.
- **Payroll summary:** Employee, Period, Daily Wage, Present / Official Leave / Absent / Payable Days, Base Pay, Advances / Deductions, (other adjustments later), Net Pay, Salary Payment Status, Employee Receipt Confirmation. Example: Maria, ₱600/day, 10 / 2 / 3 → 12 payable days → ₱7,200 base − ₱500 = ₱6,700 net.
- **Advances:** `Date | Employee | Description | Amount | Status | Paid Date | View Details`. The status is a controlled value, Not Yet Paid or Paid, never free text. Marking Paid records amount, release date, actor, and method/reference where useful.
  - **Advance release ≠ advance repayment.** "Was it released to the employee?" is separate from "has it been deducted / repaid?" Outstanding balance and settlement come later.
- **Salary paid ≠ receipt confirmed.** The flow is payroll calculated → salary released / paid → the employee confirms receipt, as three separate states. "Paid Oct 15 6:10 PM, Receipt: Awaiting Confirmation", then "Confirmed Oct 15 6:18 PM".
- **Possible dashboard widgets:** Payroll This Period, Present / Absent / On Leave Today, Salary Due, Salary Paid, Awaiting Receipt Confirmation, Outstanding Advances.

**16. Bridal (future; nothing built yet):** filters plus Excel for each list, with active filters flowing into the export.

| List | Columns | Filters |
|---|---|---|
| Budget | Category, Budget, Actual, Paid, Balance | — |
| Suppliers | Supplier, Category, Contract Amount, Paid, Balance, Next Due | category, paid/unpaid, outstanding balance |
| To-Do | Task, Category, Assigned To, Due Date, Priority, Status | status, due date, assignee, category, priority |
| Guests / RSVP | Guest, Group, Party Size, Invitation Status, RSVP, Confirmed Guests, Table | Confirmed / Declined / Awaiting, side or group, table |

**17. Baby tracker (built in Phase 15, see "Baby Expense Tracker"):** filtered .xlsx for Budget (with its categories), Baby Expenses, Providers / Vendors and the Payment Schedule (for example Category = Medical over a date range). Named pregnancy periods (e.g. First Trimester) were not added; a custom date range covers them.

**18. Never** generate a workbook by dumping a Firestore collection into the browser.

**Production-readiness item (from Phase 11):** `rebuild-report-rollups` needs the business to be quiet, because an event during a rebuild could be overwritten. Before production, make rebuild/backfill concurrency-safe, for example by versioned rollups written aside and then swapped, or by a maintenance flag that pauses writers.

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

## Imports (Phase 12, Distributor)

Imports let a distributor bring in its existing **Products** and **Customers** from Excel (.xlsx) or .csv, with a preview and a confirmation before anything is saved. Historical Orders, Payments, Expenses, inventory transactions and sales/COGS are **not** importable: they drive metrics, stock and money and are only created through their own flows. There is no Google Sheets sync.

**Flow:** choose type → choose file → map columns → preview → confirm → import → Import History.
- **The browser only parses** (`shared/xlsx.js`, `shared/csv.js`): the first sheet, the first non-empty row is the header, and blank rows are dropped but row numbers are kept. Columns are auto-mapped from synonyms (e.g. "Item Code" → SKU, "SRP" → Selling price), and the user can change any mapping. Downloadable templates (.xlsx) use Luna's field names.
- **The server validates everything** (`POST /api/imports`, `preview`): every mapped row goes through the same `validateProductInput` / `validateCustomerInput` as manual entry, then duplicate checks. The job is stored server-side as `imports/{jobId}` plus `imports/{jobId}/rows/{NNN}` (200 rows per chunk).
- **Row statuses:** **Ready** (will be created), **Warning** (a possible problem; imported only if the user ticks "Include warning rows"), **Error** (never imported; the message says why). Rows already in Luna are Warnings with action "skip".
- **Duplicates, tenant-scoped and bounded:**
  - Products: the same SKU twice in the file is an Error; a SKU that already exists (`skuIndex`, at most one read per row) is skipped.
  - Customers: the same name + phone twice in the file is skipped. An existing customer with the same name + phone (`in` queries of 30) is skipped. The same phone or the same name alone is a "possible duplicate" Warning.
- **Existing records are never updated.** A match is always skipped.
- **Preview screen:** Ready / Warning / Error filter cards, 50 rows per page, and **Download these rows (.xlsx)** for the current filter (Filter → View → Download).

**Commit** (`commit`, call again until `{ done: true }`):
- It imports the **stored preview**; rows are never re-sent. Work happens in time-boxed batches (6 s per call, inside Netlify's synchronous limit), and the screen shows progress.
- **Idempotent per row:** each product or customer is created in ONE transaction together with its `results.{i}` marker (`createProduct` / `createCustomer` hooks). Retries, double clicks and concurrent commits never create a row twice. ALREADY_EXISTS from a racing commit resolves to done or skipped.
- At commit time a SKU or customer added since the preview is skipped, not duplicated. An imported product is created exactly like a manual one: stock 0, no inventory transaction or sales/COGS; only the low-stock gauge moves. Opening stock goes through Inventory receipts or Adjust.
- **Plan limit:** `importsPerMonth` is checked and counted (`usage/{month}.excelImports`) **once per job**, in the transaction that starts the commit, so racing jobs can't exceed it.
- Previews **expire after 24 hours**. A previewed job can be cancelled. Completion writes `auditLog` `import.completed` with the result `{ created, skipped, failed, notImported }`.

**Access:**
- **Server:** Imports module + `imports.run` + write access, plus the target data's own module and manage permission (Products: Inventory + `products.manage`; Customers: Customers + `customers.manage`). The type picker only offers what the user may import.
- **Rules:** `imports/{id}` and `rows/{n}` are readable with Imports + `imports.run` and are never writable from the browser. Owner and Manager hold `imports.run`; Staff don't.
- Other workspaces (Bridal, Baby, Payroll) never have Imports.

**Import History:** one compact row per import (Type, File, Rows, Created, Skipped, Failed, Status, By, Date), 25 per page. **View details** shows every row with its outcome, an outcome filter, and an .xlsx download.

**Limits:**

| Limit | Value |
|---|---|
| File size | 5 MB |
| Unzipped size | 40 MB (zip-bomb guard) |
| Rows per import | 2,000 |
| Columns | 60 |
| Characters per cell | 500 |
| Request body | 3 MB |

**Shared XLSX capability (for future exports):**
- `shared/xlsx.js`: `readXlsx` / `writeXlsx` on `fflate` (pinned 0.8.3) with a minimal own XML reader/writer, so there's no heavy spreadsheet dependency.
  - Formulas are never evaluated (the cached value is read).
  - Written cells are inline strings or numbers.
  - Every text cell passes `safeCellText`, which prefixes `'` to `= + - @ tab CR` to prevent formula injection.
- `shared/csv.js` mirrors it for CSV.
- Future module and Dashboard downloads reuse these helpers. Data is still fetched under the Filter → View → Download and server-pagination rules above, never by dumping collections.

**Activation:** Imports was marked built; the Distributor template went v4 → v5 (`upgradingFrom: [4]` during the window, rules `[4, 5]`), then recompute, then strict `[5]`.

## Exports and Dashboard periods (Phase 12.5)

**Filter → View → Download** is a Luna-wide rule. The filters the user has applied decide what they see and what they download. A download contains every row matching those filters, across all pages, never just the visible page and never the unfiltered history. An "Export all" would be a separate, deliberate option; none exists yet.

### Export Core

One controlled path for every Excel download: `POST /api/exports { dataset, filters }`, which returns the `.xlsx` file. The browser never builds a workbook from data it happens to hold, and it is never the authorization boundary.

| Piece | Where | What |
|---|---|---|
| Query definitions | `shared/list-queries.js` | What each list's filters mean (Orders, Payments, Products/Inventory, Customers, Expenses). The browser lists (`src/lib/query.js`) and the server exports run the same specs, so a download can't disagree with the screen. |
| Dataset descriptors | `shared/export-datasets.js` | Per dataset: module, view permissions, export permission and filter schema. Used by the server to validate and by the browser to decide whether to show the button. |
| Core primitives | `shared/exports.js` | Filter validation (unknown filters, bad values and bad ranges are refused; ranges are inclusive, at most 366 days), `canExport`, column visibility by permission, business-timezone date/time cells (Excel serials), money and quantity cells, safe file names, `EXPORT_MAX_ROWS`. Workspace-agnostic. |
| Runner | `netlify/functions/_lib/export-core.js` | Access, filters, paged reads, workbook, trace (below). |
| Builders | `netlify/functions/_lib/exports/records.js`, `summaries.js` | Columns and queries per dataset. |
| Spreadsheet layer | `shared/xlsx.js` (Phase 12, `fflate` 0.8.3) | Extended with number formats (money `#,##0.00`, integer, percent, dates), column widths, a frozen header and document properties. Still no formulas: every text cell passes `safeCellText`. |

**Access, checked on the server before anything is read:**
- `requireTenant`: authenticated, active membership, the selected business, subscription policy (reads also work while suspended), the dataset's module entitled and allowed by the workspace template, and the export permission.
- `canExport`, checked again: module usable, every view permission, export permission.
- **Columns** that need more declare it (`needs`): COGS and gross profit need `dashboard.financials`; average cost and inventory value need `inventory.costs`.
- **No fetch-then-hide:** builders don't even READ `orderCosts` or `productCosts` for callers without those permissions (tests spy on the reads). The Dashboard and Reports workbooks reuse `resolveDashboard` and `buildReport`, which never compute money without `dashboard.financials`.
- **The browser can't choose what's read.** It sends a dataset id and filters only; it can't name a collection, field, sort key or business.

**Permission model:**
- `data.export` is the canonical capability: core (the Dashboard module), so it works in every workspace. Owner and Manager have it; Staff don't.
- An export also needs the data's own module and view permission.
- **Reports keeps `reports.export`** (Phase 11 behaviour) for both its CSV and `.xlsx` downloads.
- Existing members receive the new key through `npm run resync-permissions`.

**Rows, limits and performance:**
- **Reads:** the server reads with the list's spec, page by page (1,000 per read, document cursors), until every matching row is in.
- **Limit:** past **EXPORT_MAX_ROWS = 10,000** the request is refused (413): "This export contains too many rows. Narrow your filters and try again." It is never truncated.
  - 10,000 is an **initial synchronous safety limit**, not a permanent scalability claim. It will be benchmarked again on production infrastructure in Phase 19.
  - The refusal happens while reading (at most 10,001 documents), before any workbook is built, and leaves no audit or usage entry. `tests/functions/export-limit.test.js` checks the real value: 10,000 rows accepted in full, 10,001 refused.
- **Measured** (`scripts/measure-export.js`, 10,000 orders with 30,000 order lines):

  | Measure | Result |
  |---|---|
  | Build + write | about 1.8 s CPU |
  | Workbook | 2.1 MB (2.9 MB base64; Netlify's limit is 6 MB) |
  | Heap | about 100 MB |

  20,000 orders reach 5.7 MB base64, too close to the response limit. There was no 10,000-row live load test on staging (to avoid creating 10,001 cloud records). The staging boundary is covered by the tests above.
- **Searches:** a search (name prefix OR exact SKU / reference) runs its parts and merges them. The list shows the first matches; the export returns them all.
- **No N+1:** cost documents are read in batches (`getAll`, 300 per call). The Dashboard and Reports workbooks read only summary documents.

**Datasets:**

| Dataset | Screen | Filters | Sheets |
|---|---|---|---|
| `dashboard` | Dashboard | period (required) | Summary (selected period), Period activity (day or month rows), Current operations (live, labelled "NOT for the selected period") |
| `reports` | Reports | range (required) | Overview, Sales, Products, Customers, Payments, Expenses by category / method, Low stock (now): only the sections this caller may see |
| `orders` | Orders | payment, fulfillment, source, order-date range | Orders (one row per order, items summarised) + Order lines |
| `payments` | Payments | status, method, received-date range | Payments (Proof attached = Yes/No; never a storage path or URL) |
| `products` | Inventory | search, category, status, low stock | Product list (no stock or cost) |
| `inventory` | Inventory | same | Stock levels (+ cost and value with `inventory.costs`) |
| `customers` | Customers | status, search | Customers with the server-kept statistics |
| `expenses` | Expenses | date range, category, method, search | Active expenses only (removed ones are not exported) |

Every workbook ends with an **Export info** sheet (business, data, filters, rows, who, when in business time).

**File names:** `Luna_Orders_2026-10-01_to_2026-10-31.xlsx`, `Luna_Inventory_2026-10-08.xlsx` (business-local dates, sanitised).

**Trace:** one `auditLog` entry `export.generated` (dataset, filters, row count, actor; never exported data) and `usage/{month}.exportsGenerated` / `rowsExported` for future metering. No limits are enforced yet.

**Imports** keep their own downloads (blank templates, preview rows, history rows) on the same spreadsheet layer.

**Future workspaces** (payroll, bridal, baby) add their own descriptors and builders when their modules are built. The core is not Distributor-specific.

### Dashboard periods

- **Filter:** Today, Yesterday, This week (Monday start), This month, Last month, Custom. These are the Reports presets, in the **business timezone**, inclusive, at most 366 days, never past today.
- **Selected period:** Net sales, COGS, Gross profit, Operating expenses, Estimated operating profit, Payments received, Orders.
  - Read from the same day / whole-month summary documents as Reports (`rangePlan`), and summed by the same `sumMetricDocs` → `financialSummary`. Dashboard and Reports therefore match for the same range (tested).
  - A period with no summary documents shows "No data yet", never ₱0.
- **Current operations · as of now:** Current unpaid balance, Current unpaid orders, Awaiting fulfillment now, Current low stock (+ the low-stock list).
  - These are live gauges. Choosing Last month never relabels them as last month's, and Luna doesn't reconstruct historical stock or unpaid balances it never stored.
- **Reads:** Today is still 4 documents. A full year is at most about 72 per collection.
- **Download Excel** (`data.export`) produces the workbook for the period on screen.

## Notifications (Phase 13)

A shared Luna capability: **event → rule → recipients → channels → read state**. It answers "what happened, or what needs my attention?" It is not built for volume. Only operational items that need someone are notified.

### Shape
| Piece | Where | What |
|---|---|---|
| Rules (types) | `shared/notifications.js` `NOTIFICATION_TYPES` | Each type has a category, a module, the permissions a recipient needs, whether the actor is excluded, and a link (a label and an internal route). Workspace-agnostic. |
| Producer API | `netlify/functions/_lib/notifications.js` | `prepareNotifications(tx, …)` in the read phase of the business event's own transaction, then `commit()`. `prepareResolution` marks an item dealt with. `markRead`, `markAllRead`, `setPreferences`. |
| Endpoint | `POST /api/notifications` | `read`, `readAll`, `preferences`, for the caller's own inbox only. The uid always comes from the token. |
| Screens | `src/app/notification-bell.js`, `src/modules/notifications/` | The bell and drawer in the shell, and the `/notifications` page with history, filters and preferences. |

### Data model
```
businesses/{bid}/members/{uid}/inbox/{notificationId}
  { schemaVersion, businessId, recipientUid, type, category, module, title, message,
    recordType, recordId, action{label,route}, eventKey, actorName,
    read, readAt, resolved, resolvedAt, delivery{inApp,email,push}, createdAt }
businesses/{bid}/members/{uid}/inboxState/summary   { unread, updatedAt }
businesses/{bid}/members/{uid}.notificationPreferences   { [category]: { inApp } }
```
- One document per recipient, so read state is per person.
- No secrets and no raw payloads. Payment proof paths and URLs never appear.
- The `notificationId` is deterministic: `{type}__{eventKey}`.

### Distributor rules (the only ones in Phase 13)
| Type | Trigger (server event) | Recipients | Category / in-app |
|---|---|---|---|
| `payment.awaiting_verification` | A payment is recorded by someone without `payments.verify`, so it lands in the "For verification" state. Event key: the payment id. | `payments.view` + `payments.verify` (Owner, Manager); never the recorder | payments, **mandatory** |
| `inventory.low_stock` | A product crosses from not-low to low (`available <= reorderLevel`). This happens through any stock movement (including order reservations and fulfilment), a reorder-level edit or a reactivation. Creating a product never alerts. Event key: `{productId}-{lowStockEpisode}`. | `inventory.view` + `inventory.receive` (Owner, Manager) | inventory, default on |
| `order.ready` | An order moves to Ready, which is the only stage change worth telling. Event key: `{orderId}-r{revision}`. | `orders.view` + `orders.fulfill`, excluding whoever set it | orders, default on |

- **Low stock re-alert policy:** further decreases while a product is low say nothing. Once it is back above its level, the next crossing increments `lowStockEpisode` on the product (in the same transaction) and alerts again.
- **No "payment overdue" rule.** Luna has no due dates or credit terms, so an unpaid balance isn't "overdue". Unpaid orders stay visible on the Dashboard and in Reports.
- **Resolution:** verifying or removing a payment that awaited verification marks every recipient's copy resolved. It also drops that copy from their unread count. Reading is per person, but resolution is a business fact. Low-stock and ready notifications aren't auto-resolved.

### Recipients
A member gets a notification only when all of these hold:
- the membership is **active**
- the stored permission map has `notifications.view` and every permission the rule needs
- the rule's **module** is enabled for the business, with the workspace template as the ceiling
- the plan has `features.inAppNotifications`
- their preferences allow it

A Bridal, Payroll or Baby business can never receive a low-stock or payment notification, because those modules aren't in its template. Malformed member data skips that member and never fails the event.

### Consistency model
- Notifications are written **in the same Firestore transaction** as the event. A payment, movement or stage change and its notifications commit together or not at all. Nothing half-applied, nothing silently lost.
- The notification code adds reads only when an event actually notifies: the business doc, active members, and the recipients' would-be notification ids.
- It has no external calls, so it can't make a valid operation fail on its own account.
- **Idempotency:** deterministic ids plus an existence check inside the transaction. HTTP retries are refused by the domain itself (duplicate payment reference; a stage that's already Ready). Concurrent requests serialize on the documents they touch.
- **Unread counter:** creation increments it in the same transaction. Mark read and read-all read the counter in their transaction and write the exact value, clamped at 0. Read-all marks in chunks of 200, and the last chunk sets 0 exactly, which also repairs any drift.
- Concurrency tests on the emulator (`tests/emulator/notifications-concurrency.test.js`) check that the counter always equals the number of unread notifications. They cover retries, crossings, reads, read-all and resolution racing new notifications.

### Read path and security
- **Rules:** a member reads only `members/{their uid}/inbox/*` and `inboxState/*`. This needs `notifications.view` (core Dashboard module) and the plan feature. No collection-group reads and no browser writes.
- **The bell** reads one document (the counter) on navigation, on tab focus, after a read, and every minute while visible. The drawer reads the latest 8 only when opened.
- **The page** pages 20 at a time (`createdAt desc`, id as tiebreak), with All/Unread and category filters. Composite indexes exist for the inbox filters.
- **A link is a convenience.** The destination checks access like any navigation. When the user no longer holds a rule's permissions, the row shows "No access" and no link.
- Disabled members, other members, other businesses and cancelled accounts read nothing.

### Preferences
- Per category, in-app only for now. Self-service under `notifications.view`, with no separate permission.
- **Payments awaiting verification** is mandatory in-app: it needs someone's action and nothing else surfaces it.
- **Low stock** and **Orders ready** can be switched off.

### Channels
| Channel | Phase 13 |
|---|---|
| In-app | **Delivered.** It is the record of truth. |
| Email | **Deferred.** Luna has no email provider. Adding one (for example Resend or Postmark: an account, a sending domain and a server-only API key) is a new infrastructure and billing decision that needs approval. |
| Browser push | **Deferred.** It needs FCM, a service worker, VAPID keys and token storage. Tokens would sit under `members/{uid}/devices` (server-written, revoked on sign-out or expiry). Push is never authoritative. |

The architecture is ready for both:
- channel definitions (`NOTIFICATION_CHANNELS`)
- opt-in channel preferences (`wantsChannel`)
- a per-notification `delivery` state (`email` / `push`: `not_sent`)

Delivery would run **after** the transaction commits, never inside it.

### Not built (later)
- **Scheduled producers.** "Task due tomorrow", "salary due" and "RSVP deadline" need a scheduled evaluation. They would be a scheduled Netlify function calling the same producer API with deterministic keys (for example `task-123-2026-10-09`). No Distributor rule needs one yet, so there is no scheduler.
- **Future workspace types**, each with its own module and permissions:
  - Payroll: salary ready for payment, advance approved but not paid, salary released / receipt pending, receipt confirmed.
  - Bridal: task due or overdue, supplier payment due, RSVP deadline.
  - Baby: upcoming payment, budget threshold, milestone reminder.
- **Retention cleanup** of old read notifications: automatic and server-side when needed.
- **Excel export** of the inbox. The Export Core can add it.
- **Not planned:** analytics, SMS, chat apps, webhooks, campaigns.
- **No audit-log entries** for reads; the inbox is its own history.

## Household / Kasambahay Payroll (Phase 14)

The `household-payroll` workspace template (v2, live) adds four modules. They are operational only in this template; a Distributor business never gets them, and a payroll business never gets Distributor modules.

| Module | Screen | Data (`businesses/{bid}/…`) | Permissions |
|---|---|---|---|
| `household` | Household Staff | `householdStaff/{id}`: name, position, daily wage, pay cycle, status, start date | `household.view`, `household.manage` |
| `attendance` | Attendance (by day / by employee) | `attendance/{staffId}_{day}`: status, wage snapshot, payable, amount, history | `attendance.view`, `attendance.edit` |
| `payroll` | Payroll (history = Paid filter) | `payrolls/{staffId}_{periodStart}`: counts, base, deductions, net, salary, receipt | `payroll.view`, `payroll.manage`, `payroll.release` |
| `advances` | Advances | `advances/{id}`: amount, Not Yet Paid / Paid, release details, deduction link | `advances.view`, `advances.manage` |

Owner and Manager get every payroll permission. The Staff role template gets none; it is Distributor-oriented, and household roles can be added as data later.

### Your decisions (2026-10-09)
- **Pay cycle per employee:** weekly (Mon–Sun), semi-monthly (1–15, 16–end) or monthly. `shared/payroll.js` `periodFor`.
- **Advances are deducted in full, automatically:** every Paid advance not yet deducted goes onto the person's next payroll.
- **Receipt confirmation by one-time link:** no employee login.

### Rules and calculation (Luna computes; nobody types base pay)
- **Statuses:** Present and Official Leave are payable. Absent isn't, and neither is a day nobody marked (shown as "Not marked").
- **Each line keeps the wage it was marked at.** Base Pay = the sum of each payable day's wage (Daily Wage × Payable Days when the wage didn't change). Net Pay = Base Pay − deductions.
- **Inline edits:** an attendance change (Present ▾ → Absent) records previous → new status, who and when. It also moves the unpaid payroll for that period in the same transaction (a per-line delta).
- **Locked when paid:** once the salary is paid, the period's attendance is locked (`payroll-released`).
- **Preparing a payroll:** it's idempotent per person and period, a period must match the person's cycle, and a future period is refused. Days are counted from the attendance lines, and every Paid, not-yet-deducted advance is deducted.
- **Marking an advance Paid while an unpaid payroll exists** adds the deduction to that payroll at once.
- **"Deduct next payroll"** moves an advance's deduction to the following payroll, for when the pay can't cover it. Deleting an unpaid payroll returns its advances.
- **Manual deductions** (description and amount) can be added or removed while the payroll is unpaid.
- **Paying the salary** (`payroll.release`):
  - It's refused before the period's last day, and refused when net pay is below 0.
  - It records the method, reference and paid date for the net pay, in full.
  - It marks the deducted advances as deducted.
  - Receipt becomes "Awaiting confirmation".
- **Salary paid ≠ receipt confirmed:** they are separate states (`status` and `receiptStatus`).

### The one-time receipt link (public, no login)
- **Issuing:** paying the salary returns a token once (24 random bytes, base64url). Only its SHA-256 hash is stored, in `receiptLinks/{hash}` (top level, server-only, no rule) and on the payroll.
- **The link:** `/receipt#<token>`. The token is in the URL fragment, so the browser never sends it as part of the page request. The page posts it to `POST /api/receipt` `{action: "view" | "confirm", token}`.
- **What the employee sees:** only the business name, their name, the period, the amount, the method and the paid date. No ids, no other records.
- **Validity:**
  - one payroll
  - only the current link (a new link replaces it, and the old one stops working)
  - 14 days
  - confirmable once
- **Errors:** every invalid token gets the same 404 "isn't valid" answer; an expired link gets 410.
- **On confirmation:** only the receipt fields change (`receiptStatus` → confirmed, `receiptConfirmedAt`, `receiptConfirmedVia: "employee-link"`, and a history line attributed to the employee via the secure link). The salary and payroll status are untouched, so a confirmation can never pay twice. The `payroll.receipt_confirmed` notification goes to members with `payroll.view` (Notifications Core reuse).

### Concurrency
- **Same-document conflicts:** attendance edits and a salary release both touch the payroll document, and preparing payrolls read and write the advance documents they deduct, so Firestore serializes them.
- **The per-person lock:** preparing a payroll, marking an advance paid, moving an advance and deleting a draft also write the person's staff document. That makes an advance paid at the moment a payroll is prepared land in that payroll.
- **Tested on the real emulator:**
  - parallel attendance marking and flipping (the payroll always equals a fresh recalculation from its lines)
  - a release racing attendance edits
  - advances paid while a payroll is prepared
  - two periods prepared at once
  - the same period prepared 6 times
  - one link confirmed 6 times
- **Not demonstrable on the emulator:** the emulator serializes these transactions, so mutation tests can't show the per-person lock's effect (mutants P12 and P18 survive). In production it removes the "paid during preparation → next payroll" timing case. Double deduction is prevented independently by the advance documents' own read/write conflict.

### Exports, dashboard, notifications
- **Excel**, through the Export Core (`data.export` + the module's view permission), with the same list specs as the screens:
  - Household Staff
  - Attendance (employee, status, date range)
  - Payroll (employee, salary, receipt, period range), with Deductions and the Attendance lines of the exported periods (one attendance query, no query per payroll)
  - Advances

  For example, Employee = Maria with periods from Oct 1 to Oct 1 gives her payroll, its deduction and the 15 attendance lines behind it.
- **Payroll Dashboard:** list widgets for Attendance today, Payroll not yet paid, Awaiting receipt confirmation and Advances not yet paid. No metric documents.
- **Notifications:** `payroll.receipt_confirmed` (category `payroll`, optional). Salary-due and similar scheduled reminders remain deferred (no scheduler).

### Staged rollout (new module ids)
New module ids would make every existing snapshot invalid until it's recomputed. The rollout therefore runs in two steps:
1. **Compatible step.** The four ids are in `ROLLING_OUT_MODULE_IDS`:
   - `validateEntitlementsSnapshot` and both rule files accept snapshots without their keys (missing = off), through `requiredModuleIds()` and `m.get('payroll', false) is bool`.
   - The template accepts v1 and v2.
   - Deploy the rules and code, run `seed-plans --overwrite` (the plans gain the four module keys), then run `recompute-entitlements --all`.
2. **Strict step.** Empty `ROLLING_OUT_MODULE_IDS`, require every key again, and drop template v1. `tests/shared/rules-registry.test.js` checks that both rule files agree with the registry in each step.

Status (2026-10-09):
- **Compatible step: deployed and verified.** It went live as `b9ef618` (Netlify, and the Firestore and Storage rules). Then `seed-plans --overwrite`, `recompute-entitlements --all` and `resync-permissions --all` ran.
- **Strict step: deployed and verified.** It is commit `f5db021`, with CI green.
  - Before it was committed, a read-only check confirmed that every staging snapshot passes the strict validator and that the deployed rules were still the compatible ones.
  - Netlify published `f5db021`, then the strict Firestore and Storage rules were deployed. The deployed rulesets match the source byte-for-byte.
  - A live probe passed 27/27. It used three temporary tenants, which were then removed. Household v2 works, and household v1 and snapshots without household keys are refused by Firestore, Storage and the runtime (503). Household modules forged into a Distributor open nothing.

`ROLLING_OUT_MODULE_IDS` is now empty and `household-payroll` accepts **v2 only**. Snapshots that are v1, have no version or an unknown or string version, or lack a household key fail closed in the validator and in both rule files. Household modules forged into a Distributor, Baby or Bridal snapshot open nothing (`tests/rules/payroll.test.js`, `tests/shared/workspaces.test.js`).

### Not built (later)
- **Payroll reports**, beyond the Excel downloads.
- **Outstanding-advance balances** and partial repayment.
- **Other adjustments:** overtime, holiday premiums, 13th month.
- **Government contributions:** SSS, PhilHealth, Pag-IBIG.
- **Scheduled reminders:** salary due, receipt not yet confirmed.
- **Household-specific role templates.**
- **Correcting a paid payroll:** it is locked.

## Baby Expense Tracker (Phase 15)

The `baby-expense` workspace template goes v1 → v2 (live). It is a personal budget and spending tracker for preparing for and caring for a baby. It is not accounting and not a medical record.

| Module | Screen | Data (`businesses/{bid}/…`) | Permissions |
|---|---|---|---|
| `expenses` (reused) | Baby Expenses | `expenses/{id}`: the Expenses Core record, with a tenant category, an optional `providerId` and the payee snapshot | `expenses.view / create / update / delete` |
| `budget` | Budget & Categories | `budgets/current` (the total budget and Luna's running totals), `expenseCategories/{id}` (the budget's lines), `spendingMetrics/{day or month}` | `budget.view`, `budget.manage` |
| `schedule` | Payment Schedule | `scheduledPayments/{id}`: Upcoming → Paid (one linked expense) or Cancelled | `schedule.view`, `schedule.manage` |
| `providers` | Providers / Vendors | `providers/{id}`: name, type, phone, email, location, notes, status | `providers.view`, `providers.manage` |

- **Roles:** Owner and Manager get every Baby permission. Staff get none: the Staff template is Distributor-oriented, and no family roles were added.
- **Marking a payment Paid** records an expense, so it needs `schedule.manage` **and** `expenses.create`, with the Expenses module.
- **Workspace ceiling:** the template is the ceiling. Distributor, Household and Bridal never get `budget`, `schedule` or `providers`, and Baby modules forged into their snapshots open nothing in the server, the browser or either rule file.

### Expenses Core reuse: one record engine, a sink per workspace
`netlify/functions/_lib/expenses.js` keeps the shared record behaviour:
- validation: integer centavos, business-local dates, no future dates
- history, revisions (Edit → Save), audited removal

What an expense **counts as** is the workspace's sink. It is chosen from the business's validated workspace (`ctx.workspace.templateId`), never a default:
- **`distributor`:** Operating Expenses in `financialMetrics` plus the report rollups, from the fixed categories. This is unchanged Phase 10 behaviour, and the Distributor expense, report and metrics tests pass as before.
- **`baby-expense`** (`_lib/baby-spending.js`): `budgets/current` plus `spendingMetrics`, from the tenant's own categories. It never writes sales, COGS, profit, `financialMetrics` or report rollups.
- Any other workspace has no profile, so expenses are refused (`not-available`).

`shared/expenses.js` `EXPENSE_PROFILES` holds each profile's category rule (`fixed` or `tenant`) and its extra fields (Baby adds `providerId`).

### Budget model (Luna computes; nobody types Spent)
- **The overall figures:** `Remaining = Budget − Spent` and `Category remaining = Category budget − Category spent` (`shared/baby.js` `budgetSummary` / `budgetLines`). They are computed on read and never stored or sent by the browser.
- **The running totals** on `budgets/current` (`spent`, `expenseCount`, `spentByCategory`, `upcoming`, `upcomingCount`, `upcomingByCategory`) are moved by the server in the same transaction as the record.
- **A budget change** (Edit → Save) is not spending. It records previous → new, who and when on the budget history, for example "Budget changed ₱150,000 → ₱180,000".
- **Categories** are tenant data: name, active/inactive, an optional budget allocation, and an order. "Add suggested categories" offers the list once (Medical, Nursery / Furniture, …). A category that any expense or payment has used (`useCount`) can't be deleted, only deactivated. Names are unique, and there are at most 50.

### Providers
A small Baby directory. It is not Distributor Customers and not Bridal suppliers. An expense or payment linked to a provider keeps the provider's name as its payee snapshot, so history reads as it was paid after a rename or deactivation. A deactivated provider can't be used for new records.

### Payment Schedule → exactly one expense
- **Upcoming money is committed, not spent:** it counts in Upcoming only.
- **Mark paid** (paid date ≤ today, method, reference, actual amount) runs in one transaction:
  - It reads the payment.
  - If the payment is already Paid, it returns the existing expense (a retry or a second click).
  - Otherwise it creates the expense with a **deterministic id** (the payment id, or `<id>r<n>` after a reopen) using `create()`. The payment leaves Upcoming in the same `budgets/current` write that adds the spending.
  - If a racing request already created that id, the call answers with that payment's expense.
- **Removing a paid payment's expense** puts the payment back to Upcoming. Editing that expense's amount updates the payment's paid amount. A Paid payment can't be cancelled.
- **Statuses** use stable ids (`upcoming`, `paid`, `cancelled`); labels are display text only.

### Dashboard, filters, exports, notifications
- **Baby Dashboard:** it reads no Distributor metric.
  - **"Spending in the selected period"** comes from `spendingMetrics` day/month documents, summed by the Phase 12.5 range planner (Today, Yesterday, This week, This month, Last month, Custom; business timezone).
  - **"Current budget · as of now"** comes from `budgets/current`: Total budget, Total spent, Remaining, Upcoming. No historical budget is stored, so a past period never shows a "remaining then".
  - **Lists:** Spending by category, Upcoming payments, Recent expenses.
  - Templates may now name their sections (`dashboard.sectionLabels`).
- **Filters** use indexed list specs shared by the screen and the export (`shared/list-queries.js`):
  - Baby Expenses: date range, category, provider, method, search
  - Providers: status, type, name prefix
  - Payment Schedule: status, due-date range, category, provider
  - Budget: category, status
  - New composite indexes cover each combination; nothing scans.
- **Excel**, through the Export Core (`_lib/exports/baby.js`). The datasets are Budget, Baby Expenses, Providers and Payment Schedule.
  - The descriptors' `workspaces` field keeps Baby datasets Baby-only and the Distributor `expenses` dataset Distributor-only.
  - The Dashboard workbook adds Category Budget, Expenses (selected period) and Upcoming Payments sheets, and calls its current sheet "Current budget".
  - No Distributor field appears.
- **Notifications:** `budget.threshold` (category `budget`, optional) fires at 75%, 90% and 100% of the overall budget. It fires once per level per budget episode (a total-budget change starts a new episode), crossing upward only, and the Notifications Core dedupes by id. Due-date reminders are deferred (no scheduler); the dashboard list is the MVP.

### Concurrency (real emulator, `tests/emulator/baby-concurrency.test.js`)
Every Baby write (expense, category, budget, schedule) reads and writes `budgets/current`, so a family's spending writes serialize. A category being deleted and an expense starting to use it both touch the category document. After each race, the totals equal a fresh sum of the records, and every Paid payment has exactly one expense. The races tested:
- 20 expenses at once
- two users editing one expense (one wins, the other is told it's stale)
- edits and removals racing budget changes
- Mark paid ×10 at once, and by two users
- Mark paid racing Cancel
- removing the paid expense racing a second Mark paid
- a provider deactivated while expenses are recorded
- a category deleted while an expense uses it

### Staged rollout
1. **Compatible step: deployed and verified (2026-10-09), commit `cc0fcef`.**
   - `budget`, `schedule` and `providers` were in `ROLLING_OUT_MODULE_IDS`, read in both rule files with `m.get(…, false)`, and the template accepted v1 and v2.
   - Rules and 14 new indexes were deployed (60/60 READY, deployed rules equal to the source), and the code was pushed (CI green, Netlify live from git).
   - `seed-plans --overwrite` added only the three module keys to each plan. `recompute-entitlements --all` added them as `false` to every Distributor and Household snapshot. `resync-permissions --all` gave Owners and Managers the six Baby keys, Staff none.
   - `demo-baby-a` (baby-expense v2) was created as the Baby staging tenant.
   - A live probe passed 136/136: the budget maths, edit and remove, categories, provider snapshots, Payment Schedule idempotency (repeat and concurrent), the 75/90/100% alerts, the dashboard period vs current split, filtered Excel, isolation, and the Distributor expense regression. The regression probes were green; Imports commits were blocked only by the demo tenants' exhausted monthly quota.
2. **Strict step (this commit).**
   - `ROLLING_OUT_MODULE_IDS` is empty again. Every snapshot of every template must carry `budget`, `schedule` and `providers` as booleans (`requiredModuleIds()`, `m.budget is bool` in both rule files, and the shared validator).
   - `baby-expense` accepts **v2 only** (no `upgradingFrom`). v1, missing, unknown or string versions, and a missing or non-boolean Baby key fail closed in the validator, the server (503) and both rule files. Baby modules forged into Distributor, Household or Bridal snapshots open nothing.
   - Before deploying, every staging snapshot was checked against the strict validator (all 6 pass). Deploy order: the strict rules first (they only fail more closed), then the same commit pushed to Netlify.

### Not built (later)
- Medical records of any kind, and medical advice
- Accounting, tax, bank or card sync, Google Sheets sync, custom fields
- Milestones and Baby reports (still planned)
- Scheduled due-date reminders
- Family role templates
- Per-period budget history (budget snapshots)

## Bridal / Wedding Command Center (Phase 16)

The `bridal-expense` template goes v1 → v2 (live). It organizes the operational side of a wedding: budget, expenses, suppliers and their balances, supplier payments and due dates, tasks, and guests / RSVP. It is not project management and not accounting.

| Module | Screen | Data (`businesses/{bid}/…`) | Permissions |
|---|---|---|---|
| `budget` (shared primitive) | Wedding Budget | `budgets/current`, `expenseCategories/{id}`, `spendingMetrics/{day or month}` (shared with Baby; each business has its own) | `budget.view`, `budget.manage` |
| `expenses` (reused) | Wedding Expenses | `expenses/{id}`: the Expenses Core record with a tenant category, an optional `supplierId` (the payee is the supplier's name snapshot) and the server-set `supplierPaymentId` | `expenses.view / create / update / delete` |
| `vendors` | Wedding Suppliers | `weddingSuppliers/{id}`: name, service, contact, optional agreed amount, default budget category; Luna's `paid`, `upcoming`, `upcomingCount`, `nextDue` | `vendors.view`, `vendors.manage` |
| `vendorpayments` | Supplier Payments | `supplierPayments/{id}`: Upcoming → Paid (one linked Wedding Expense) or Cancelled | `vendorpayments.view`, `vendorpayments.manage` |
| `tasks` | Wedding Tasks | `weddingTasks/{id}`, `taskTotals/current` | `tasks.view`, `tasks.manage` |
| `guests` | Guests & RSVP | `guests/{id}`, `guestTotals/current` | `guests.view`, `guests.manage` |

- **Module ids:** `suppliers` already names the Distributor's planned module, a different domain. So the Wedding Suppliers module id is `vendors`, and its labels are wedding words.
- **RSVP:** part of the Guests module. RSVP is a guest's answer, so one screen keeps the guest and their RSVP together.
- **Roles:** Owner and Manager get every Wedding permission. Staff get none: no Bridal staff workflow was needed, and no family or coordinator roles were added.
- **Mark paid** also needs `expenses.create`.
- **Workspace ceiling:** the template is the ceiling. Distributor, Household and Baby never get `vendors`, `vendorpayments`, `tasks` or `guests`, and forged keys open nothing in the server, the browser or the rules.

### Reuse and boundaries
- **Expenses Core:** the shared record engine is unchanged. `EXPENSE_PROFILES` now names each profile's optional saved payee (`ref`: Baby `providerId`, Bridal `supplierId`) and its server-set provenance (`link`: Baby `scheduleId`, Bridal `supplierPaymentId`). Baby and Distributor behaviour is identical; their tests pass as before.
  - Bridal has its own sink (`_lib/wedding-spending.js`). It never writes Distributor metrics, report rollups or anything of Baby's.
- **Budget primitive:** `/api/budget` (total and categories) and `shared/baby.js` `budgetSummary` / `budgetLines` serve both workspaces. The only workspace-specific part is the suggested-categories list (Venue, Ceremony / Church, Catering, …).
- **Phase 15 code:** the Baby screens, sink and builders are not modified. Bridal has its own screens, export builders and HTTP handler, and imports only Baby's generic helpers.
- **Separate domains:** a Wedding Supplier is not a Baby Provider or a Distributor Customer. A Supplier Payment is not a Distributor Payment. A guest is not a customer.

### Suppliers, agreed amounts and balances (Luna computes; nobody types Paid or Balance)
- **Paid** is the supplier's active Wedding Expenses: from a supplier payment, or recorded directly against the supplier. One source of truth.
- **Balance** = agreed − paid, and only with an agreement. A supplier without an agreed amount is contact tracking only.
- **Dashboard supplier balance** = `contracted − contractedPaid` on `budgets/current`, over all suppliers with an agreement (active or not).
- **Agreed-amount policy** (deterministic, tested):
  - A supplier with an agreed amount can't be paid more than it: the wedding sink refuses (`over-agreed`).
  - Paid + scheduled can't exceed it either: a schedule or edit is refused.
  - The agreed amount can't be lowered below what's committed (`below-committed`).
  - To pay more, raise the agreement first. That change is audited ("Agreed amount changed ₱80,000 → ₱90,000").
- **Renaming or deactivating** a supplier rewrites no history: expenses and payments keep the name they were recorded with. A payment scheduled before deactivation can still be paid.

### Supplier Payments → exactly one Wedding Expense
Upcoming ≠ Spent. Mark paid runs in one transaction:
- It reads the payment and returns the existing expense if the payment is already Paid.
- Otherwise it creates the expense with a deterministic id (the payment id, or `<id>r<n>` after a reopen) using `create()`.
- The payment leaves Upcoming, budget spending and the supplier's paid amount go up once, and the supplier's upcoming and next due follow.
- If a racing request already created that id, the call answers with that payment's expense.

Removing the generated expense puts the payment back to Upcoming. Editing its amount updates the payment's paid amount and the supplier's total, and its supplier can't change. The `supplierpayment.paid` notification goes to the other members who follow supplier payments.

### Tasks
- **Status:** Not Started / In Progress / Completed / Cancelled.
- **Completing** records the completed date and who. Reopening is logged ("Status changed Completed → In Progress (reopened)").
- **Overdue and due soon** (within 7 days) are derived from the due date, the status and the business's today. They are never stored. The Overdue Tasks card is a live count query.
- **Category and assignee** are free text, stored with a normalized key for filtering, so no names are hard-coded. Assignees needn't be Luna users. Linking a task to a member is future work.

### Guests and RSVP
- **Fields:** guest or household, group, side (bride / groom / both), contact, invited party size, invitation sent date, RSVP (`awaiting` / `attending` / `declined`), confirmed attendees.
- **RSVP rules:** confirmed must be at most the party size. Attending needs at least 1. Declined and awaiting mean 0.
- **Totals:** `guestTotals/current` keeps invitations (records) and seats (people) apart. **Confirmed guests = the sum of confirmed attendees**, not a count of Attending records. The cards are labelled accordingly.
- **Removing** a guest (added by mistake) writes an audit-log line, and the totals drop their party.

### Dashboard, filters, exports, notifications
- **Wedding Dashboard:**
  - **"Spending in the selected period"**: wedding spending, paid to suppliers and expenses recorded, from `spendingMetrics`.
  - **"Wedding plan · as of now"**: total budget, spent, remaining, supplier balance, upcoming payments, open tasks, overdue tasks (live count), confirmed guests (people) and awaiting RSVP (invitations). No historical RSVP or balance snapshot is implied.
  - **Lists:** upcoming supplier payments, tasks due soon and overdue, recent wedding expenses, an RSVP summary.
  - Dashboards gained a `count` source: live count queries against today, read with the documents.
- **Filters** use indexed list specs shared by screen and export. Every combination has a composite index (44 new), checked by a script that derives each query's index.
  - Wedding Expenses: dates, category, supplier, method, search
  - Suppliers: status, service, name prefix
  - Supplier Payments: status, supplier, category, due range
  - Tasks: open / overdue / all, status, category, assignee, priority, due range
  - Guests: RSVP, side, invitation sent / not sent, name prefix
- **Excel** goes through the Export Core: Wedding Budget, Wedding Expenses, Wedding Suppliers (with paid, balance and next due), Supplier Payments, Wedding Tasks (with derived timing) and Guests & RSVP.
  - The Dashboard workbook adds Category Budget, Expenses, Supplier Balances, Upcoming Payments, Tasks and Guests & RSVP sheets.
  - The datasets are Bridal-only, and no Distributor or Baby field appears.
- **Notifications:**
  - `supplierpayment.paid` (category `wedding`).
  - `budget.threshold`, reused, with wedding titles (75/90/100%).
  - Due-date and RSVP-deadline reminders are deferred (no scheduler); the dashboard lists cover upcoming items.

### Concurrency (real emulator, `tests/emulator/wedding-concurrency.test.js`)
Supplier, payment and expense writes all read and write `budgets/current` and the supplier, task writes `taskTotals/current`, and guest writes `guestTotals/current`. So they serialize per business. After each race, every stored total equals a fresh recount. The races tested:
- Mark paid ×10, and by two users
- the agreed amount lowered while payments are being recorded
- removal racing re-payment and a cancel
- schedule, edit, cancel and pay at once
- expenses racing budget changes
- completing and reopening the same task
- concurrent RSVP edits, size edits, an addition and a removal

### Staged rollout
1. **Compatible step: deployed and verified (2026-10-10), commit `ff7e029`.**
   - `vendors`, `vendorpayments`, `tasks` and `guests` were in `ROLLING_OUT_MODULE_IDS`, read with `m.get(…, false)` in both rule files, and the template accepted v1 and v2.
   - Rules and the 44 new indexes were deployed (104/104 READY, deployed rules equal to the source). An index check confirmed all 44 are needed by supported filter combinations, with no duplicates. The code was pushed (CI green, Netlify live from git).
   - `seed-plans --overwrite` added only the four module keys to each plan. `recompute-entitlements --all` added them as `false` to every Distributor, Household and Baby snapshot. `resync-permissions --all` gave Owners and Managers the eight Wedding keys, Staff none.
   - `demo-bridal-a` (bridal-expense v2) was created as the Wedding staging tenant.
   - A live probe passed 139/139. It covered the budget, the supplier agreement, payments (repeat and concurrent), direct expenses as the source of truth for supplier paid, the agreement and overpayment protection, supplier snapshots, RSVP people counts, tasks with derived overdue, the dashboard period vs current split, filtered Excel past one page, notifications, isolation, and the Distributor / Baby / Household regressions. The regression probes were green; Imports commits were blocked only by the demo tenants' exhausted monthly quota.
2. **Strict step (this commit).**
   - `ROLLING_OUT_MODULE_IDS` is empty again. Every snapshot of every template must carry `vendors`, `vendorpayments`, `tasks` and `guests` as booleans (`requiredModuleIds()`, `m.<key> is bool` in both rule files, and the shared validator).
   - `bridal-expense` accepts **v2 only** (no `upgradingFrom`). v1, missing, unknown or string versions, and a missing or non-boolean Wedding key fail closed in the validator, the server (503) and both rule files. Wedding modules forged into Distributor, Household or Baby snapshots open nothing.
   - Before deploying, every staging snapshot was checked against the strict validator (all 7 pass). Deploy order: the strict rules first (they only fail more closed), then the same commit pushed to Netlify.

### Not built (later)
- A wedding website, invitation sending, QR invitations, a seating chart or floor plan, a gift registry, honeymoon planning, a photo gallery, chat, a supplier marketplace, a payment gateway, accounting, an AI planner, workflow builders
- Wedding reports beyond the dashboard and Excel
- Due-date and RSVP reminders (no scheduler)
- Member-linked task assignment
- Dietary notes and table numbers

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
12. Imports ✅
12.5. Dashboard filters + Excel Export Core ✅
13. Notifications ✅
14. Household / Kasambahay Payroll MVP ✅ (the household-payroll workspace)
15. Baby Expense Tracker MVP ✅ (the baby-expense workspace)
16. Bridal / Wedding Command Center MVP ✅ (the bridal-expense workspace)
17. Super Admin console
18. Usage metering views
19. Reliability, backups and recovery

- Phases 6 and 7 are in this order because orders need products to reserve and a cost to snapshot.
- Expenses come before Reports so the P&L has operating expenses to subtract.
- Expenses don't depend on Customers, so Phases 9 and 10 could swap if that helps.
