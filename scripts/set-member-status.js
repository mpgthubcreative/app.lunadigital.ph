// Enables or disables a membership.
//   node --env-file=.env.local scripts/set-member-status.js \
//     --business <businessId> --email person@example.com --status active|disabled --confirm <projectId>

import { parseArgs, requireArgs, connect, fail } from "./_cli.js";
import { setMemberStatus, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

const args = parseArgs();
requireArgs(args, ["business", "email", "status"]);
const { db, admin, auth } = await connect(args);

try {
  const user = await auth.getUserByEmail(String(args.email).toLowerCase());
  await setMemberStatus({ db, admin, businessId: args.business, uid: user.uid, status: args.status });
  console.log(`✔ ${args.email} in ${args.business} is now ${args.status}`);
} catch (err) {
  if (err instanceof ProvisioningError) fail(err.message);
  if (err.code === "auth/user-not-found") fail(`No account for ${args.email}`);
  throw err;
}
