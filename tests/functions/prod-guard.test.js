// Production check guardrails (2026-10-28 incident; scripts/_prod-guard.js):
// changing checks run only in a marked test workspace, only with the flag,
// stop BEFORE writing when the starting state isn't the expected one, and
// always put the original back (and verify it).
import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld } from "../helpers/tenants.js";
import { createBusiness } from "../../netlify/functions/_lib/provisioning.js";
import { TEST_BRIDAL_ID, DESTRUCTIVE_FLAG, requireDestructiveFlag, assertTestWorkspace, withRestore, ProdGuardError } from "../../scripts/_prod-guard.js";

let world;
beforeEach(async () => {
  world = await buildWorld();
  await createBusiness({ ...world, name: "Real Couple", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: "yanie-bridal", trial: true, clock: new Date() });
  await createBusiness({ ...world, name: "Luna Smoke Test (internal)", planId: "bridal-basic", workspaceTemplateId: "bridal-expense", businessId: TEST_BRIDAL_ID, trial: true, clock: new Date() });
});
const code = async (p) => {
  try {
    await p;
    return null;
  } catch (err) {
    return err instanceof ProdGuardError ? err.code : `other: ${err.message}`;
  }
};

describe("where and when a changing production check may run", () => {
  it("only with --destructive test-workspace-only", () => {
    expect(() => requireDestructiveFlag({})).toThrow(/--destructive test-workspace-only/);
    expect(() => requireDestructiveFlag({ destructive: "yes" })).toThrow(ProdGuardError);
    expect(() => requireDestructiveFlag({ destructive: DESTRUCTIVE_FLAG })).not.toThrow();
  });

  it("never in a real customer workspace; the test workspace only once it's marked testWorkspace: true", async () => {
    expect(await code(assertTestWorkspace(world.db, "yanie-bridal"))).toBe("refused");
    expect(await code(assertTestWorkspace(world.db, "luna-smoke-missing"))).toBe("refused");
    expect(await code(assertTestWorkspace(world.db, TEST_BRIDAL_ID))).toBe("refused"); // not marked yet
    world.db.docs.set(`businesses/${TEST_BRIDAL_ID}`, { ...world.db.docs.get(`businesses/${TEST_BRIDAL_ID}`), testWorkspace: true });
    expect(await code(assertTestWorkspace(world.db, TEST_BRIDAL_ID))).toBeNull();
    // Marking a real business doesn't help: its id isn't a test id.
    world.db.docs.set("businesses/yanie-bridal", { ...world.db.docs.get("businesses/yanie-bridal"), testWorkspace: true });
    expect(await code(assertTestWorkspace(world.db, "yanie-bridal"))).toBe("refused");
  });
});

describe("withRestore", () => {
  const hero = () => world.db.collection("businesses").doc(TEST_BRIDAL_ID).collection("weddingSetup").doc("hero");
  it("a starting state that isn't the expected one STOPS before any write (the 2026-10-28 case)", async () => {
    await hero().set({ dataUrl: "data:image/jpeg;base64,THEIRS" });
    let ran = false;
    const r = await code(withRestore({ label: "cover photo", refs: [hero()], expect: ([h]) => (h === null ? true : "a cover photo already exists"), run: async () => { ran = true; await hero().delete(); } }));
    expect(r).toBe("blocked");
    expect(ran).toBe(false);
    expect((await hero().get()).data().dataUrl).toBe("data:image/jpeg;base64,THEIRS");
  });

  it("puts the original back exactly (re-created, or deleted if there was none), also when the check fails", async () => {
    await hero().set({ dataUrl: "ORIGINAL", updatedBy: { uid: "u1" } });
    await withRestore({ label: "x", refs: [hero()], expect: () => true, run: async () => { await hero().set({ dataUrl: "TEST" }); } });
    expect((await hero().get()).data()).toEqual({ dataUrl: "ORIGINAL", updatedBy: { uid: "u1" } });
    await hero().delete();
    const err = await code(withRestore({ label: "x", refs: [hero()], expect: () => true, run: async () => { await hero().set({ dataUrl: "TEST" }); throw new Error("check failed"); } }));
    expect(err).toBe("other: check failed");
    expect((await hero().get()).exists).toBe(false);
  });
});
