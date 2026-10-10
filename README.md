# Luna Business OS

Multi-tenant business operations platform: orders, payments, inventory,
customers and reports for businesses that take orders via Messenger,
Facebook, Viber, phone and walk-ins.

Architecture and environments: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

> **Staging (`luna-business-os`, https://luna-business-os.netlify.app) holds fake demo data only.**

## Requirements

- Node 22+
- Firebase CLI (`npm i -g firebase-tools`). **Java 21+** is needed for the Firestore emulator.
- Netlify CLI (`npm i -g netlify-cli`)
- `.env.local`, copied from `.env.example` (gitignored)

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (UI only) on :5173 |
| `npm run netlify:dev` | UI + Netlify Functions + `/api/*` on :8888 (reads `.env.local`) |
| `npm test` | Unit and DOM tests (Vitest) |
| `npm run test:rules` | Tenant-isolation security suite on the Firestore + Storage emulators (needs Java 21+) |
| `npm run test:all` | Both of the above |
| `npm run build` | Production build to `dist/` |
| `npm run emulators` | Firebase emulators (offline `demo-luna` project) |
| `npm run deploy:rules:staging` | Run the security suite, then deploy Firestore rules and indexes to **staging** |

### Operator scripts

Every script prints its target and refuses to write without `--confirm <projectId>`.

| Command | What it does |
|---|---|
| `npm run seed:plans -- --confirm <projectId>` | Seed `plans/` from `shared/plans.seed.js` (keeps edited plans) |
| `npm run create-business -- --id <slug> --name "…" --plan growth --template distributor --owner-email … --owner-name "…" --confirm <projectId>` | Onboard a business and its owner: the same retry-safe workflow as the Super Admin console (prints a password-setup link for a new owner). `--id` and `--template` are required |
| `npm run set-operator -- --email … --reason "…" [--status active|disabled] [--create-account] [--send-password-email] --confirm <projectId>` | Grant or disable Luna Super Admin (console) access. `--create-account` creates the Luna account if missing (no password, no business); `--send-password-email` has Firebase email a password-setup link. Then sign in at `<SITE_URL>/console` |
| `npm run set-template -- --business <id> --template <id> --reason "…" [--change-template] --confirm <projectId>` | Assign a workspace template, or change one (needs `--change-template`); recomputes entitlements; audited |
| `npm run migrate-workspaces -- --template distributor --reason "…" [--dry-run] --confirm <projectId>` | Phase 8.5 one-off: give every pre-8.5 business an explicit template, then verify all snapshots |
| `npm run rebuild-report-rollups -- (--business <id> | --all) [--dry-run] --confirm <projectId>` | Recompute the server-only report breakdowns (products, customers, payment methods, expense categories) from source records; run while quiet |
| `npm run add-member -- --business <id> --email … --name "…" --role manager\|staff --confirm <projectId>` | Add a team member (enforces the plan's user limit) |
| `npm run set-member-status -- --business <id> --email … --status active\|disabled --confirm <projectId>` | Enable or disable a membership (the owner is protected) |
| `npm run set-plan -- --business <id> --plan starter\|growth\|pro --reason "…" --confirm <projectId>` | Assign or change a plan; recomputes entitlements; audited |
| `npm run set-overrides -- --business <id> [--modules reports=false] [--limits users=3] [--features googleSheets=true] [--clear-modules reports] --reason "…" --confirm <projectId>` | Per-business overrides (validated); recomputes; audited |
| `npm run recompute-entitlements -- (--business <id> \| --all) --confirm <projectId>` | Rebuild entitlement snapshots from plan + overrides; audited |
| `npm run show-entitlements -- --business <id>` | Read-only: stored snapshot, validity, and what a recompute would change |
| `npm run resync-permissions -- (--business <id> \| --all) --confirm <projectId>` | Re-resolve members' permission maps from template + overrides (after new permission keys); audited |
| `npm run seed:demo -- --confirm <projectId>` | Fake demo tenants and users. Refuses production. Passwords go to `.demo-credentials.local.md` |
| `npm run smoke:staging -- [baseUrl]` | End-to-end sign-in and `/api/session` checks with the demo accounts |

## Layout

```
index.html, console/index.html   tenant app and Super Admin entries
src/app/          auth, session, shell, router, login/access screens
src/modules/      one lazily-loaded folder per module
src/components/   reusable UI (escape-by-default)
src/lib/          html templating, api client, firebase, formatting
shared/           permissions, modules, plans, entitlements, subscription, tenancy, environment
netlify/functions/ session.js, health.js; _lib/ = auth, tenant, tenant-db, provisioning, usage
scripts/          operator CLI (provisioning, demo seed, smoke test)
tests/            Vitest suites; tests/rules/ = emulator security suite (vitest.rules.config.js)
```
