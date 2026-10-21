# Luna production migration plan

Prepared 2026-10-19. **Status: PLAN ONLY. Nothing here has been created or deployed.** Execution needs the owner's explicit approval, step by step.

- **Baseline:** the commit recorded under "Production migration baseline" in `docs/phase-18-6-progress.md` (the second 2026-10-21 baseline: mobile tabs, HEIC / HEIF photos and the Bridal invitation folders on top of the trial / Continue with Luna / Reset release; it supersedes every earlier baseline). CI must pass on it.
- **Locked behaviour:** these are not to change during migration except for real defects:
  - Download Excel (the Business workbook includes Customers again);
  - Master Backup (Super Admin only);
  - the hidden Excel import;
  - the simplified Business (Costs, Reports, Customers with Add order);
  - the final pricing model (one product per workspace with terms and add-ons, Luna Bridal Custom);
  - itemised bills (setup fee once, discounts / credits, the Bridal upgrade difference);
  - payment proof = screenshot OR reference.
- **Production setup notes from the 2026-10-20 work:**
  - Seed the plans (`seed:plans`) from the baseline: this is the new catalog.
  - The payment-screenshot reader (Tesseract) ships with every build under `/ocr/` (copied by `npm run build`'s prebuild step). The site's CSP keeps `'wasm-unsafe-eval'` and `worker-src 'self'` for it; nothing third-party is loaded.
- **Owner decisions (2026-10-19):**
  - production app domain `app.lunadigital.ph`; a new clean Singapore Firebase project;
  - the current US Firebase + Netlify stay permanently as staging;
  - no staging demo or test business is copied;
  - **no migration script for `veah-bridal` or `rwp-d419` yet**: decide separately after production is validated;
  - billing and payment details stay configurable (Super Admin console), never hard-coded;
  - backups, PITR, Storage recovery and a restore drill come before the first paying customer;
  - Super Admin two-step login is a separately evaluated security enhancement (Identity Platform cost and complexity);
  - production email comes from Luna's own domain through reliable transactional delivery (Resend SMTP for Firebase Auth emails).

## 1. Target

| | Staging / dev (permanent) | Production (new) |
|---|---|---|
| Firebase project | `luna-business-os` (Firestore us-east5, Storage us-west1) | **new project**, e.g. `luna-production` (id to choose; it can't be renamed later) |
| Firestore | `(default)`, us-east5 | `(default)`, **asia-southeast1 (Singapore)**, Native mode |
| Storage | `luna-business-os.firebasestorage.app`, us-west1 | default bucket `<prod-id>.firebasestorage.app`, **asia-southeast1** |
| Netlify site | `luna-business-os` (Free, functions in Ohio `cmh`) | **new site**, e.g. `luna-production` (Pro), functions region **Singapore** |
| Git branch that deploys | `main` (auto) | **`production`** (protected; deploys only after CI passes) |
| `LUNA_ENV` / `VITE_LUNA_ENV` | `staging` (shows the "Staging — demo data only" banner) | `production` (no banner; demo scripts refuse to run) |
| Data | fake / demo data | real customers only |

## 2. Firebase resources to recreate (production)

1. **Project:** create it (Google Cloud org/billing account: the owner's), link **Blaze**, and set a **budget with alerts** (e.g. 50/90/100% of a monthly cap).
2. **Firestore:** create the `(default)` database in **asia-southeast1**, Native mode, Standard edition.
   - Turn on **delete protection** (`gcloud firestore databases update --delete-protection`).
   - Turn on **PITR** (§10).
   - Region: Firestore has no Asia multi-region, so asia-southeast1 single-region is the Singapore option. The location can't be changed after creation.
3. **Rules and indexes from Git:**
   - `firebase deploy --only firestore:rules,firestore:indexes --project production` (125 composite indexes).
   - **Wait until every index is READY** before sending traffic; queries on missing indexes fail.
4. **TTL policies** (new; staging doesn't have them yet) on the fields that already carry an expiry date:
   - `storeThrottle.expireAt` (public menu abuse guard)
   - `activationLinks.expiresAt`, `receiptLinks.expiresAt`
   - import job and upload-reservation `expiresAt` (see `_lib/imports.js`, `_lib/storage-usage.js`)
   - Add them as `fieldOverrides` (`ttl: true`) in `firestore.indexes.json` so they live in Git (one small change, made before execution and tested on staging first).
5. **Storage:** create the default bucket in **asia-southeast1**.
   - Turn on **Object Versioning** and **Soft delete** (30 days); see §11.
   - Deploy rules: `firebase deploy --only storage --project production`.
   - **IAM (manual, required):** grant `roles/firebaserules.firestoreServiceAgent` to `service-<project-number>@gcp-sa-firebasestorage.iam.gserviceaccount.com`. The Storage rules read Firestore across services, and the Firebase CLI does not grant this role (it was granted by hand on staging on 2026-10-08).
6. **Auth:**
   - Enable the **Email/Password** provider only; no others are used.
   - Turn on **email enumeration protection** and set a **password policy** (minimum length, e.g. 10).
   - **Authorized domains:** the production app domain (e.g. `app.lunadigital.ph`) and the Netlify production URL. Remove `localhost`.
   - **Email templates** (password reset): sender name "Luna", and an action URL or continue URL on the production domain. See §6 for delivery.
   - **Note:** Firebase Auth user records aren't region-pinned. Only Firestore and Storage data live in Singapore.
   - **Optional (decide):** upgrading to **Identity Platform** adds MFA, recommended for the Super Admin account.
7. **Web app:** register one Web app and copy its config into the production `VITE_FIREBASE_*` values (§5).
8. **Service account for the server:**
   - Use a dedicated **production** Admin SDK key, never shared with staging. It goes only into the Netlify production site's secret env vars and a local `.env.production.local` used for operator scripts (gitignored; never printed).
   - Rotate it at go-live and document the rotation date.
9. **Not used (nothing to set up):** Cloud Functions, Hosting, App Check, Realtime Database, scheduled jobs. All server code runs on Netlify Functions.

## 3. Netlify production site

1. **New site** from the same repo (`mpgthubcreative/app.lunadigital.ph`). Production branch: **`production`**.
   - Turn off deploy previews and branch deploys for this site, so nothing on `main` reaches it.
2. **Plan: Pro.** The Free plan can't scope or hide env vars (staging lesson). Pro is also assumed for choosing the **functions region**: Singapore (`ap-southeast-1`), set in Site configuration → Functions. **Verify region availability on the chosen plan before buying.**
3. **Function timeouts:** the default is 10 s. Download Excel, Master Backup and report rebuilds are the heaviest. Measure them on production-sized data (§13) and request a longer timeout if needed.
4. **`netlify.toml` is shared** by both sites (redirects, CSP, headers). CSP needs a change only if a custom Auth domain is used (`frame-src`) (§9).
5. **Domain:** e.g. `app.lunadigital.ph` → production, HTTPS automatic, HSTS already in headers.
   - Staging keeps `luna-business-os.netlify.app`; optionally `staging.lunadigital.ph`.
   - **Decide** which domain goes where.
6. **Deploy gating:**
   - Branch protection on `production`: require the `ci / test` check (unit, build and emulator security suite); no direct pushes; merges come from `main` by PR.
   - This closes the known gap that Netlify deploys even when CI fails.

## 4. Release flow after go-live

1. Build and test on `main`; it deploys to **staging** automatically and is verified there.
2. Open a PR from `main` to `production`. CI must pass and the owner approves.
3. Merge, and Netlify builds the **production** site.
4. **Firebase-side changes run before the code that needs them:**
   - deploy rules and indexes, then wait for READY;
   - run `resync-permissions` / `recompute-entitlements` (with `--confirm <prod-id>`);
   - then merge the code. This is the zero-downtime order learned in Phase 6.
5. Every operator script needs `--confirm <projectId>` matching the env file, so a production run has to be typed deliberately.

## 5. Environment variables (production site)

Server (secret, Functions scope):

| Name | Value |
|---|---|
| `LUNA_ENV` | `production` |
| `FIREBASE_PROJECT_ID` | production project id |
| `FIREBASE_CLIENT_EMAIL` | production service account |
| `FIREBASE_PRIVATE_KEY` | production key (single line, `\n` escaped); **secret** |
| `FIREBASE_STORAGE_BUCKET` | `<prod-id>.firebasestorage.app` |
| `SITE_URL` | `https://app.lunadigital.ph` (password-setup continue links, console links) |

Browser (build scope; public by design):

| Name | Value |
|---|---|
| `VITE_LUNA_ENV` | `production` (hides the staging banner) |
| `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID` | production Web app config |
| `VITE_USE_EMULATORS` | `false` (or unset) |

- **Never set on production:** `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`.
- **API key restriction:** limit the production browser API key to HTTP referrers (the production domain and Netlify URL) and to the Identity Toolkit, Token Service and Firestore APIs.

## 6. Email (Resend)

Today **Luna sends no email of its own.** Resend appears only as a cost category in the Super Admin finance pages.

- Activation and password-setup links are generated by the server and shared by the Owner or Luna staff; there's no email delivery.
- **Forgot password** uses Firebase Auth's built-in email (`sendPasswordResetEmail`), which on staging sometimes didn't reach Gmail.

Recommended for production:

1. Verify the sending domain in Resend (`lunadigital.ph`, with SPF, DKIM and DMARC DNS records).
2. In Firebase Auth → Templates, set **custom SMTP** to Resend (`smtp.resend.com`, port 465, user `resend`, password = a Resend API key kept only in Firebase) and the sender to `no-reply@lunadigital.ph`. Firebase Auth emails then come from Luna's domain.
3. Product emails (invitations, receipts) aren't built. If added later, add `RESEND_API_KEY` as a Netlify secret.

## 7. Public routes (no sign-in) to verify on the production domain

All are origin-relative: they work on any domain and need no Firebase authorized-domain entry (they don't use Firebase Auth in the browser).

| Route | API | Notes |
|---|---|---|
| `/store/{slug}`: Business public menu / order link | `/api/store` | Rate limit uses Netlify's `x-nf-client-connection-ip` header; the `storeSlugs` + `storeThrottle` TTL policy is required (§2.4). Custom domains later = a host → business lookup. |
| `/w/{slug}/invite/{token}`, `/w/{slug}`, `/invite/{token}`: Bridal invitations | `/api/invite` | Tokens are stored hashed (`invitations`); `weddingSlugs` is top-level. |
| `/receipt?…`: helper salary receipt confirmation | `/api/receipt` | `receiptLinks` expire after 14 days. |
| `/activate`: set password from an activation link | `/api/activate` | `activationLinks`. |
| `/console`: Luna Super Admin (sign-in + operator record) | `/api/operator`, `/api/backup` | §8. |

## 8. Super Admin access

1. In production, create the operator with `npm run set-operator -- --email <owner> --confirm <prod-id>` using `.env.production.local`.
   - Set the password with Admin SDK `generatePasswordResetLink`, written to a local file and never printed, or with the reset email once SMTP works.
2. **Don't create** staging's test operator (`disabled.operator@luna.test`) or any `@luna.test` account in production.
3. Recommended: MFA for operators (needs Identity Platform, §2.6), and as few operators as possible.
4. The Master Backup (`/api/backup`) is Super Admin only and audited (business `auditLog` and `platformAudit`); keep it that way.

## 9. Clean production database: what to create (and nothing else)

| What | How | Notes |
|---|---|---|
| Plans (`plans/*`) | `npm run seed:plans` with `--confirm <prod-id>` | Plans come from `shared/plans.seed.js` in Git. Ask before running (same rule as staging). |
| Workspace templates, modules, permissions, terminology | nothing to create | they live in code (`shared/`); entitlement snapshots are computed at provisioning |
| Operator(s) (`operators/*`) | `set-operator` | §8 |
| Billing settings (`platform/billingSettings`: payment instructions shown to Owners) | Super Admin console | enter real payment details |
| Platform cost rates (`platformCostRates`) and platform expenses | Super Admin console | real rates only; staging values are estimates |
| Businesses | `create-business` script or the console "Create business" | one per real client; each Owner gets an activation link |
| Everything else (`users`, `platformMetrics`, `platformAudit`, `provisioning`, slugs, links, throttles) | created automatically by use | |

## 10. What must NOT be copied from staging

- **Nothing by default.** Staging holds fake and demo data and test accounts:
  - `demo-*` and `abc-test-trading` businesses;
  - all `@luna.test` users and the disabled operator;
  - `.demo-credentials.local.md`;
  - staging `platformMetrics`, `platformAudit`, invoices, subscription payments, platform expenses and cost rates;
  - `storeSlugs` / `weddingSlugs` (re-claimed in production), `storeThrottle`, receipt, activation and invite links;
  - every staging Storage file.
- **No Auth users** are exported.
- **The owner's own pilot data on staging (`veah-bridal`, `rwp-d419`): not migrated now, and no script is written yet** (owner decision 2026-10-19). Whether either deserves a one-time migration is decided separately, after production is validated.
  - If one is approved later, use a **per-tenant copy script**, written and run only with approval. It would:
    - copy `businesses/{bid}/**` keeping document ids, plus the business's `weddingSlugs` / `storeSlugs` entries and its Storage files under `tenants/{bid}/`;
    - re-create the members' Auth users in production with new activation links (no passwords copied);
    - not copy invitation tokens: guests get new links, or the copy keeps the hashed tokens if the old links must keep working (decide);
    - verify counts and totals against the source.
  - Alternatively, the owner re-enters them. **Decide per tenant.**
  - The Master Backup is a cross-check for that copy, not the copy itself.

## 11. Automatic backup, PITR and Storage recovery

Detail in `docs/BACKUP.md`. To configure at creation:

1. **Scheduled Firestore backups:**
   - `gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14w --project <prod-id>`
   - Optionally a weekly schedule kept 52 weeks.
2. **PITR:** `gcloud firestore databases update --database='(default)' --enable-pitr --project <prod-id>` (7 days, 1-minute granularity).
   - **Restore strategy:** restore (a PITR clone or a backup) **into a new database**, never over `(default)`.
   - Then copy back only the affected documents with an Admin SDK script (per tenant / per collection), check them, and record the incident in `platformAudit`.
   - A full cut-over to a restored database is the last resort; it needs a `FIREBASE_*` change on Netlify and a redeploy.
3. **Storage:**
   - Object Versioning on; soft delete 30 days.
   - Lifecycle: delete non-current versions after 90 days, and move them to Coldline after 30.
   - Restore one file = copy its non-current generation back (`gcloud storage cp gs://…#<generation> gs://…`).
4. **Config in Git:** rules, indexes (including TTL), functions and plans. Rebuilding configuration = deploying from Git.
5. **Optional long-term export:**
   - A monthly `gcloud firestore export gs://<prod-id>-exports/<date>` to a separate bucket in asia-southeast1, with a retention lock.
   - Triggered by Cloud Scheduler plus a Workflow (no app code).
6. **Restore drill before the first real client:**
   - Restore yesterday's backup into a scratch database and compare one tenant's counts.
   - Restore one proof file from a non-current version.
   - Time it and note it in `docs/BACKUP.md`.

## 12. Rollback plan

| Problem | Rollback |
|---|---|
| Bad code deploy | Netlify **instant rollback** to the previous production deploy (one click), then revert the PR on `production`. |
| Bad rules / indexes | Redeploy the previous `firestore.rules` / `storage.rules` from Git (`git checkout <good> -- firestore.rules` then `firebase deploy --only firestore:rules`). Index removals aren't urgent; leave extra indexes. |
| Bad data write (bug) | PITR restore into a new database, then copy back the affected documents (§11.2). |
| Launch itself fails (before real data) | Keep the production domain on a maintenance page, or point it back to nothing; staging is untouched; fix and retry. Nothing to restore. |
| Region / project mistake at creation | Delete the production project before any real data goes in and recreate it (the location is permanent). |

## 13. Staging and production separation

- **Separate everything:**
  - two Firebase projects, two Netlify sites;
  - two service-account keys, two Web API keys;
  - two env files: `.env.local` (staging) and `.env.production.local` (production, gitignored, created at execution).
- **Scripts:** `.firebaserc` gets a `production` alias; the default stays the offline `demo-luna`. Scripts refuse to write without `--confirm <projectId>`, and `seed-demo` / `smoke-session` refuse `LUNA_ENV=production`.
- **Banner:** only staging shows "Staging — demo data only".
- **Data:** fake data on staging only; real customer data on production only, never copied back to staging.
- **CI:** stays on the offline emulator project `demo-luna`; it never touches either cloud project.

## 14. Code and config to parameterize before migration

Nothing project-specific is hard-coded in application code: the Firebase config, project, bucket, site URL and environment all come from env vars (`shared/environment.js`, `src/lib/firebase.js`). Items to change or add:

1. `.firebaserc`: add `"production": "<prod-id>"`.
2. `package.json`:
   - add `deploy:rules:production` (`npm run test:rules && firebase deploy --only firestore:rules,firestore:indexes,storage --project production`);
   - make `deploy:rules:staging` include `storage` too (today it deploys Firestore only).
3. `firestore.indexes.json`: add the TTL `fieldOverrides` (§2.4).
4. `src/modules/wedding/setup.js` lines 94 and 131: fallback host and origin `app.lunadigital.ph`. Only used when `location` is missing (tests), but it should be the build's own origin or a `VITE_` value so staging never shows the production domain.
5. `netlify.toml` CSP:
   - `frame-src https://*.firebaseapp.com` covers the default Auth domain; add the custom domain if `VITE_FIREBASE_AUTH_DOMAIN` becomes `auth.lunadigital.ph`.
   - `img-src` / `connect-src` already cover `firebasestorage.googleapis.com` and `*.googleapis.com`.
6. Netlify-specific dependency: the public menu rate limit reads `x-nf-client-connection-ip` (fine on Netlify; note it if hosting ever changes).
7. Docs and comments that name `luna-business-os` (`scripts/_cli.js` example, docs, test comments): examples only; no change needed.
8. Branch protection and the `production` branch (GitHub settings, not code).
9. Netlify env vars on the production site (§5); none are shared with staging.

## 15. Production launch checklist

**Before creating anything**
- [ ] Owner approves this plan and the decisions:
  - project id; production domain; Netlify Pro; Identity Platform / MFA;
  - Resend SMTP; pilot tenants copy or re-entry; the payment details to show.
- [ ] §14 code and config changes made on `main`, CI passes, verified on staging (TTL policies included).

**Create (in this order)**
- [ ] Firebase project + Blaze + budget alerts.
- [ ] Firestore in asia-southeast1 + delete protection + PITR + backup schedule.
- [ ] Storage bucket in asia-southeast1 + versioning + soft delete + lifecycle + the IAM role for the Storage service agent.
- [ ] Auth: Email/Password, enumeration protection, password policy, authorized domains, templates, custom SMTP (Resend).
- [ ] Web app registered; API key restricted.
- [ ] Production service account key → Netlify secret env + local `.env.production.local`.
- [ ] Deploy Firestore rules, indexes (wait READY) and Storage rules from the baseline commit.
- [ ] Netlify production site (Pro) on branch `production`, functions in Singapore, env vars set, domain + HTTPS.
- [ ] Branch protection on `production` (require `ci / test`).
- [ ] `seed:plans` (approved), operator account, billing settings, cost rates.

**Verify (on production, with one throwaway test business, deleted afterwards)**
- [ ] `/api/health`, sign-in, `/api/session` shows `environment: production` and no staging banner.
- [ ] Rules: an anonymous user and another tenant are denied; Storage cross-service rules work (upload / read a proof).
- [ ] Each workspace end to end:
  - Business: order, payment, public menu `/store/{slug}`;
  - Household: payroll Review → Pay;
  - Bridal: invitation link and RSVP.
- [ ] Download Excel workbooks open; Master Backup refused to the Owner and allowed to Super Admin.
- [ ] Forgot-password email arrives (Resend SMTP).
- [ ] Function timings for exports are within the limit.
- [ ] Backup: the schedule produced its first backup; restore drill done (§11.6).
- [ ] Delete the test business, its Auth users and Storage files; production then contains only system configuration.

**Go live**
- [ ] Create the first real client (and migrate the pilot tenants if decided).
- [ ] Watch the first week: Netlify function errors, Firestore usage and budget, backup success.
