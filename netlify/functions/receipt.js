// POST /api/receipt   PUBLIC (no login): the employee's one-time salary receipt link.
//   { action: "view", token }      what was paid (business name, employee name,
//                                  period, amount, method, date, status)
//   { action: "confirm", token }   "I received my salary" (once)
// The token is the only credential: 24 random bytes, stored only as a
// SHA-256 hash, valid for one payroll, replaced when a new link is issued,
// expiring after RECEIPT_LINK_DAYS and used once. Every invalid token gets
// the same answer, so a guess learns nothing. No ids, other records or
// tenant data are ever returned. The token travels in the POST body (the
// page reads it from the URL fragment), so it doesn't reach server logs.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { readReceiptLink, confirmReceipt } from "./_lib/payroll.js";
import { PayrollError } from "../../shared/payroll.js";

export function createReceiptHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("receipt", async (event) => {
    requireMethod(event, "POST");
    const body = parseJsonBody(event, 1000);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !["action", "token"].includes(k)) || !["view", "confirm"].includes(body.action)) {
      throw new RequestError("invalid-request", "Invalid request.", 400);
    }
    const { db, admin } = await loadAdmin();
    try {
      if (body.action === "view") return respond(200, { success: true, receipt: await readReceiptLink({ db, token: body.token, now: now() }) });
      return respond(200, { success: true, receipt: await confirmReceipt({ db, FieldValue: admin.firestore.FieldValue, token: body.token, now: now() }) });
    } catch (err) {
      if (err instanceof PayrollError) throw new RequestError(err.code, err.message, err.code === "link-expired" ? 410 : 404);
      throw err;
    }
  });
}

export const handler = createReceiptHandler({ getAdmin });
