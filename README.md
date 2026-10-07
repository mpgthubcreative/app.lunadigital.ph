# Luna Business OS

Multi-tenant business operations platform: orders, payments, inventory,
customers and reports for businesses that take orders via Messenger,
Facebook, Viber, phone and walk-ins.

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Requirements

- Node 22+
- Firebase CLI (`npm i -g firebase-tools`) and **Java 21+** for the Firestore/Storage emulators
- Netlify CLI (`npm i -g netlify-cli`) for running functions locally

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Vite dev server (UI only) on :5173 |
| `npm run netlify:dev` | UI + Netlify Functions + `/api/*` redirects on :8888 |
| `npm test` | Unit and DOM tests (Vitest) |
| `npm run build` | Production build to `dist/` |
| `npm run emulators` | Firebase Auth/Firestore/Storage emulators (project `demo-luna`, UI on :4000) |

Copy `.env.example` to `.env.local` and fill in values when connecting to a
real Firebase project. Never commit secrets.

## Layout

```
index.html              tenant app entry
console/index.html      Luna Super Admin entry
src/app/                session, shell, router
src/modules/<module>/   one lazily-loaded folder per module
src/components/         reusable UI (escape-by-default)
src/lib/                html templating, api client, firebase, formatting
src/styles/             design tokens, base, layout, components
src/console/            Super Admin app
shared/                 permissions, modules, plans, entitlements, subscription (browser + server)
netlify/functions/      API endpoints; _lib/ holds server helpers
tests/                  Vitest suites
```

## Status

Phase 1 (foundation). There is no sign-in yet; the app runs a labelled
preview session with no business data. Firestore and Storage rules deny all access.
