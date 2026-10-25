# Luna production readiness (in place)

Updated 2026-10-25. **Decision:** no second Firebase project and no second Netlify site. The current project `luna-business-os` and the site `luna-business-os` are hardened in place. They become production by configuration at cutover. This replaces the "new production project" plan in [PRODUCTION-MIGRATION.md](PRODUCTION-MIGRATION.md); its checklists for rules, Storage, Super Admin and public routes still apply.

**Status: pre-production / Staging.** Nothing in the cutover section has been done.

## 1. Environment consistency

The browser build and the server must describe the same deployment. Nothing is hard-coded: no project id or hostname is "the staging one", so the same project switches to production by changing `LUNA_ENV` / `VITE_LUNA_ENV` alone.

| Check | Where | Effect |
|---|---|---|
| `LUNA_ENV` is valid; `FIREBASE_PROJECT_ID` is set; the service-account email and the default Storage bucket belong to that project; in production `SITE_URL` is an https address | `serverConfigProblems` (shared/environment.js), at build and in `/api/session` | Build fails / the app stops |
| `VITE_LUNA_ENV` = `LUNA_ENV`, `VITE_FIREBASE_PROJECT_ID` = `FIREBASE_PROJECT_ID`, buckets equal when both set | `scripts/check-deployment-env.js` (prebuild, Netlify only) | Build fails: the mismatched version is never publishable |
| The running page's environment and project match the server's; in production the page's origin is `SITE_URL`'s origin | `checkDeployment` (src/app/session.js) on every session load | "Configuration problem" screen before any business data loads |

The site check applies only in production, so deploy previews and localhost keep working on staging. In production it also stops the app running on the old hostname: see the redirect in §3.

## 2. Release safety

See [RELEASE.md](RELEASE.md). Auto publishing is stopped, and `scripts/release.js publish` publishes only a commit whose CI passed. Rollback means republishing an earlier deploy. This works on Netlify Free, so Pro isn't needed for gating.

## 3. Domain: https://app.luna.ph

The `luna.ph` apex and `www` stay on the existing marketing site; the apex is not transferred. Only the `app` subdomain points to Netlify, with a CNAME `app` → `luna-business-os.netlify.app`.

### Audit (2026-10-25, read-only; nothing changed)

| Area | Finding | Ready? |
|---|---|---|
| Sign-in | Email/Password through the Firebase JS SDK; `authDomain` = `luna-business-os.firebaseapp.com`. No popups or redirects, so the app's own hostname doesn't need to be the auth domain. | Yes |
| Auth authorized domains | `localhost`, `luna-business-os.firebaseapp.com`, `luna-business-os.web.app`, `luna-business-os.netlify.app`. **`app.luna.ph` is missing.** Add it at cutover; it's needed for password-reset / setup `continueUrl`s. | Cutover step |
| Password reset / setup emails | Firebase's default action handler (`https://luna-business-os.firebaseapp.com/__/auth/action`). The continue link is `SITE_URL` (`operator.js`, `provisioning.js`, `add-member.js`, `create-business.js`). The emails come from the default Firebase sender. | Yes, once `SITE_URL` changes |
| Distributor pay links, store link, order confirmations | Built in the browser from `location.origin` plus a server-returned path (`orders/index.js`, `share-menu.js`, `payments/link-sheet.js`). On app.luna.ph they are app.luna.ph links. | Yes |
| Bridal wedding site, invitations, RSVP | `location.origin` plus a server path (`wedding/guests.js`). One fallback, `https://app.lunadigital.ph` (`wedding/setup.js:811`), is used only when there's no browser `location` (never in a real browser). Bridal is frozen, so it's left as is: change it at cutover if wanted. | Yes |
| Household staff invitations, Received / salary receipt links | `activationUrl` / `receiptUrl` from `location.origin` (`share-link.js`, `payroll/index.js`). | Yes |
| `SITE_URL` | `https://luna-business-os.netlify.app` today. At cutover: `https://app.luna.ph`. | Cutover step |
| CSP (netlify.toml) | No hostname-specific sources: `'self'`, `*.googleapis.com`, `*.firebaseio.com`, `*.firebaseapp.com` (frame), `firebasestorage.googleapis.com` (img). It works unchanged on app.luna.ph. | Yes |
| Redirects | SPA and `/api/*` rules are path-based. **The old hostname keeps serving the app** until a host redirect is added (Netlify does not redirect `*.netlify.app` to the primary domain). Prepared rule below, **not applied**. | Cutover step |
| Stored absolute URLs | None. Links are stored as tokens or paths and become URLs in the browser. Links already shared on the old hostname keep working through the redirect (same path). | Yes |
| HSTS | `max-age=31536000; includeSubDomains` is sent by the app. On `app.luna.ph` it covers only `app.luna.ph` and its subdomains, not the apex. | Yes |

Prepared redirect, to put at the **top** of `netlify.toml` at cutover:

```toml
[[redirects]]
  from = "https://luna-business-os.netlify.app/*"
  to = "https://app.luna.ph/:splat"
  status = 301
  force = true
```

## 4. Cutover checklist (NOT done: each step needs the owner's go-ahead)

1. Owner checks on a real iPhone and tablet: Bridal invitation copy / share, the Distributor pay link, the Household receipt link.
2. Backups switched on: PITR, a daily backup schedule, delete protection, Storage retention ([BACKUP.md](BACKUP.md)). Optional: Auth emails from Luna's own domain (the 2026-10-19 decision: Resend SMTP; not configured yet, so the default Firebase sender is used).
3. Netlify → Domain management: add `app.luna.ph` and make it primary. DNS: CNAME `app` → `luna-business-os.netlify.app`, at the `luna.ph` DNS host; the apex and `www` are untouched. Wait for the certificate.
4. Firebase Auth → Settings → Authorized domains: add `app.luna.ph`.
5. Netlify env: `SITE_URL=https://app.luna.ph`, `LUNA_ENV=production`, `VITE_LUNA_ENV=production`, all together. Add the host redirect in §3. Push, wait for CI, then `release.js publish`. The build check and the page check confirm that everything agrees, and the Staging banner disappears by configuration.
6. Smoke test on app.luna.ph: sign-in, password reset, one link of each kind, `/api/health`. Then remove `luna-business-os.netlify.app` from the authorized domains only once nobody uses it; the redirect covers old links.
