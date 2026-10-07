// Adds a team member to a business using a permission template.
//
//   node --env-file=.env.local scripts/add-member.js \
//     --business <businessId> --email person@example.com --name "Person" \
//     --role manager|staff|owner [--grant perm.a,perm.b] [--revoke perm.c] \
//     --confirm <projectId>

import { parseArgs, requireArgs, connect, fail } from "./_cli.js";
import { ensureAuthUser, addMember, passwordSetupLink, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

const list = (value) => (typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);

const args = parseArgs();
requireArgs(args, ["business", "email", "name", "role"]);
const { db, admin, auth } = await connect(args);

try {
  const user = await ensureAuthUser({ auth, email: args.email, name: args.name });
  await addMember({
    db,
    admin,
    businessId: args.business,
    uid: user.uid,
    email: user.email,
    name: args.name,
    roleTemplate: args.role,
    permissionOverrides: { grant: list(args.grant), revoke: list(args.revoke) },
  });
  console.log(`✔ ${user.email} added to ${args.business} as ${args.role}`);
  if (user.created) {
    const continueUrl = process.env.SITE_URL ? `${process.env.SITE_URL.replace(/\/$/, "")}/` : null;
    console.log(`\nPassword-setup link:\n${await passwordSetupLink({ auth, email: user.email, continueUrl })}\n`);
  }
} catch (err) {
  if (err instanceof ProvisioningError) fail(err.message);
  throw err;
}
