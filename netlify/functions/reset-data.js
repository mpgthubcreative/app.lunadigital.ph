// POST /api/reset-data   (2026-10-21: Settings → Data → Reset Workspace Data)
//   { action: "plan" }                     what a reset removes and keeps here
//   { action: "reset", confirm: "RESET" }  the account owner only
// Server-authorized: the account owner of the selected business (membership
// re-read from the verified token). Allowed while the workspace is active or
// its free trial has ended; never while suspended or cancelled. Audited.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { resetWorkspaceData, ResetError } from "./_lib/reset.js";
import { resetPlanFor, RESET_KEEPS, RESET_CONFIRM_WORD } from "../../shared/reset.js";

const STATUS = { "confirm-mismatch": 400, "not-found": 404, "not-resettable": 400 };

export function createResetDataHandler({ getAdmin: loadAdmin }) {
  return withErrorHandling("reset-data", async (event) => {
    requireMethod(event, "POST");
    const { db, auth, admin, bucket } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth });
    if (ctx.member?.isAccountOwner !== true) throw new RequestError("forbidden", "Only the workspace owner can reset its data.", 403);
    if (!ctx.policy.canWrite && !ctx.policy.trialEnded) throw new RequestError("read-only", "This account is read-only. Contact Luna support.", 403);
    const body = parseJsonBody(event, 2_000);
    const plan = resetPlanFor(ctx.workspace.templateId);
    if (body?.action === "plan") return respond(200, { success: true, removes: plan?.summary ?? [], keeps: [...RESET_KEEPS, ...(plan?.keeps ?? [])], confirmWord: RESET_CONFIRM_WORD });
    if (body?.action !== "reset") throw new RequestError("invalid-request", "Unknown action.", 400);
    for (const k of Object.keys(body)) if (!["action", "confirm"].includes(k)) throw new RequestError("invalid-request", `Unknown field ${k}.`, 400);
    try {
      const r = await resetWorkspaceData({ db, admin, bucket, businessId: ctx.businessId, actor: { uid: ctx.user.uid, email: ctx.user.email ?? null }, confirm: body.confirm });
      return respond(200, { success: true, ...r });
    } catch (err) {
      if (err instanceof ResetError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createResetDataHandler({ getAdmin });
