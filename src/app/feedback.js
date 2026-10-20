// Trial feedback (2026-10-21): on Day 21 of the free trial the Owner is
// asked once how Luna is working ("Share feedback" / "Maybe later"); from
// Day 27 a quiet banner reminds them until they send it (shell.js). The
// prompt never opens over another dialog or while something is being
// typed: it waits for a quiet moment. Feedback is private to Luna.

import { confirmDialog, toast as defaultToast } from "../components/feedback.js";
import { formDialog } from "../components/form-dialog.js";
import { api as defaultApi } from "../lib/api.js";
import { FEEDBACK_PROMPT, RECOMMEND_OPTIONS, MARKETING_PERMISSION_TEXT } from "@shared/feedback.js";

const RATINGS = [
  { value: "5", label: "5 · Excellent" },
  { value: "4", label: "4 · Good" },
  { value: "3", label: "3 · Okay" },
  { value: "2", label: "2 · Not great" },
  { value: "1", label: "1 · Poor" },
];

export const isOwner = (session) => session?.member?.isAccountOwner === true || session?.member?.roleTemplate === "owner";

export function feedbackDialog({ api = defaultApi } = {}) {
  return formDialog({
    title: "Share feedback",
    intro: "Only Luna reads this. Nothing is published without your permission.",
    fields: [
      { name: "rating", label: "How would you rate Luna?", type: "select", options: RATINGS, value: "5", required: true },
      { name: "useful", label: "What was most useful?", type: "textarea", rows: 3, maxlength: 1000 },
      { name: "improve", label: "What could we improve?", type: "textarea", rows: 3, maxlength: 1000 },
      { name: "recommend", label: "Would you recommend Luna?", type: "select", options: Object.entries(RECOMMEND_OPTIONS).map(([value, label]) => ({ value, label })), value: "yes", required: true },
      { name: "testimonial", label: "A short testimonial (optional)", type: "textarea", rows: 3, maxlength: 500 },
      { name: "marketingPermission", label: MARKETING_PERMISSION_TEXT, type: "checkbox", value: false },
    ],
    submitLabel: "Send feedback",
    onSubmit: async (v) => {
      if (v.marketingPermission && !v.testimonial.trim()) throw new Error("Write a short testimonial, or untick the permission");
      const feedback = { rating: Number(v.rating), recommend: v.recommend, marketingPermission: v.marketingPermission === true, ...Object.fromEntries(["useful", "improve", "testimonial"].map((k) => [k, v[k].trim()]).filter(([, x]) => x)) };
      return api("feedback", { method: "POST", body: { action: "submit", feedback } });
    },
  });
}

// Opens the feedback form; true when it was sent.
export async function openFeedback({ api = defaultApi, toast = defaultToast } = {}) {
  try {
    const r = await feedbackDialog({ api });
    if (!r) return false;
    toast("Thank you! Your feedback is with Luna.", "success");
    return true;
  } catch (err) {
    toast(err.message || "Couldn't send your feedback", "danger");
    return false;
  }
}

// A quiet moment: no dialog or sheet open, nothing being typed.
export function isQuiet(doc = document) {
  if (doc.querySelector(".modal-backdrop, .sheet:not([hidden]), [data-busy='true']")) return false;
  const a = doc.activeElement;
  if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.closest("#content, .modal")) return false;
  return true;
}

// Day 21: the one-time prompt (never again after "Maybe later" or sending).
// Returns a stop() for the shell's cleanup.
export function scheduleFeedbackPrompt(session, { api = defaultApi, toast = defaultToast, delayMs = 8000, retryMs = 15000, onSent = () => {} } = {}) {
  const fb = session?.subscription?.feedback;
  if (!fb || fb.prompt !== "prompt" || fb.submitted || fb.laterAt || !isOwner(session)) return () => {};
  let timer = null;
  let stopped = false;
  const attempt = async () => {
    if (stopped) return;
    if (!isQuiet()) {
      timer = setTimeout(attempt, retryMs);
      return;
    }
    stopped = true;
    const share = await confirmDialog({ title: FEEDBACK_PROMPT.title, body: FEEDBACK_PROMPT.body, confirmLabel: FEEDBACK_PROMPT.share, cancelLabel: FEEDBACK_PROMPT.later });
    if (share) {
      if (await openFeedback({ api, toast })) onSent();
      return;
    }
    api("feedback", { method: "POST", body: { action: "later" } }).catch(() => {});
  };
  timer = setTimeout(attempt, delayMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
