# Luna backup and recovery

Updated 2026-10-28 (status, wedding photo retention, the 2026-10-28 incident). First written 2026-10-25. `luna-business-os` becomes production in place (see [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md)).

## Current state (2026-10-25, read from the project)

| Protection | State | Decision |
|---|---|---|
| Firestore point-in-time recovery | OFF (version retention 1 hour) | Paid. The owner decides before cutover. |
| Scheduled Firestore backups | None | Paid. The owner decides before cutover. |
| Database delete protection | OFF | Left unchanged for now (owner decision). |
| Storage soft delete | 7 days (Google default); no object versioning | Keep 7 days for now. |
| Logical backup + restore (below) | Working, rehearsed | Used during the readiness phase. |

## Status for operations (2026-10-28)

| Protection | State |
|---|---|
| Firestore point-in-time recovery | **OFF** (paid; not enabled) |
| Scheduled Firestore backups | **OFF** (paid; not enabled) |
| Wedding photo retention | **ON** (2026-10-28): a replaced or removed cover / design / gallery photo is kept 30 days, server-only (below) |
| Storage soft delete | 7 days (Google default). It does **not** cover wedding photos: they are stored in Firestore, not Storage |
| Latest manual logical backup | 2026-10-25 (staging rehearsal, before the in-place cutover). None of production since |

Customers never see these settings.

## Wedding photos: where they live, and retention

- **Where:** a wedding's cover photo is a JPEG/PNG/WebP **data URL inside Firestore** (`businesses/{bid}/weddingSetup/hero`, up to ~700 KB); design photo slots are `weddingPhotos/{slot}` and gallery photos `weddingGallery/{id}` (up to ~400 KB each). There is no Storage file, signed URL or public bucket: the server reads the photo and puts it in the guest's invitation.
- **Before 2026-10-28:** replacing or removing a photo overwrote / deleted that document; with PITR and backups off, nothing could bring it back.
- **Now:** in the same transaction that replaces or removes a photo (also Reset invitation), the previous photo is copied to `businesses/{bid}/weddingPhotoHistory/{id}` (`kind`, `slot` / `photoId`, `dataUrl`, `reason`, `retainedAt`, `expiresAt` = +30 days). Rules deny it to every client. Copies past `expiresAt` are pruned on the business's next photo change. The guest's invitation switches at once; there is no customer-facing version history.
- **Restore (Luna ops):** `node --env-file=.env.local scripts/restore-wedding-photo.js --business <id>` lists what's kept; add `--id <historyId> --confirm luna-business-os` to put one back (the photo it replaces is kept in turn).
- **Cost:** one extra Firestore document (≤ ~0.7 MB) per photo change, for 30 days: effectively nothing at Luna's size.

## Incident 2026-10-28: a production smoke test deleted a couple's cover photo

- What happened: after the Bridal release, a smoke test saved a test cover photo on `yanie-bridal`, changed it and removed it. Its "no photo saved yet" check failed (the couple had uploaded their own photo after an earlier read-only audit), but the script only logged it and continued. Their photo was overwritten, then deleted. No copy existed (PITR off, no backup, photos not in Storage). The couple must upload it again; nothing was fabricated or rebuilt from screenshots.
- Also touched by that test, both test data and both cleaned up: one trial request (created, then deleted) and its daily rate-limit counter. An audit of every production document changed that day found nothing else from the test: guests, RSVP answers and links, invitation design, payments, bills, access, trial requests, Distributor and Household records were not touched.
- Fixes: photo retention (above); guardrails for production checks (below).

## Production checks that change data

- They run **only** in the dedicated test workspace `luna-smoke-bridal` ("Luna Smoke Test (internal)", `testWorkspace: true`, no members, a free trial, sample content, left out of Super Admin's Overview counts). Create or refresh it with `scripts/create-test-workspace.js --confirm luna-business-os`.
- `scripts/_prod-guard.js` enforces it: the id must start with `luna-smoke-` **and** the business must be marked `testWorkspace: true` (a real customer fails both); the `--destructive test-workspace-only` flag is required; `withRestore()` reads the current state, **stops before any write** if it isn't the expected starting state (reported as skipped/blocked), keeps the full original, runs, restores it exactly and verifies the restore.
- `scripts/prod-smoke-bridal.js` is read-only by default; with the flag it checks photo add / change / remove in the test workspace only.
- Never use a real customer's workspace (Carlo & Yanie, Veah Bridal, Distributor or Household customers) for a check that changes data.

## Paid PITR / scheduled backups: recommendation

Not necessary for this incident any more (wedding photos are now retained 30 days at no real cost). Still worth turning on **before the first paying customers depend on Luna**: they protect every other record (guests, orders, payroll, payments) from accidental writes, which photo retention doesn't. Until then, take a manual logical backup (below) before any risky production operation.

## Logical backup and restore (in the repo, no extra cost or IAM)

```sh
# Back up everything (read-only): firestore.jsonl + files/ + manifest.json (counts, SHA-256)
node --env-file=.env.local scripts/backup-firestore.js --out <dir> --files      # or --business <id>
# Restore (dry run unless --execute; never deletes; keeps existing documents unless --overwrite):
node --env-file=.env.local scripts/restore-firestore.js --from <dir> [--business <id>] [--files] --execute --confirm luna-business-os
```

Keep backups outside the repo (they hold customer data) and off shared drives.

Auth accounts are not in this backup. Export them with `npx firebase auth:export auth.json --project staging`. The file holds password hashes: store it like a secret. Import with `auth:import`, using the hash parameters from Firebase Console → Authentication → ⋯ → Password hash parameters.

**Rehearsal, 2026-10-25** (staging → empty emulator):
- Full backup of staging: 756 documents and 3 files in 178 s.
- Restore: 756/756 documents read back identical; 3/3 files.
- Running the restore again wrote nothing.
- A backup of the restored copy matches the original (same documents and content; the line order differs because subcollections are read in parallel).
- One business (`veah-bridal`) deleted by accident, then restored alone: 57/57 identical.

## The rule

- **Customers download clean Excel files.** In every workspace, More → **Download Excel** (`/api/workbook`) gives one readable workbook: a sheet per list, ₱ amounts as numbers, real dates, no ids or JSON. Customers never manage technical backups.
- **Luna keeps the technical recovery copy itself.** It is made automatically on the server, not by Luna staff downloading each customer's files.

## Layers

| Layer | What it protects | How | Where it's configured |
|---|---|---|---|
| 1. Scheduled Firestore backups | Every tenant's records (`businesses/**`, top-level collections) | Firestore **managed backup schedules**: daily, kept 14 weeks (`gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=14w`) | GCP project (production), Phase 19 |
| 2. Point-in-time recovery (PITR) | Accidental writes or deletes in the last 7 days | `gcloud firestore databases update --database='(default)' --enable-pitr`; restore to a new database, then copy the affected documents back | GCP project, Phase 19 |
| 3. Storage protection | Receipts, payment proofs, Bridal photos and assets (`tenants/{bid}/**`) | **Object versioning** plus **soft delete** (e.g. 30 days) on the bucket; optionally a lifecycle rule that moves non-current versions to Coldline | GCS bucket settings, Phase 19 |
| 4. Configuration in Git | Rules, indexes, functions, plans | `firestore.rules`, `firestore.indexes.json`, `storage.rules`, `netlify/functions/**`, `shared/plans.seed.js` are in this repository; deploying them rebuilds the configuration | Repo (done) |
| 5. Long-term export (optional) | Recovery beyond the backup retention; project or provider transfer | Scheduled `gcloud firestore export gs://<backup-bucket>/<date>` (Cloud Scheduler, then a Workflow or Cloud Run job) into a separate bucket with its own lifecycle and retention lock | Phase 19, if needed |

## Master Backup (internal)

- `/api/backup` builds one technical workbook per business: every record, with removed, voided and inactive ones included, plus Users and the Audit log.
- It's used for support, audits and investigations, for migrating a single tenant, and as a readable cross-check after a restore.
- **Access:** Luna Super Admin only (`requireOperator`: a verified ID token plus an active `operators/{uid}` record). The button is on the Luna console's business page. A tenant Owner, Admin or Staff member gets 403, even for their own business.
- **Audit:** every download is written to the business's `auditLog` and to `platformAudit` (`backup.downloaded`).
- **Not a substitute for layers 1–3.** It's a convenience copy for one business, not Luna's disaster recovery.

## Restore drill (before real clients)

1. Restore yesterday's scheduled backup into a scratch database.
2. Compare document counts for a pilot tenant against the live database. Open its Master Backup and spot-check orders, payroll and guests.
3. Restore one deleted Storage proof from a non-current version.
4. Record the restore time and the steps taken.

See also the production-readiness checklist: CI must gate deploys before real clients.
