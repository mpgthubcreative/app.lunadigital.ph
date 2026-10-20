// Trial feedback and reviews (2026-10-21). A customer's feedback is private:
// it never becomes public on its own. Super Admin reviews it (New →
// Reviewed → Approved → Featured); only a testimonial whose author ticked
// the marketing permission can be Featured.

export class FeedbackError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const FEEDBACK_STATUSES = Object.freeze({
  new: { label: "New", tone: "info" },
  reviewed: { label: "Reviewed", tone: "neutral" },
  approved: { label: "Approved", tone: "success" },
  featured: { label: "Featured", tone: "success" },
});
export const FEEDBACK_STATUS_IDS = Object.freeze(Object.keys(FEEDBACK_STATUSES));
export const RECOMMEND_OPTIONS = Object.freeze({ yes: "Yes", maybe: "Maybe", not_yet: "Not yet" });
export const MARKETING_PERMISSION_TEXT = "I allow Luna Digital to use this testimonial on its website, social media and marketing materials.";
export const FEEDBACK_PROMPT = Object.freeze({
  title: "You’ve been using Luna for 3 weeks 💛",
  body: "We’d love to know how Luna has been working for you. Your feedback helps us make Luna simpler and more useful. If you’d like to continue using Luna after your free trial, please take a minute to share your experience.",
  share: "Share feedback",
  later: "Maybe later",
});

const FIELDS = ["rating", "useful", "improve", "recommend", "testimonial", "marketingPermission"];
const text = (v, label, max, { required = false } = {}) => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new FeedbackError("invalid-input", `${label}: please write a few words`);
    return null;
  }
  if (typeof v !== "string") throw new FeedbackError("invalid-input", `${label}: text only`);
  const s = v.trim().replace(/\s+\n/g, "\n");
  if (s.length > max) throw new FeedbackError("invalid-input", `${label}: at most ${max} characters`);
  if (required && !s) throw new FeedbackError("invalid-input", `${label}: please write a few words`);
  return s || null;
};

// The form → what's stored. The permission is false unless ticked (true).
export function validateFeedback(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new FeedbackError("invalid-input", "Invalid feedback");
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) throw new FeedbackError("invalid-input", `Field ${k} can't be set`);
  const rating = Number(input.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new FeedbackError("invalid-input", "Rating: choose 1 to 5");
  if (!Object.hasOwn(RECOMMEND_OPTIONS, input.recommend)) throw new FeedbackError("invalid-input", "Would you recommend Luna: choose Yes, Maybe or Not yet");
  const testimonial = text(input.testimonial, "Testimonial", 500);
  return {
    rating,
    useful: text(input.useful, "What was most useful", 1000),
    improve: text(input.improve, "What could we improve", 1000),
    recommend: input.recommend,
    testimonial,
    marketingPermission: input.marketingPermission === true && Boolean(testimonial),
  };
}

// Featured needs a testimonial its author allowed for marketing.
export function canSetFeedbackStatus(feedback, status) {
  if (!FEEDBACK_STATUS_IDS.includes(status)) return { ok: false, reason: "Unknown status" };
  if (status === "featured" && !(feedback?.marketingPermission === true && feedback?.testimonial)) return { ok: false, reason: "Only a testimonial with marketing permission can be Featured" };
  return { ok: true };
}
