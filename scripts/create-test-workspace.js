// The dedicated production TEST workspace for checks that change data
// (2026-10-28; scripts/_prod-guard.js). Idempotent: creates it once, then
// only makes sure its sample wedding and one test guest link exist.
// Clearly internal: "Luna Smoke Test (internal)", marked testWorkspace: true,
// no members, a free trial (never billed), left out of Super Admin's
// Overview counts. Sample content only.
//   node --env-file=.env.local scripts/create-test-workspace.js --confirm <project>
import { parseArgs, connect } from "./_cli.js";
import { createBusiness } from "../netlify/functions/_lib/provisioning.js";
import { tenantDb } from "../netlify/functions/_lib/tenant-db.js";
import { saveSetup, inviteLink } from "../netlify/functions/_lib/invitations.js";
import { createGuest } from "../netlify/functions/_lib/wedding.js";
import { TEST_BRIDAL_ID } from "./_prod-guard.js";

const args = parseArgs();
const { db, admin } = await connect(args);
const FieldValue = admin.firestore.FieldValue;
const ref = db.collection("businesses").doc(TEST_BRIDAL_ID);
if (!(await ref.get()).exists) {
  await createBusiness({ db, admin, name: "Luna Smoke Test (internal)", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: TEST_BRIDAL_ID, trial: true, isDemo: true, clock: new Date() });
  console.log(`created ${TEST_BRIDAL_ID}`);
}
await ref.update({ testWorkspace: true });
const tenant = tenantDb(db, TEST_BRIDAL_ID);
const actor = { uid: "luna-smoke", name: "Luna smoke test" };
await saveSetup({ db, tenant, FieldValue, input: { coupleNames: "Smoke & Test", partner1Name: "Smoke", partner2Name: "Test", weddingDate: "2030-01-01", templateId: "monochrome", rsvpEnabled: true, published: true }, actor });
const guests = await tenant.collection("guests").where("name", "==", "Smoke Test Guest").limit(1).get();
const guestId = guests.empty ? (await createGuest({ db, tenant, FieldValue, input: { name: "Smoke Test Guest", side: "both", partySize: 2 }, actor, business: { timezone: "Asia/Manila" } })).guestId : guests.docs[0].id;
await inviteLink({ db, tenant, guestId, actor, now: new Date() });
console.log(`${TEST_BRIDAL_ID} ready (testWorkspace: true, one test guest link).`);
process.exit(0);
