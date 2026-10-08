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
  products/{id}                   stockOnHand, reserved, available, reorderLevel, isLowStock
  inventoryTransactions/{id}      append-only stock movements
  customers/{id}  orders/{id}  payments/{id}  paymentRefs/{method_ref}
  counters/{name}  metrics/{YYYY-MM-DD}  usage/{YYYY-MM}
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
| `customers` | customers | `customers.view` |
| `orders` | orders | `orders.view` |
| `payments` | payments | `payments.view` |
| `metrics` | dashboard (core) | `dashboard.view` |
| `reports` | reports | `reports.view` |
| `settings` | settings (core) | `settings.view` |
| `imports`, `imports/*/rows` | imports | `imports.run` |

This mapping lives in `shared/modules.js` (`collections`, `storage`). The rules keep their own copy, and `tests/shared/rules-registry.test.js` fails if the two drift.

Server-only, never readable from the browser: `users`, `plans`, `platformAudit`, `paymentRefs`, `counters`, `usage`, `auditLog`, `integrations`, `members/*/inbox`, and every collection-group query. The inbox `readAt` write is deferred to Phase 12.

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

`GET /api/reports` is a guard-only endpoint (501 when authorized) that exercises the Reports gate until Phase 10.

## Subscription states

| Status | Access |
|---|---|
| active | full |
| past_due | full + warning banner (grace period) |
| suspended | read-only |
| cancelled | owner only, export only |
| unknown | deny all |

Data is never deleted automatically because of non-payment.

## Inventory

- Order created: reserve stock.
- Order fulfilled or completed: deduct on-hand stock and release the reservation.
- Order cancelled: release the reservation.
- Receipts, adjustments and opening balances: change on-hand stock, with a required reason.

Every change writes an append-only `inventoryTransactions` record inside the same transaction as the stock change.

## Performance

- The dashboard reads the `metrics/{today}` document, which the server updates with atomic increments, plus a capped "recent orders" query and the `isLowStock == true` query.
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

## Build phases

1. Foundation ✅
2. Auth and multi-tenant business/user model ✅
3. Rules and tenant-isolation tests ✅
4. Plans, modules, permissions ✅
5. Dashboard and metrics
6. Products and inventory
7. Orders
8. Payments
9. Customers
10. Reports
11. Imports
12. Notifications
13. Super Admin console
14. Usage metering views
15. Reliability, backups and recovery

Phases 6 and 7 are in this order because orders need products to reserve.
