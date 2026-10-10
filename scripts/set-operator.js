// Grants or disables Luna Super Admin (console) access for a Luna account.
// Operators are Luna staff, independent of any business: a business Owner
// is NOT an operator. The console itself can't create operators, so the
// first one is bootstrapped here.
//
//   node --env-file=.env.local scripts/set-operator.js \
//     --email ops@example.com --reason "why" --confirm <projectId> \
//     [--status active|disabled] [--name "Name"] [--actor you@luna] \
//     [--create-account] [--send-password-email]
//
// --create-account       create the Firebase Auth account if it doesn't exist
//                        (no password, no business membership)
// --send-password-email  ask Firebase Auth to email a password-setup / reset
//                        link to that address (Firebase's own password-reset
//                        email; nothing secret is printed). After setting the
//                        password, sign in at <SITE_URL>/console.
//
// Writes operators/{uid} { email, name, role: "superadmin", status } and one
// platformAudit "operator.updated" record when something changed
// (bootstrapOperator / setOperator in netlify/functions/_lib/provisioning.js).

import { parseArgs, requireArgs, connect, fail } from "./_cli.js";
import { bootstrapOperator, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

const args = parseArgs();
requireArgs(args, ["email", "reason"]);
const { db, admin, auth } = await connect(args);
const site = (process.env.SITE_URL || "").replace(/\/$/, "");

try {
  const r = await bootstrapOperator({
    db,
    admin,
    auth,
    email: args.email,
    name: typeof args.name === "string" ? args.name : null,
    status: typeof args.status === "string" ? args.status : "active",
    actor: typeof args.actor === "string" ? args.actor : "cli",
    reason: args.reason,
    createAccount: Boolean(args["create-account"]),
    sendPasswordEmail: Boolean(args["send-password-email"]),
    apiKey: process.env.VITE_FIREBASE_API_KEY,
    siteUrl: process.env.SITE_URL || null,
  });
  if (r.account) console.log(`✔ Luna account ${r.account.created ? "created (no password yet)" : "already exists"}: ${r.account.email} (${r.account.uid})`);
  const o = r.operator;
  console.log(o.changed ? `✔ ${o.email} (${o.uid}) is now an operator: role ${o.role}, status ${o.status}` : `✔ ${o.email} (${o.uid}) already an operator: role ${o.role}, status ${o.status} (unchanged, not re-audited)`);
  if (r.passwordEmailSent) console.log(`✔ Firebase sent a password-setup email to ${o.email}. Set the password from that email, then sign in at ${site}/console`);
} catch (err) {
  if (err instanceof ProvisioningError) fail(err.message);
  throw err;
}
