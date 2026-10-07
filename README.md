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
| `npm run create-business -- --name "…" --plan growth --owner-email … --owner-name "…" --confirm <projectId>` | Onboard a business and its owner (prints a password-setup link) |
| `npm run add-member -- --business <id> --email … --name "…" --role manager\|staff --confirm <projectId>` | Add a team member (enforces the plan's user limit) |
| `npm run set-member-status -- --business <id> --email … --status active\|disabled --confirm <projectId>` | Enable or disable a membership (the owner is protected) |
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
