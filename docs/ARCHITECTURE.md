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
  imports/{id}/rows/{n}  auditLog/{id}  settings/{section}  integrations/{provider}
```

## Identity, roles and permissions

- Firebase Auth uses email and password. The only custom claim is `platformAdmin`, which is set by a CLI script.
- Membership documents are the source of truth for tenant access, so revoking access takes effect immediately.
- **Roles are permission templates only** (`shared/permissions.js`). The initial templates are Owner, Manager / Admin and Staff. Code checks permission keys and never role names. New roles such as Warehouse, Sales or Finance are new template entries.
- `isAccountOwner` on the member record (not the role name) protects the business's owner account from being demoted or removed by other users.
- Super Admin has no access to tenant data through the rules. Support access goes through an audited, time-limited server path.

## Plans, modules, entitlements

- Effective entitlements = the plan stored in Firestore + per-business overrides. They are computed by `shared/entitlements.js` on the server and saved as a snapshot on the business document.
- A module appears in navigation only when it is built, entitled for the business, and the user holds its view permission (`resolveNavigation`).
- Initial plans: Starter ₱4,990 + ₱990/mo · Growth (recommended) ₱9,990 + ₱1,990/mo · Pro ₱19,990+ + ₱2,990+/mo. These are seed values, not final, and are stored in centavos.

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
2. Auth and multi-tenant business/user model
3. Rules and tenant-isolation tests
4. Plans, modules, permissions
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
