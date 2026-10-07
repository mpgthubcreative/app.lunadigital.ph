// Onboards a new business with its owner.
//
//   node --env-file=.env.local scripts/create-business.js \
//     --name "Business Name" --plan growth \
//     --owner-email owner@example.com --owner-name "Owner Name" \
//     [--timezone Asia/Manila] [--status active] [--id custom-business-id] \
//     --confirm <projectId>
//
// Creates the business (entitlements from the stored plan), creates the
// owner's Firebase Auth account if needed (no password), adds them as the
// account owner with the "owner" permission template, and prints a
// password-setup link to send to the owner.

import { parseArgs, requireArgs, connect, fail } from "./_cli.js";
import { createBusiness, ensureAuthUser, addMember, passwordSetupLink, ProvisioningError } from "../netlify/functions/_lib/provisioning.js";

const args = parseArgs();
requireArgs(args, ["name", "plan", "owner-email", "owner-name"]);
const { db, admin, auth } = await connect(args);

try {
  const { businessId } = await createBusiness({
    db,
    admin,
    name: args.name,
    planId: args.plan,
    timezone: args.timezone || "Asia/Manila",
    subscriptionStatus: args.status || "active",
    businessId: typeof args.id === "string" ? args.id : null,
  });
  console.log(`✔ Business created: ${businessId}`);

  const owner = await ensureAuthUser({ auth, email: args["owner-email"], name: args["owner-name"] });
  console.log(`✔ Owner account ${owner.created ? "created" : "found"}: ${owner.email} (${owner.uid})`);

  await addMember({ db, admin, businessId, uid: owner.uid, email: owner.email, name: args["owner-name"], roleTemplate: "owner", isAccountOwner: true });
  console.log("✔ Owner membership added");

  if (owner.created) {
    const continueUrl = process.env.SITE_URL ? `${process.env.SITE_URL.replace(/\/$/, "")}/` : null;
    const link = await passwordSetupLink({ auth, email: owner.email, continueUrl });
    console.log(`\nSend this password-setup link to the owner (valid for a limited time):\n${link}\n`);
  }
} catch (err) {
  if (err instanceof ProvisioningError) fail(err.message);
  throw err;
}
