// POST /api/schedule   (Phase 15: Baby Payment Schedule)
//   { action: "create", payment: { description, category, amount, dueDate, providerId?, payee?, notes? } }   schedule.manage
//   { action: "update", scheduleId, expectedRevision?, changes: { ...any of the above } }                     schedule.manage
//   { action: "cancel", scheduleId, reason? }                                                                 schedule.manage
//   { action: "markPaid", scheduleId, payment: { method, paidDate?, reference?, amount? } }                   schedule.manage + expenses.create
// An Upcoming payment is committed money, not spending. Marking it Paid
// records exactly ONE Baby Expense (a retry returns the same one). Reads go
// straight to Firestore (schedule.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { babyActionHandler } from "./_lib/baby-http.js";
import { createScheduledPayment, updateScheduledPayment, cancelScheduledPayment, markScheduledPaymentPaid } from "./_lib/baby.js";

const M = "schedule.manage";
export const createScheduleHandler = (deps) =>
  babyActionHandler("schedule", {
    ...deps,
    actions: {
      create: { permission: M, created: true, fields: ["action", "payment"], run: (c, b) => createScheduledPayment({ ...c, input: b.payment }) },
      update: { permission: M, fields: ["action", "scheduleId", "expectedRevision", "changes"], run: (c, b) => updateScheduledPayment({ ...c, scheduleId: b.scheduleId, changes: b.changes, expectedRevision: b.expectedRevision ?? null }) },
      cancel: { permission: M, fields: ["action", "scheduleId", "reason"], run: (c, b) => cancelScheduledPayment({ ...c, scheduleId: b.scheduleId, reason: b.reason ?? null }) },
      markPaid: { permission: M, also: ["expenses.create"], fields: ["action", "scheduleId", "payment"], run: (c, b) => markScheduledPaymentPaid({ ...c, scheduleId: b.scheduleId, payment: b.payment }) },
    },
  });

export const handler = createScheduleHandler({ getAdmin });
