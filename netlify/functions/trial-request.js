// POST /api/trial-request   PUBLIC (no login): the /bridal page's
// "Request free trial" (./_lib/trial-requests.js). Stores the request for
// Luna Super Admin; grants nothing.
//   { name, contact, coupleNames?, weddingDate?, note?, website? (honeypot) }

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { submitTrialRequest, TrialRequestError } from "./_lib/trial-requests.js";

const STATUS = { "invalid-input": 400, "rate-limited": 429 };
const ipOf = (event) => {
  const h = event.headers || {};
  return String(h["x-nf-client-connection-ip"] || h["x-forwarded-for"] || h["client-ip"] || "").split(",")[0].trim();
};

export function createTrialRequestHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("trial-request", async (event) => {
    requireMethod(event, "POST");
    const body = parseJsonBody(event, 4000);
    const { db, admin } = await loadAdmin();
    try {
      return respond(200, { success: true, ...(await submitTrialRequest({ db, FieldValue: admin.firestore.FieldValue, input: body, ip: ipOf(event), now: now() })) });
    } catch (err) {
      if (err instanceof TrialRequestError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createTrialRequestHandler({ getAdmin });
