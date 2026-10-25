// POST /api/invite   PUBLIC (no login): a guest's personal wedding invitation.
//   { action: "view", token }                       the invitation for THIS party
//                                                   (couple, date, venues, their
//                                                   name, seats, current answer)
//   { action: "respond", token, rsvp: { status: "attending" | "declined", confirmed?, meal?, note? } }
//     meal: one of Wedding Setup's meal options; note: dietary needs (when asked)
// The token (from /invite/{token}) is the only credential: 24 random bytes,
// looked up by its SHA-256, revocable (a new link replaces it). Every bad or
// revoked link gets the same answer; no ids or other guests are returned.
// The answer updates the same Bridal guest record (./_lib/invitations.js).

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { viewInvite, respondInvite } from "./_lib/invitations.js";
import { WeddingError } from "../../shared/wedding.js";

const STATUS = { "invalid-link": 404, "not-published": 404, "rsvp-closed": 409, "history-full": 409 };

export function createInviteHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("invite", async (event) => {
    requireMethod(event, "POST");
    const body = parseJsonBody(event, 1000);
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : null;
    if (!keys || keys.some((k) => !["action", "token", "rsvp"].includes(k)) || !["view", "respond"].includes(body.action) || (body.action === "view" && "rsvp" in body)) {
      throw new RequestError("invalid-request", "Invalid request.", 400);
    }
    if (body.action === "respond" && (!body.rsvp || typeof body.rsvp !== "object" || Object.keys(body.rsvp).some((k) => !["status", "confirmed", "meal", "note"].includes(k)))) throw new RequestError("invalid-request", "Invalid request.", 400);
    const { db, admin } = await loadAdmin();
    try {
      if (body.action === "view") return respond(200, { success: true, invitation: await viewInvite({ db, token: body.token, now: now() }) });
      return respond(200, { success: true, ...(await respondInvite({ db, FieldValue: admin.firestore.FieldValue, token: body.token, rsvp: body.rsvp, now: now() })) });
    } catch (err) {
      if (err instanceof WeddingError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createInviteHandler({ getAdmin });
