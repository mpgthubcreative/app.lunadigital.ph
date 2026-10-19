// POST /api/receipt   the kasambahay's salary receipt link (Owner pilot 2026-10-19)
//   { action: "view", token }      the saved salary breakdown (records Opened once)
//   { action: "confirm", token }   "Confirm received" (records once)
//
// The link is a pointer, not a credential on its own. The caller must be
// signed in (Firebase ID token), and the receipt opens only when:
//   the verified user → has an active membership in the link's business
//   → that membership is linked to a Staff record (member.staffId, set by
//     the server when the Owner created the login) with payroll.self
//   → the payroll the link points to belongs to that Staff record
//   → the link is the payroll's current one.
// Any other signed-in account gets the same "not assigned to your account"
// answer with no receipt data. Unknown tokens all get one 404, so a guess
// learns nothing. The token travels in the POST body (the page keeps it out
// of the address bar), so it doesn't reach server logs. Opening never
// confirms.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { authenticate } from "./_lib/auth.js";
import { resolveTenantContext } from "./_lib/tenant.js";
import { findReceiptLink } from "./_lib/payroll.js";
import { openSalaryReceipt, confirmSalaryReceived } from "./_lib/household-self.js";
import { PayrollError } from "../../shared/payroll.js";

export const NOT_YOURS_MESSAGE = "This salary receipt is not assigned to your account.";
const NOT_YOURS = () => new RequestError("receipt-not-yours", NOT_YOURS_MESSAGE, 403);
const STATUS = { "link-expired": 410, "link-invalid": 404, "not-found": 404, "payment-not-paid": 409, "not-linked": 403 };

export function createReceiptHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("receipt", async (event) => {
    requireMethod(event, "POST");
    const body = parseJsonBody(event, 1000);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !["action", "token"].includes(k)) || !["view", "confirm"].includes(body.action)) {
      throw new RequestError("invalid-request", "Invalid request.", 400);
    }
    const { db, auth, admin } = await loadAdmin();
    const user = await authenticate(event, auth);
    try {
      const link = await findReceiptLink({ db, token: body.token, now: now() });
      let ctx;
      try {
        ctx = await resolveTenantContext({ db, uid: user.uid, requestedBusinessId: link.businessId });
      } catch {
        throw NOT_YOURS(); // not a member of that business (or no longer active)
      }
      const staffId = ctx.member.staffId;
      if (!staffId || ctx.permissions["payroll.self"] !== true || !link.payrollId.startsWith(`${staffId}_`)) throw NOT_YOURS();
      const args = { db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, staffId, payrollId: link.payrollId, linkHash: link.hash, expired: link.expired, actor: { uid: user.uid, name: user.name || null } };
      const receipt = body.action === "view" ? await openSalaryReceipt(args) : await confirmSalaryReceived(args);
      return respond(200, { success: true, receipt });
    } catch (err) {
      if (err instanceof PayrollError) {
        // The payroll id names this staff member but the record says otherwise: still not theirs.
        if (err.code === "not-found") throw NOT_YOURS();
        throw new RequestError(err.code, err.message, STATUS[err.code] ?? 409);
      }
      throw err;
    }
  });
}

export const handler = createReceiptHandler({ getAdmin });
