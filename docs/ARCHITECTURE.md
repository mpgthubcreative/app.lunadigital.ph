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

In Storage, `tenants/{bid}/{products|payments|imports|exports}/**` belongs to the inventory, payments, imports and reports modules, and is readable with `inventory.view`, `payments.view`, `imports.run` and `reports.export` respectively. It uses the same membership, subscription and entitlement checks through cross-service Firestore reads. To keep it to two document reads, Storage skips the plan-existence check. Everything else is denied, and there are no browser uploads. Staging has no bucket yet, so these rules are emulator-verified but not deployed.

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

**Effective entitlements** = the plan + per-business `moduleOverrides`, `limitOverrides` and `featureOverrides`, computed by `computeEntitlements`. Overrides are strict: exact booleans, non-negative integers, values from the feature definitions, and no unknown keys or core modules. The snapshot is stored at `businesses/{bid}.entitlements`:

```
{ schemaVersion: 1, planId, planName,
  modules  { every MODULE_ID: boolean },
  limits   { users, ordersPerMonth, storageBytes, importsPerMonth: int >= 0 },
  features { reportsLevel, inAppNotifications, pushNotifications, googleSheets,
             advancedPermissions, workflowCustomization, support },
  computedAt }
```

**Fail closed.** `validateEntitlementsSnapshot` on the server and the same checks in the rules reject the snapshot when:

- it is missing
- `schemaVersion` is anything other than 1
- it was computed for a different plan than `subscription.planId` (stale)
- the plan document no longer exists
- any module, limit or feature is missing, unknown or mistyped

On the server this returns 503 `business-misconfigured`. In the rules, every module read is denied. Anything that counts members against the user limit also refuses to proceed rather than skipping the limit.

**Changes** go only through operator tooling, which is server-side and never reachable from the browser:

- `assignPlan`, `updateOverrides` and `refreshEntitlements` in `provisioning.js` each validate, recompute the snapshot in one transaction, and write the same audit record to `businesses/{bid}/auditLog` and `platformAudit`. Each change requires a reason.
- The CLI wrappers are `set-plan`, `set-overrides`, `recompute-entitlements` and the read-only `show-entitlements`. Writes need `--confirm <projectId>`.
- A downgrade below the active user count warns and removes nobody. Adding or re-enabling members is blocked until the business is back under the limit.

**Visibility.** `/api/session` returns the plan name, limits and usage only to members with `billing.view`. Everyone gets module switches and feature flags (for navigation). Settings shows the package only to `billing.view` holders.

`GET /api/reports` is a guard-only endpoint (501 when authorized) that exercises the Reports gate until Phase 11.

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
- Fulfilment is not payment: a fulfilled order stays unpaid until Phase 8.
- An order created yesterday and fulfilled today counts toward today's sales.

**Model** (`orders/{id}`, `shared/orders.js`):
- Identity: `orderNumber`, `orderDate` (business-local creation day), `source` (+ `sourceNote`, required for Other).
- Customer: `customer {name, phone, notes}` snapshot and `customerId: null` (Phase 9 will link it).
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

**Dashboard:** orders today, unpaid orders, for fulfilment, unpaid balance, net sales and gross profit are live, and recent orders is a live list. Widgets whose data producer doesn't exist yet stay "No data yet": operating expenses, estimated operating profit and paid today (`LIVE_DATA_SOURCES`).

**Scale note:** the counter, usage and `metrics/current` documents are shared by every order in a business. That's fine for SMB volumes; sharding is needed if a tenant sustains more than about one order per second.

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

## Expenses (module approved in Phase 5, built in Phase 10)

Expenses exist so an owner can answer "Magkano talaga kinita namin?", not to turn Luna into accounting software.

- **Registry:** `id: "expenses"`, sellable, `available: false` until Phase 10. That means no route, no browser-readable collection, and every access denied, even when entitled. It is on in every seeded plan, like the other operational modules.
- **Permissions:** `expenses.view`, `expenses.create`, `expenses.update` and `expenses.delete`. These are named `update`, not `edit`, to match `orders.update`. Owner and Manager templates have them; Staff does not.
- **Same access model as every module:** tenant isolation, membership, entitlement, permission and subscription.
- **Planned record** at `expenses/{id}` (`shared/expenses.js`):
  - core fields: `date` (business-local), `categoryId`, `amount` (centavos), `payee`
  - payment details: `paymentMethod`, `referenceNumber`
  - optional: `notes`, `recurring`, `receipt` (later)
  - `status`: `recorded` or `voided`. Delete means void, so the record stays for audit.
  - `createdBy`, `createdAt`, `updatedBy`, `updatedAt`
- **Metrics:** every change adjusts `financialMetrics/{date}.operatingExpenses` in the same transaction.
- **Categories:** configurable per business at `settings/expenseCategories`, seeded from `DEFAULT_EXPENSE_CATEGORIES`, with stable ids.
- **Not in scope:** receipts, tax, payroll and bank reconciliation are not planned for Phase 10.

**Profit and loss (Phase 11 Reports).** Revenue − COGS = Gross Profit − Operating Expenses = Estimated Operating Profit. Filters: today, week, month, custom range, expense category, and product/category where appropriate. It is read from the month and day rollups.

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
8. Payments
9. Customers
10. Expenses
11. Reports (incl. operating P&L)
12. Imports
13. Notifications
14. Super Admin console
15. Usage metering views
16. Reliability, backups and recovery

- Phases 6 and 7 are in this order because orders need products to reserve and a cost to snapshot.
- Expenses come before Reports so the P&L has operating expenses to subtract.
- Expenses don't depend on Customers, so Phases 9 and 10 could swap if that helps.
