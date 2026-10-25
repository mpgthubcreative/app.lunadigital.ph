// Household duplicate-request protection (2026-10-25): Give / Record
// advance, Record repayment, Add bonus and Add deduction need one request
// key per dialog. Tests that aren't about keys get a fresh key per call
// (what the UI does: a new dialog, a new key); a test that sets its own
// idempotencyKey keeps it.
import { randomBytes } from "node:crypto";

const KEYED = { advances: ["give", "create", "repay"], payroll: ["addAddition", "addDeduction"] };

export function withRequestKey(kind, body) {
  if (!body || typeof body !== "object" || "idempotencyKey" in body || !KEYED[kind]?.includes(body.action)) return body;
  return { ...body, idempotencyKey: `t${randomBytes(12).toString("hex")}` };
}
