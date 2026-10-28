// Production smoke checks for Luna Bridal (2026-10-28), with the guardrails
// of scripts/_prod-guard.js.
//   Read-only (default): health, /bridal, the invite and trial-request APIs
//   (the trial request uses the bot field, so nothing is stored), and the
//   test workspace's guest link.
//     node --env-file=.env.local scripts/prod-smoke-bridal.js
//   Photo add / change / remove, retention (30 days, server-only), the
//   restore script and Reset invitation: ONLY in the test workspace, ONLY
//   with the flag. Any other starting state STOPS before a write. The sample
//   wedding, cover and design photo are put back exactly afterwards (and
//   verified); the run's own retained copies and gallery photo are removed.
//     node --env-file=.env.local scripts/prod-smoke-bridal.js --destructive test-workspace-only --confirm <project>
// Real customer workspaces are never changed: there is no option for it.
import { execFile } from "node:child_process";
import { parseArgs, connect, connectReadOnly } from "./_cli.js";
import { tenantDb } from "../netlify/functions/_lib/tenant-db.js";
import { saveHero, savePhoto, addGalleryPhoto, resetInvitation } from "../netlify/functions/_lib/invitations.js";
import { photoHistory } from "../netlify/functions/_lib/photo-retention.js";
import { TEST_BRIDAL_ID, requireDestructiveFlag, assertTestWorkspace, withRestore, ProdGuardError } from "./_prod-guard.js";

const args = parseArgs();
// The live address itself (an older address redirects, and a redirect turns a POST into a GET).
const SITE = String(args.site || "https://app.lunadigitalsystem.com").replace(/\/$/, "");
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

// ---- Photo add / change / remove / restore / reset: the test workspace only ----
if (destructive && !token) {
  fail += 1;
  console.log(`STOP: no test workspace guest link (${TEST_BRIDAL_ID}); nothing was changed.`);
}
if (destructive && token) {
  try {
    // The guard refuses every real business (read-only).
    const real = (await db.collection("businesses").get()).docs.filter((d) => d.data().testWorkspace !== true).map((d) => d.id);
    const refusedAll = (await Promise.all(real.map((id) => assertTestWorkspace(db, id).then(() => false, (e) => e instanceof ProdGuardError && e.code === "refused")))).every(Boolean);
    check(`the guard refuses every real workspace (${real.length})`, real.length > 0 && refusedAll);
    let flagRefused = false;
    try {
      requireDestructiveFlag({ destructive: "yes" });
    } catch (e) {
      flagRefused = e instanceof ProdGuardError;
    }
    check("the guard refuses a run without --destructive test-workspace-only", flagRefused);

    await assertTestWorkspace(db, TEST_BRIDAL_ID);
    const FieldValue = admin.firestore.FieldValue;
    const actor = { uid: "luna-smoke", name: "Luna smoke test" };
    const setupRef = tenant.doc("weddingSetup", "current");
    const heroRef = tenant.doc("weddingSetup", "hero");
    const slotRef = tenant.doc("weddingPhotos", "story1");
    const gallery = tenant.collection("weddingGallery");
    const history = photoHistory(tenant);
    const [historyStart, galleryStart] = await Promise.all([history.get(), gallery.get()]);
    if (!historyStart.empty || !galleryStart.empty) throw new ProdGuardError("blocked", `photo checks: blocked, nothing was changed (expected no retained and no gallery photos; found ${historyStart.size} and ${galleryStart.size}).`);
    // Tiny valid JPEGs (a JPEG header is all the server checks for type).
    const jpeg = (n) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200 + n, n)]).toString("base64")}`;
    const guest = async () => (await post("/api/invite", { action: "view", token })).body?.invitation ?? null;
    const kept = async () => (await history.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    const ms = (v) => (v?.toMillis ? v.toMillis() : NaN);
    const restoreScript = (id) =>
      new Promise((resolve) => {
        execFile(process.execPath, ["--env-file=.env.local", "scripts/restore-wedding-photo.js", "--business", TEST_BRIDAL_ID, "--id", id, "--confirm", process.env.FIREBASE_PROJECT_ID], (err, out) => resolve(!err && /Restored hero/.test(out)));
      });
    // A Firestore read with no sign-in (what anyone on the internet could try).
    const anonRead = (path) => fetch(`https://firestore.googleapis.com/v1/projects/${process.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}?key=${process.env.VITE_FIREBASE_API_KEY}`).then((r) => r.status);
    try {
      await withRestore({
        label: "photo checks",
        refs: [setupRef, heroRef, slotRef],
        expect: ([setup, hero, slot]) => (setup?.coupleNames !== "Smoke & Test" ? "the test wedding isn't the sample one" : hero !== null ? "the test workspace already has a cover photo" : slot !== null ? "the test workspace already has a design photo" : true),
        run: async () => {
          // An expired copy is pruned on the next photo change; a fresh one stays.
          const old = history.doc();
          await old.set({ kind: "hero", slot: null, photoId: null, dataUrl: jpeg(9), reason: "replaced", retainedAt: new Date(Date.now() - 31 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000), by: actor });

          await saveHero({ db, tenant, FieldValue, dataUrl: jpeg(1), actor });
          check("add: the guest link shows the saved photo", (await guest())?.hero === jpeg(1));
          check("add: nothing to retain (there was no photo)", (await kept()).length === 0);
          check("30 days: an expired retained copy is pruned on the next change", !(await old.get()).exists);

          await saveHero({ db, tenant, FieldValue, dataUrl: jpeg(2), actor });
          const v2 = await guest();
          check("change: the guest link shows the new photo", v2?.hero === jpeg(2));
          check("change: the guest sees only the active photo", !JSON.stringify(v2).includes(jpeg(1)));
          const replaced = (await kept()).find((h) => h.dataUrl === jpeg(1));
          check("change: the previous photo is retained (hero, replaced)", replaced?.kind === "hero" && replaced?.reason === "replaced");
          check("30 days: expiresAt = retainedAt + 30 days", ms(replaced?.expiresAt) - ms(replaced?.retainedAt) === 30 * 86_400_000);
          check("server-only: a retained photo can't be read without sign-in", (await anonRead(`businesses/${TEST_BRIDAL_ID}/weddingPhotoHistory/${replaced?.id}`)) === 403);
          check("server-only: retained photos can't be listed without sign-in", (await anonRead(`businesses/${TEST_BRIDAL_ID}/weddingPhotoHistory`)) === 403);

          await saveHero({ db, tenant, FieldValue, dataUrl: null, actor });
          check("remove: the guest link has no photo (monogram)", (await guest())?.hero === null);
          const removed = (await kept()).find((h) => h.dataUrl === jpeg(2));
          check("remove: the removed photo is retained (hero, removed)", removed?.reason === "removed");

          // Restore with the ops script: back to the removed photo (nothing to keep: no photo now) ...
          check("restore script: puts the removed photo back", await restoreScript(removed.id));
          check("restore: the guest link shows it again", (await guest())?.hero === jpeg(2));
          check("restore: marked restored, nothing extra kept", (await history.doc(removed.id).get()).data().restoredAt != null && (await kept()).length === 2);
          // ... then to the first photo: the photo it replaces is kept in turn.
          check("restore script: puts the replaced photo back", await restoreScript(replaced.id));
          check("restore: the guest link shows it", (await guest())?.hero === jpeg(1));
          const byRestore = (await kept()).filter((h) => h.dataUrl === jpeg(2) && h.id !== removed.id);
          check("restore: the photo it replaced is retained", byRestore.length === 1 && byRestore[0].reason === "replaced");

          // Reset invitation keeps every photo it removes.
          await savePhoto({ db, tenant, FieldValue, slot: "story1", dataUrl: jpeg(3), actor });
          const { photoId: galleryId } = await addGalleryPhoto({ tenant, FieldValue, dataUrl: jpeg(4), actor });
          const before = (await kept()).length;
          await resetInvitation({ db, tenant, FieldValue, actor });
          const reset = (await kept()).filter((h) => h.reason === "reset");
          check("reset: the cover, design and gallery photos are retained", (await kept()).length === before + 3 && reset.some((h) => h.kind === "hero" && h.dataUrl === jpeg(1)) && reset.some((h) => h.kind === "slot" && h.slot === "story1" && h.dataUrl === jpeg(3)) && reset.some((h) => h.kind === "gallery" && h.dataUrl === jpeg(4) && (!galleryId || h.photoId === galleryId)));
          const v3 = await guest();
          check("reset: the guest link has no photos (monogram)", v3?.hero === null && ![1, 2, 3, 4].some((n) => JSON.stringify(v3).includes(jpeg(n))));
        },
      });
      check("restore: the sample wedding, cover and design photo are exactly as before (verified)", true);
    } finally {
      // This run's own data, test workspace only: its retained copies and gallery photo.
      for (const d of (await history.get()).docs) await d.ref.delete();
      for (const d of (await gallery.get()).docs) await d.ref.delete();
    }
    const [historyEnd, galleryEnd] = await Promise.all([history.get(), gallery.get()]);
    check("cleanup: no retained or gallery photos left (as before)", historyEnd.empty && galleryEnd.empty);
  } catch (err) {
    fail += 1;
    // A starting state that isn't the expected one stops the run: never "warn and continue".
    console.log(`${err instanceof ProdGuardError && err.code === "blocked" ? "STOP" : "FAIL"} ${err.message}`);
  }
}
console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
