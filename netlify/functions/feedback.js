// POST /api/feedback   (2026-10-21: trial feedback; the workspace Owner)
//   { action: "submit", feedback: { rating 1-5, useful?, improve?, recommend:
//     "yes" | "maybe" | "not_yet", testimonial?, marketingPermission? } }
//   { action: "later" }      "Maybe later" on the Day 21 prompt
// Private to Luna (shared/feedback.js): nothing is ever published from here.
// Works after the trial has ended too (no write-access check).

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { submitFeedback, feedbackLater } from "./_lib/feedback.js";
import { FeedbackError } from "../../shared/feedback.js";

const STATUS = { "invalid-input": 400, "not-found": 404, "already-submitted": 409 };

export function createFeedbackHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("feedback", async (event) => {
    requireMethod(event, "POST");
    const { db, auth, admin } = await loadAdmin();
    const FieldValue = admin.firestore.FieldValue;
    const ctx = await requireTenant(event, { db, auth });
    if (ctx.member?.isAccountOwner !== true && ctx.member?.roleTemplate !== "owner") throw new RequestError("forbidden", "Only the owner can send feedback for this workspace.", 403);
    const body = parseJsonBody(event, 20_000);
    try {
      if (body?.action === "later") {
        if (Object.keys(body).length !== 1) throw new RequestError("invalid-request", "Unknown field.", 400);
        return respond(200, { success: true, ...(await feedbackLater({ db, FieldValue, businessId: ctx.businessId })) });
      }
      if (body?.action !== "submit") throw new RequestError("invalid-request", "Unknown action.", 400);
      for (const k of Object.keys(body)) if (!["action", "feedback"].includes(k)) throw new RequestError("invalid-request", `Unknown field ${k}.`, 400);
      const actor = { uid: ctx.user.uid, name: ctx.user.name ?? null, email: ctx.user.email ?? null };
      return respond(201, { success: true, ...(await submitFeedback({ db, FieldValue, businessId: ctx.businessId, actor, input: body.feedback, now: now() })) });
    } catch (err) {
      if (err instanceof FeedbackError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createFeedbackHandler({ getAdmin });
