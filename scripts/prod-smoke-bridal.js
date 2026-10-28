// Production smoke checks for Luna Bridal (2026-10-28), with the guardrails
// of scripts/_prod-guard.js.
//   Read-only (default): health, /bridal, the invite and trial-request APIs
//   (the trial request uses the bot field, so nothing is stored), and the
//   test workspace's guest link.
//     node --env-file=.env.local scripts/prod-smoke-bridal.js
//   Photo add / change / remove: ONLY in the test workspace, ONLY with the
//   flag; the cover photo document is put back exactly afterwards, and the
//   retained copies the check made (test workspace only) are removed.
//     node --env-file=.env.local scripts/prod-smoke-bridal.js --destructive test-workspace-only --confirm <project>
// Real customer workspaces are never changed: there is no option for it.
import { parseArgs, connect, connectReadOnly } from "./_cli.js";
import { tenantDb } from "../netlify/functions/_lib/tenant-db.js";
import { saveHero } from "../netlify/functions/_lib/invitations.js";
import { photoHistory } from "../netlify/functions/_lib/photo-retention.js";
import { TEST_BRIDAL_ID, requireDestructiveFlag, assertTestWorkspace, withRestore, ProdGuardError } from "./_prod-guard.js";

const SITE = (process.env.SITE_URL || "https://app.lunadigitalsystem.com").replace(/\/$/, "");
const args = parseArgs();
const destructive = args.destructive !== undefined;
let pass = 0;
let fail = 0;
let skipped = 0;
const check = (name, ok, extra = "") => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};
const post = (path, body) => fetch(`${SITE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

if (destructive) requireDestructiveFlag(args);
const { db, admin } = destructive ? await connect(args) : await connectReadOnly();

// ---- Read-only ----
check("health", (await (await fetch(`${SITE}/api/health`)).json()).success === true);
check("/bridal is served without login", (await fetch(`${SITE}/bridal`)).status === 200);
check("invite API: an unknown link is refused", (await post("/api/invite", { action: "view", token: "x".repeat(32) })).status === 404);
const bot = await post("/api/trial-request", { name: "smoke", contact: "smoke", website: "bot-field" });
check("trial-request API answers (bot field: nothing stored)", bot.status === 200 && bot.body?.received === true);
const tenant = tenantDb(db, TEST_BRIDAL_ID);
const invite = (await tenant.collection("guestInvites").limit(1).get()).docs[0];
const token = invite?.data().token ?? null;
if (!token) {
  skipped += 1;
  console.log(`SKIP test workspace checks: run scripts/create-test-workspace.js first (${TEST_BRIDAL_ID}).`);
} else {
  const v = await post("/api/invite", { action: "view", token });
  check("the test workspace's guest link opens", v.status === 200 && v.body?.invitation?.guest?.name === "Smoke Test Guest");
}

// ---- Photo add / change / remove: the test workspace only ----
if (destructive && token) {
  try {
    await assertTestWorkspace(db, TEST_BRIDAL_ID);
    const heroRef = tenant.doc("weddingSetup", "hero");
    const historyBefore = new Set((await photoHistory(tenant).get()).docs.map((d) => d.id));
    const FieldValue = admin.firestore.FieldValue;
    const actor = { uid: "luna-smoke", name: "Luna smoke test" };
    // Tiny valid JPEGs (a JPEG header is all the server checks for type).
    const jpeg = (n) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200 + n, n)]).toString("base64")}`;
    await withRestore({
      label: "cover photo add / change / remove",
      refs: [heroRef],
      expect: ([hero]) => (hero === null ? true : "the test workspace already has a cover photo"),
      run: async () => {
        await saveHero({ db, tenant, FieldValue, dataUrl: jpeg(1), actor });
        check("add: the guest link shows the saved photo", (await post("/api/invite", { action: "view", token })).body?.invitation?.hero === jpeg(1));
        await saveHero({ db, tenant, FieldValue, dataUrl: jpeg(2), actor });
        check("change: the guest link shows the new photo", (await post("/api/invite", { action: "view", token })).body?.invitation?.hero === jpeg(2));
        await saveHero({ db, tenant, FieldValue, dataUrl: null, actor });
        check("remove: the guest link has no photo (monogram)", (await post("/api/invite", { action: "view", token })).body?.invitation?.hero === null);
        const kept = (await photoHistory(tenant).get()).docs.filter((d) => !historyBefore.has(d.id));
        check("the replaced and removed photos were retained", kept.length === 2 && kept.every((d) => d.data().kind === "hero"));
        // This check's own retained copies (test workspace only).
        for (const d of kept) await d.ref.delete();
      },
    });
    check("cover photo restored exactly as before", true);
  } catch (err) {
    if (err instanceof ProdGuardError && err.code === "blocked") {
      skipped += 1;
      console.log(`SKIP ${err.message}`);
    } else {
      fail += 1;
      console.log(`FAIL ${err.message}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
