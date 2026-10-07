// Seeds plans/{planId} from shared/plans.seed.js.
//   node --env-file=.env.local scripts/seed-plans.js --confirm <projectId> [--overwrite]
import { parseArgs, connect } from "./_cli.js";
import { seedPlans } from "../netlify/functions/_lib/provisioning.js";

const args = parseArgs();
const { db, admin } = await connect(args);
const results = await seedPlans({ db, admin, overwrite: args.overwrite === true });
for (const r of results) console.log(`  plan ${r.id}: ${r.action}`);
