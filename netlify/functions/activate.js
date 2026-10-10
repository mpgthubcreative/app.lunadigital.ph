// POST /api/activate   PUBLIC (no login): a one-time account activation link
// (Phase 18.6, ./_lib/activation.js).
//   { action: "view", token }                which business, whose account, the login
//   { action: "activate", token, password }  choose a password (once)
// The token is the only credential: 24 random bytes, stored only as a
// SHA-256 hash, replaced when a new link is issued, expiring after
// ACTIVATION_LINK_DAYS, used once. Every invalid token gets the same answer.
// It travels in the POST body (the page reads it from the URL fragment), so
// it doesn't reach server logs. Nothing else about the business is returned.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { readActivation, activateAccount, ActivationError } from "./_lib/activation.js";

const STATUS = { "link-invalid": 404, "link-used": 410, "link-expired": 410, "weak-password": 400 };

export function createActivateHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("activate", async (event) => {
    requireMethod(event, "POST");
    const body = parseJsonBody(event, 2000);
    const fields = body?.action === "activate" ? ["action", "token", "password"] : ["action", "token"];
    if (!body || typeof body !== "object" || Array.isArray(body) || !["view", "activate"].includes(body.action) || Object.keys(body).some((k) => !fields.includes(k))) {
      throw new RequestError("invalid-request", "Invalid request.", 400);
    }
    const { db, auth, admin } = await loadAdmin();
    try {
      if (body.action === "view") return respond(200, { success: true, activation: await readActivation({ db, token: body.token, now: now() }) });
      return respond(200, { success: true, activation: await activateAccount({ db, auth, FieldValue: admin.firestore.FieldValue, token: body.token, password: body.password, now: now() }) });
    } catch (err) {
      if (err instanceof ActivationError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createActivateHandler({ getAdmin });
