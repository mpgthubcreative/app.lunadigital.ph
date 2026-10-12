// Advance repayment plans (Owner-pilot simplification batch), shared by
// Payroll (a deduction line's ⋯) and Advances (Edit repayment plan).
// Advance -> outstanding balance -> repayment plan -> actual repayment. A
// plan never changes what's owed: only a paid payroll's deduction and a
// separate repayment do (the server enforces it).

import { formDialog } from "../../components/form-dialog.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { parseCentavos, staffPeriod, addDays, advanceRemaining, SALARY_METHODS } from "@shared/index.js";

const short = (d) => formatDayId(d).replace(/, \d{4}$/, "");
export const periodText = (e) => (e.periodStart.slice(0, 7) === e.periodEnd.slice(0, 7) ? `${short(e.periodStart)}–${Number(e.periodEnd.slice(8))}` : `${short(e.periodStart)} – ${short(e.periodEnd)}`);

// The plan as the server takes it: the open entries (planned / not taken).
export const openPlan = (a) => (Array.isArray(a.schedule) ? a.schedule : []).filter((e) => e.state === "planned" || e.state === "not_taken").map((e) => ({ periodStart: e.periodStart, amount: e.amount, state: e.state }));

// The person's next pay periods from today's (to plan deductions into).
export function upcomingPeriods(staff, today, count = 8) {
  const out = [];
  let p = staffPeriod(staff, today);
  while (out.length < count) {
    out.push({ periodStart: p.start, periodEnd: p.end });
    p = staffPeriod(staff, addDays(p.end, 1));
  }
  return out;
}

const METHOD_ORDER = ["cash", "gcash", "bank_transfer", "maya", "other"];
export const methodOptions = () => METHOD_ORDER.filter((k) => SALARY_METHODS[k]).map((value) => ({ value, label: SALARY_METHODS[value].label }));

// ⋯ Edit amount: what this period deducts from this advance.
export function editAmount({ advance, periodStart, api }) {
  const plan = openPlan(advance);
  const cur = plan.find((e) => e.state === "planned" && e.periodStart === periodStart);
  return formDialog({
    title: "Deduction amount",
    intro: `${formatCentavos(advanceRemaining(advance))} is still owed on this advance. Changing the amount only changes the plan; the rest stays owed.`,
    fields: [{ name: "amount", label: "Deduct this payroll (₱)", value: cur ? String(cur.amount / 100) : "", required: true, inputmode: "decimal" }],
    submitLabel: "Save",
    onSubmit: (v) => {
      const amount = parseCentavos(v.amount);
      if (!(amount > 0)) throw new Error("Enter an amount, or take it off this payroll instead");
      const next = plan.filter((e) => !(e.state === "planned" && e.periodStart === periodStart));
      return api({ action: "schedule", advanceId: advance.id, schedule: [...next, { periodStart, amount, state: "planned" }] });
    },
  });
}

// ⋯ Move to another payroll (planned or not taken -> planned there).
export function moveTo({ advance, fromPeriodStart, staff, today, api }) {
  const plan = openPlan(advance);
  const moving = plan.filter((e) => e.periodStart === fromPeriodStart);
  const amount = moving.reduce((t, e) => t + e.amount, 0);
  const options = upcomingPeriods(staff, today).filter((p) => p.periodStart !== fromPeriodStart);
  return formDialog({
    title: `Move ${formatCentavos(amount)} to another payroll`,
    intro: "The debt doesn't change; only when it's deducted.",
    fields: [{ name: "to", label: "Deduct from", type: "select", value: options[0]?.periodStart, options: options.map((p) => ({ value: p.periodStart, label: periodText(p) })) }],
    submitLabel: "Move",
    onSubmit: (v) => api({ action: "schedule", advanceId: advance.id, schedule: [...plan.filter((e) => e.periodStart !== fromPeriodStart), { periodStart: v.to, amount, state: "planned" }] }),
  });
}

// ⋯ Remove from this payroll: not deducted now, still owed ("not taken").
export function takeOff({ advance, periodStart, api }) {
  const plan = openPlan(advance);
  const amount = plan.filter((e) => e.state === "planned" && e.periodStart === periodStart).reduce((t, e) => t + e.amount, 0);
  return api({ action: "schedule", advanceId: advance.id, schedule: [...plan.filter((e) => !(e.state === "planned" && e.periodStart === periodStart)), { periodStart, amount, state: "not_taken" }] });
}

// Mark repaid separately (cash back to the Owner, not through payroll).
export function repay({ advance, today, api, notTakenPeriod = null, amount = null }) {
  const owed = advanceRemaining(advance);
  return formDialog({
    title: "Record a repayment",
    intro: `${formatCentavos(owed)} is still owed. A repayment lowers it right away.`,
    fields: [
      { name: "amount", label: "Amount repaid (₱)", value: String((amount ?? owed) / 100), required: true, inputmode: "decimal" },
      { name: "date", label: "Date", type: "date", value: today, max: today },
      { name: "method", label: "How", type: "select", value: "cash", options: methodOptions() },
      { name: "reference", label: "Reference (optional)", more: true },
      { name: "note", label: "Note (optional)", more: true },
    ],
    submitLabel: "Record repayment",
    onSubmit: (v) => api({ action: "repay", advanceId: advance.id, repayment: { amount: parseCentavos(v.amount), date: v.date || today, method: v.method, ...(v.reference.trim() ? { reference: v.reference.trim() } : {}), ...(v.note.trim() ? { note: v.note.trim() } : {}), ...(notTakenPeriod ? { notTakenPeriod } : {}) } }),
  });
}

// The whole plan at once: one line per payroll ("Oct 1–15: 600").
export function editPlan({ advance, staff, today, api }) {
  const owed = advanceRemaining(advance);
  const periods = upcomingPeriods(staff, today);
  const planned = openPlan(advance).filter((e) => e.state === "planned");
  const notTaken = openPlan(advance).filter((e) => e.state === "not_taken");
  return formDialog({
    title: "Repayment plan",
    intro: `${formatCentavos(owed)} owed. Enter how much each payroll deducts (blank = nothing). The plan can be less than what's owed; it can't be more.${notTaken.length ? ` Saving replaces the ${formatCentavos(notTaken.reduce((t, e) => t + e.amount, 0))} not taken earlier: include it in a payroll above, or it simply stays owed.` : ""}`,
    fields: periods.map((p) => ({ name: p.periodStart, label: periodText(p), value: (() => { const x = planned.filter((e) => e.periodStart === p.periodStart).reduce((t, e) => t + e.amount, 0); return x ? String(x / 100) : ""; })(), inputmode: "decimal" })),
    submitLabel: "Save plan",
    onSubmit: (v) => {
      const schedule = periods.flatMap((p) => (String(v[p.periodStart] ?? "").trim() ? [{ periodStart: p.periodStart, amount: parseCentavos(v[p.periodStart]), state: "planned" }] : [])).filter((e) => e.amount > 0);
      // Planned entries outside the shown periods (older unpaid payrolls) stay.
      const kept = planned.filter((e) => !periods.some((p) => p.periodStart === e.periodStart));
      return api({ action: "schedule", advanceId: advance.id, schedule: [...kept, ...schedule] });
    },
  });
}
