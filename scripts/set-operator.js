// Grants or disables Luna Super Admin (console) access for an existing Luna
// account. Operators are Luna staff, independent of any business: a
// business Owner is NOT an operator. The console itself can't create
// operators, so the first one is bootstrapped here.
//
//   node --env-file=.env.local scripts/set-operator.js \
//     --email ops@example.com [--status active|disabled] [--name "Name"] \
//     --reason "why" [--actor you@luna] --confirm <projectId>

import { parseArgs, requireArgs, connect, fail } from "./_cli.js";
import { setOperator, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

const args = parseArgs();
requireArgs(args, ["email", "reason"]);
const { db, admin, auth } = await connect(args);

try {
  const r = await setOperator({ db, admin, auth, email: args.email, name: typeof args.name === "string" ? args.name : null, status: typeof args.status === "string" ? args.status : "active", actor: typeof args.actor === "string" ? args.actor : "cli", reason: args.reason });
  console.log(`✔ ${r.email} (${r.uid}) is now an operator: role ${r.role}, status ${r.status}`);
} catch (err) {
  if (err instanceof ProvisioningError) fail(err.message);
  throw err;
}
