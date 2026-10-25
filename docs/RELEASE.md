# Luna release, rollback and emergency process

Updated 2026-10-25. This applies to the one Firebase project (`luna-business-os`) and the one Netlify site (`luna-business-os`). Both are being hardened in place and will become production by configuration (see [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md)).

## The rule

**Nothing goes live until CI has passed for that exact commit and a person publishes it.**

Netlify Free has no build gating tied to GitHub checks. Luna gets the same result with two settings:

1. **Auto publishing is stopped.** The live deploy is locked. Netlify still builds every push to `main`, but each new build waits as "ready" and is not published.
2. **`scripts/release.js publish` is the only way to publish.** It refuses unless every GitHub Actions run for that commit finished with success. It then publishes that commit's finished Netlify build and checks `/api/health`.

This needs no paid plan and no new secrets. The CLI uses the operator's own `npx netlify login`.

There is a second guard. On Netlify, the build runs `scripts/check-deployment-env.js` first. If the browser variables (`VITE_LUNA_ENV`, `VITE_FIREBASE_PROJECT_ID`) disagree with the server variables (`LUNA_ENV`, `FIREBASE_PROJECT_ID`), or if the service account or bucket belongs to another project, the build fails. A build that fails never becomes publishable.

## Normal release

```sh
# 1. Local gates (see the test notes in the repo): unit suite, build, emulator suite in 3 groups.
# 2. Push. CI runs; Netlify builds but does not publish.
git push origin main
# 3. See what is live, what is waiting, and the CI result of each.
node scripts/release.js status
# 4. Publish the commit once its CI shows "passed".
node scripts/release.js publish --sha <commit> --confirm luna-business-os
```

Firestore rules and indexes are not part of the Netlify deploy. When `firestore.rules` changes, deploy the rules after the emulator gate and before publishing the code that needs them: `npx firebase deploy --only firestore:rules --project staging`. The `.firebaserc` alias is still named `staging`, which is the same project.

## Rollback (code)

Netlify keeps every earlier deploy. Pick a deploy from `status`, or from Netlify → Deploys, and run:

```sh
node scripts/release.js rollback --deploy <deploy id> --confirm luna-business-os
```

This is instant and leaves the data alone. If the bad release also changed Firestore rules, redeploy the rules from the matching commit (`git checkout <good commit> -- firestore.rules`, deploy, then restore the file). Data changes are never rolled back by redeploying code; see the data recovery steps in [BACKUP.md](BACKUP.md).

## Emergency manual process (when the scripts can't run)

1. **Stop the damage.** Netlify → Deploys: open the last good deploy and choose **Publish deploy** (the UI equivalent of rollback). Make sure **Stop auto publishing** stays on.
2. **If a function is corrupting data,** publish the last good deploy as in step 1; every earlier deploy carries its own functions. To take the whole app offline instead, Netlify → Site configuration → **Stop builds**, then publish an earlier deploy known to be safe. Don't change environment variables to "break" the site: the build check refuses such builds, and changes reach the functions only through a new deploy.
3. **Assess the data.** Use the Master Backup (console, per business) and the audit logs. Restore the affected documents from the newest backup ([BACKUP.md](BACKUP.md)): `scripts/restore-firestore.js --business <id>`, which never deletes and never overwrites unless `--overwrite`.
4. **Write it down:** what happened, when, what was restored, and how it was verified.

## One-time settings (already done on 2026-10-25)

- `node scripts/release.js lock --confirm luna-business-os`: auto publishing stopped (live: `7aa4cc3`). `unlock` turns it back on, which is not recommended.
- Optional, in GitHub (owner action): branch protection on `main` requiring the `ci` check. It doesn't change Netlify, but it stops a direct push that skipped review.
