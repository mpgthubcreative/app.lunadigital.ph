// Luna's 30-day free trial (2026-10-21): a STATE on the subscription, never a
// bill (no ₱0 invoices).
//
//   subscription.trialStatus     trial_active | trial_ended | converted | reset
//   subscription.trialStartedAt  YYYY-MM-DD (business-local)
//   subscription.trialEndsAt     YYYY-MM-DD: the LAST day of the trial
//
// trial_ended is also derived: an active trial whose end has passed reads as
// ended without anything being written (no scheduler needed). "reset" =
// Super Admin restarted the trial (new dates); it behaves like an active one.
// "converted" = the first paid bill was paid: the trial is over for good.
//
// While a trial is unconverted, nothing is billed until the customer
// chooses a plan on "Continue with Luna" (subscription.conversion). When it
// has ended: sign in, the continuation page, choosing a plan, paying and
// Settings → Data still work; everyday editing doesn't. No data is deleted.

export const TRIAL_DAYS = 30;
export const TRIAL_ENDED_MESSAGE = "Your Luna trial has ended. Your information is still safe. Choose a plan to continue using your workspace.";
export const FEEDBACK_DAY = 21; // "You've been using Luna for 3 weeks"
export const REMINDER_DAY = 27; // a quiet reminder if no feedback yet
export const TRIAL_STATUSES = Object.freeze({
  trial_active: { label: "Free trial" },
  trial_ended: { label: "Trial ended" },
  converted: { label: "Converted" },
  reset: { label: "Trial restarted" },
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v) => typeof v === "string" && DAY.test(v);
const shift = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const between = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// A new trial's fields (start today, `days` long).
export function newTrial(today, days = TRIAL_DAYS, status = "trial_active") {
  return { trialStatus: status, trialStartedAt: today, trialEndsAt: shift(today, days - 1) };
}

// The trial as of `today`, or null when the subscription never had one.
//   status    effective status (trial_active past its end → trial_ended)
//   day       1 on the first day … 30 on the last
//   daysLeft  0 on the last day; negative once ended
//   open      not converted yet (nothing billed until a plan is chosen)
export function trialState(sub, today) {
  if (!sub || !Object.hasOwn(TRIAL_STATUSES, sub.trialStatus) || !isDay(sub.trialStartedAt) || !isDay(sub.trialEndsAt)) return null;
  const stored = sub.trialStatus;
  const daysLeft = between(today, sub.trialEndsAt);
  const status = stored === "converted" ? "converted" : stored === "trial_ended" || daysLeft < 0 ? "trial_ended" : "trial_active";
  return {
    status,
    stored,
    startedAt: sub.trialStartedAt,
    endsAt: sub.trialEndsAt,
    day: Math.max(1, between(sub.trialStartedAt, today) + 1),
    daysLeft,
    open: status !== "converted",
    ended: status === "trial_ended",
    conversion: sub.conversion ?? null,
  };
}

// Has the trial ended without a paid conversion (everyday editing locked)?
export const trialLocked = (sub, today) => trialState(sub, today)?.ended === true;
// Unconverted trial (nothing is billed until a plan is chosen).
export const trialOpen = (sub) => Boolean(sub && Object.hasOwn(TRIAL_STATUSES, sub.trialStatus) && sub.trialStatus !== "converted");

// Day 21 → the feedback prompt; Day 27 → a quiet reminder (until submitted).
export function feedbackPrompt(trial, { submitted = false } = {}) {
  if (!trial || !trial.open || submitted) return null;
  if (trial.day >= REMINDER_DAY || trial.ended) return "reminder";
  if (trial.day >= FEEDBACK_DAY) return "prompt";
  return null;
}
