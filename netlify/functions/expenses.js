// POST /api/expenses   (Expenses module; writes need subscription write access)
//   { action: "create", expense: { date, category, amount, method, payee?, reference?, notes?, recurring? }, idempotencyKey? }   expenses.create
//     idempotencyKey (Phase 18.6): a retry with the same key returns the first expense (alreadyRecorded)
//   { action: "update", expenseId, expectedRevision?, changes: { ...any of the above } }                       expenses.update
//   { action: "remove", expenseId, reason }                                                                     expenses.delete
// amount is integer centavos (> 0); date is the business-local day. The
// totals (Distributor operating-expense metrics, or the Baby budget),
// createdBy and timestamps are always set by the server; the browser can't
// send them. A Baby expense may add providerId (a saved provider). Reads go straight to Firestore under
// the rules (expenses.view).

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { createExpense, updateExpense, removeExpense } from "./_lib/expenses.js";
import { actorOf, only } from "./_lib/inventory-http.js";
import { ExpenseError } from "../../shared/expenses.js";

const ACTIONS = {
  create: { permission: "expenses.create", fields: ["action", "expense", "idempotencyKey"] },
  update: { permission: "expenses.update", fields: ["action", "expenseId", "expectedRevision", "changes"] },
  remove: { permission: "expenses.delete", fields: ["action", "expenseId", "reason"] },
};

const STATUS = {
  "not-found": 404,
  "invalid-expense": 400,
  "stale-expense": 409,
  removed: 409,
  "history-full": 409,
  "reason-required": 400,
  // Phase 15 (Baby profile)
  "invalid-category": 400,
  "invalid-provider": 400,
  // Phase 16 (Bridal profile)
  "invalid-supplier": 400,
  "over-agreed": 409,
  "not-available": 403,
};

export function createExpensesHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("expenses", async (event) => {
    requireMethod(event, "POST");
    // Authenticate and authorize BEFORE reporting anything about the body.
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event);
    } catch (err) {
      bodyError = err;
    }
    const action = (body && ACTIONS[body.action]) || null;
    const { db, auth, admin } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: action ? action.permission : "expenses.create", write: true });
    if (bodyError) throw bodyError;
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    only(body, action.fields);
    if (body.expectedRevision !== undefined && !Number.isSafeInteger(body.expectedRevision)) throw new RequestError("invalid-request", "Invalid revision.", 400);

    // The workspace (from the validated snapshot) picks the expense profile:
    // Distributor operating expenses or Baby spending (Phase 15).
    const common = { db, tenant: ctx.tenant, FieldValue: admin.firestore.FieldValue, business: ctx.business, workspace: ctx.workspace.templateId, actor: actorOf(ctx) };
    try {
      switch (body.action) {
        case "create":
          return respond(201, { success: true, ...(await createExpense({ ...common, input: body.expense, idempotencyKey: body.idempotencyKey ?? null, now: now() })) });
        case "update":
          return respond(200, { success: true, ...(await updateExpense({ ...common, expenseId: body.expenseId, changes: body.changes, expectedRevision: body.expectedRevision ?? null, now: now() })) });
        default:
          return respond(200, { success: true, ...(await removeExpense({ ...common, expenseId: body.expenseId, reason: body.reason, now: now() })) });
      }
    } catch (err) {
      if (err instanceof ExpenseError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createExpensesHandler({ getAdmin });
