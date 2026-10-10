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
// platformAudit "operator.updated" record (setOperator).

import { parseArgs, requireArgs, connect, fail } from "./_cli.js";
import { setOperator, ensureAuthUser, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

const args = parseArgs();
requireArgs(args, ["email", "reason"]);
const { db, admin, auth } = await connect(args);
const email = String(args.email).trim().toLowerCase();

// Firebase Auth's own password-reset email (Identity Toolkit sendOobCode,
// with the public web API key). Returns nothing secret.
async function sendPasswordEmail() {
  const key = process.env.VITE_FIREBASE_API_KEY;
  if (!key) fail("VITE_FIREBASE_API_KEY is not set in the env file.");
  const continueUrl = process.env.SITE_URL ? `${process.env.SITE_URL.replace(/\/$/, "")}/console/` : undefined;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${key}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestType: "PASSWORD_RESET", email, ...(continueUrl ? { continueUrl } : {}) }) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    fail(`Firebase didn't send the password email (${r.status} ${j.error?.message ?? ""}).`);
  }
}

try {
  if (args["create-account"]) {
    const u = await ensureAuthUser({ auth, email, name: typeof args.name === "string" ? args.name : email });
    console.log(`✔ Luna account ${u.created ? "created (no password yet)" : "already exists"}: ${u.email} (${u.uid})`);
  }
  const r = await setOperator({ db, admin, auth, email, name: typeof args.name === "string" ? args.name : null, status: typeof args.status === "string" ? args.status : "active", actor: typeof args.actor === "string" ? args.actor : "cli", reason: args.reason });
  console.log(`✔ ${r.email} (${r.uid}) is now an operator: role ${r.role}, status ${r.status}`);
  if (args["send-password-email"]) {
    await sendPasswordEmail();
    console.log(`✔ Firebase sent a password-setup email to ${r.email}. Set the password from that email, then sign in at ${(process.env.SITE_URL || "").replace(/\/$/, "")}/console`);
  }
} catch (err) {
  if (err instanceof ProvisioningError) fail(err.message);
  throw err;
}
