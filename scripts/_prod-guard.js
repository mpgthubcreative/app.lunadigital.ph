// Guardrails for production checks that change data (2026-10-28 incident: a
// smoke test overwrote and removed a couple's real cover photo after its
// "no photo yet" check failed and it only logged a warning).
//
// Rules, enforced here rather than left to discipline:
//   1. Changes only in a dedicated test workspace: the id starts with
//      TEST_WORKSPACE_PREFIX AND the business is marked testWorkspace: true.
//      Every real customer business fails both.
//   2. Only with the explicit --destructive test-workspace-only flag.
//   3. withRestore(): read the current state, check the expected starting
//      state (anything else STOPS before any write: "blocked"), keep the full
//      originals, run, then restore them exactly and verify the restore.
//      Never "warn and continue".

export const TEST_WORKSPACE_PREFIX = "luna-smoke-";
export const DESTRUCTIVE_FLAG = "test-workspace-only";
// The one production test workspace (scripts/create-test-workspace.js).
export const TEST_BRIDAL_ID = `${TEST_WORKSPACE_PREFIX}bridal`;

export class ProdGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // refused | blocked | restore-failed
  }
}

export function requireDestructiveFlag(args) {
  if (args?.destructive !== DESTRUCTIVE_FLAG) throw new ProdGuardError("refused", `Refusing: production checks that change data need --destructive ${DESTRUCTIVE_FLAG}.`);
}

export async function assertTestWorkspace(db, businessId) {
  if (typeof businessId !== "string" || !businessId.startsWith(TEST_WORKSPACE_PREFIX)) throw new ProdGuardError("refused", `Refusing: "${businessId}" is not a test workspace (ids start with ${TEST_WORKSPACE_PREFIX}). Real customer workspaces are never used for changing checks.`);
  const snap = await db.collection("businesses").doc(businessId).get();
  if (!snap.exists || snap.data().testWorkspace !== true) throw new ProdGuardError("refused", `Refusing: ${businessId} isn't marked testWorkspace: true (scripts/create-test-workspace.js).`);
  return snap.data();
}

// A stable comparison of document data (Firestore Timestamps by value).
const stable = (v) =>
  JSON.stringify(v, (k, x) => {
    if (x && typeof x === "object" && typeof x.toMillis === "function") return { __ts: x.toMillis() };
    if (x instanceof Date) return { __ts: x.getTime() };
    if (x && typeof x === "object" && !Array.isArray(x)) return Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]]));
    return x;
  });

// refs: the documents the check may change. expect(originals) → true, or a
// reason why the starting state isn't what the check expects (it then stops
// before writing anything). run(originals) does the check. Afterwards every
// ref is put back exactly (re-created, or deleted if it didn't exist) and
// read back; a mismatch fails loudly.
export async function withRestore({ label, refs, expect, run }) {
  const originals = (await Promise.all(refs.map((r) => r.get()))).map((s) => (s.exists ? s.data() : null));
  const ok = expect(originals);
  if (ok !== true) throw new ProdGuardError("blocked", `${label}: blocked, nothing was changed (${typeof ok === "string" ? ok : "the starting state isn't the expected one"}).`);
  let result;
  let failure = null;
  try {
    result = await run(originals);
  } catch (err) {
    failure = err;
  }
  for (const [i, ref] of refs.entries()) {
    if (originals[i] === null) await ref.delete();
    else await ref.set(originals[i]);
  }
  const back = (await Promise.all(refs.map((r) => r.get()))).map((s) => (s.exists ? s.data() : null));
  const bad = refs.filter((_, i) => stable(back[i]) !== stable(originals[i])).map((r) => r.path);
  if (bad.length) throw new ProdGuardError("restore-failed", `${label}: RESTORE FAILED for ${bad.join(", ")}. Check these documents now.`);
  if (failure) throw failure;
  return result;
}
