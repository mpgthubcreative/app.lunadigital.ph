// Trial feedback and reviews (2026-10-21), server side.
//
//   feedback/{id}   top-level, server-only (Firestore rules deny every
//                   client read and write). One per business: the
//                   customer's private feedback, with Super Admin's status.
//   businesses/{bid}.feedbackState  { submittedAt, laterAt } so the app
//                   knows not to ask again (session: subscription.feedback).
//
// Nothing here makes feedback public: a status only records Super Admin's
// review. Featured needs the author's marketing permission.

import { FeedbackError, validateFeedback, canSetFeedbackStatus, FEEDBACK_STATUS_IDS, RECOMMEND_OPTIONS } from "../../../shared/feedback.js";
import { trialState } from "../../../shared/trial.js";
import { businessDate } from "../../../shared/metrics.js";
import { tenantDb } from "./tenant-db.js";

const LIST_LIMIT = 200;
const iso = (t) => (t?.toDate ? t.toDate().toISOString() : t instanceof Date ? t.toISOString() : null);
const col = (db) => db.collection("feedback");

export async function submitFeedback({ db, FieldValue, businessId, actor, input, now = new Date() }) {
  const clean = validateFeedback(input);
  const bRef = db.collection("businesses").doc(businessId);
  const ref = col(db).doc(businessId);
  return db.runTransaction(async (tx) => {
    const [b, prior] = await Promise.all([tx.get(bRef), tx.get(ref)]);
    if (!b.exists) throw new FeedbackError("not-found", "Business not found");
    if (prior.exists) throw new FeedbackError("already-submitted", "Thank you: your feedback is already with Luna.");
    const business = b.data();
    const trial = trialState(business.subscription || {}, businessDate(business.timezone || "Asia/Manila", now));
    const record = {
      businessId,
      businessName: business.name ?? businessId,
      workspaceTemplateId: business.workspaceTemplateId ?? null,
      planId: business.subscription?.planId ?? null,
      productName: business.entitlements?.planName ?? null,
      ...clean,
      recommendLabel: RECOMMEND_OPTIONS[clean.recommend],
      trialDay: trial?.day ?? null,
      submittedBy: { uid: actor.uid, name: actor.name ?? null, email: actor.email ?? null },
      submittedAt: FieldValue.serverTimestamp(),
      status: "new",
      statusHistory: [],
    };
    tx.set(ref, record);
    tx.update(bRef, { "feedbackState.submittedAt": FieldValue.serverTimestamp() });
    const audit = { type: "feedback.submitted", summary: `Feedback sent to Luna (${clean.rating}/5)`, businessId, actor: actor.email ?? actor.uid, at: FieldValue.serverTimestamp() };
    tx.set(tenantDb(db, businessId).collection("auditLog").doc(), audit);
    return { feedbackId: ref.id, status: "new" };
  });
}

// "Maybe later": remembered so the Day 21 prompt doesn't come back (the
// Day 27 reminder is a quiet banner).
export async function feedbackLater({ db, FieldValue, businessId }) {
  await db.collection("businesses").doc(businessId).update({ "feedbackState.laterAt": FieldValue.serverTimestamp() });
  return { later: true };
}

const row = (d) => {
  const f = d.data();
  return {
    id: d.id,
    businessId: f.businessId,
    businessName: f.businessName,
    workspaceTemplateId: f.workspaceTemplateId,
    planId: f.planId,
    productName: f.productName,
    rating: f.rating,
    useful: f.useful,
    improve: f.improve,
    recommend: f.recommend,
    recommendLabel: f.recommendLabel ?? RECOMMEND_OPTIONS[f.recommend] ?? null,
    testimonial: f.testimonial,
    marketingPermission: f.marketingPermission === true,
    submittedAt: iso(f.submittedAt),
    submittedBy: f.submittedBy?.name ?? f.submittedBy?.email ?? null,
    trialDay: f.trialDay ?? null,
    status: f.status,
  };
};

// filters: { status?, permission? ("yes" | "no"), workspaceTemplateId? }. Newest first.
export async function listFeedback({ db, filters = {} }) {
  const f = filters && typeof filters === "object" ? filters : {};
  if (f.status && !FEEDBACK_STATUS_IDS.includes(f.status)) throw new FeedbackError("invalid-input", "Unknown status");
  const snap = await col(db).orderBy("submittedAt", "desc").limit(LIST_LIMIT).get();
  const rows = snap.docs
    .map(row)
    .filter((r) => (!f.status || r.status === f.status) && (!f.workspaceTemplateId || r.workspaceTemplateId === f.workspaceTemplateId) && (!f.permission || r.marketingPermission === (f.permission === "yes")));
  const all = snap.docs.map(row);
  return {
    rows,
    counts: Object.fromEntries(FEEDBACK_STATUS_IDS.map((s) => [s, all.filter((r) => r.status === s).length])),
    averageRating: all.length ? Math.round((all.reduce((t, r) => t + r.rating, 0) / all.length) * 10) / 10 : null,
  };
}

export async function setFeedbackStatus({ db, FieldValue, feedbackId, status, operator }) {
  if (typeof feedbackId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(feedbackId)) throw new FeedbackError("invalid-input", "Invalid feedback");
  const ref = col(db).doc(feedbackId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new FeedbackError("not-found", "Feedback not found");
    const f = snap.data();
    const check = canSetFeedbackStatus(f, status);
    if (!check.ok) throw new FeedbackError(status === "featured" ? "no-permission" : "invalid-input", check.reason);
    if (f.status === status) return { status, unchanged: true };
    tx.update(ref, { status, statusHistory: [...(Array.isArray(f.statusHistory) ? f.statusHistory : []), { from: f.status, to: status, by: operator, at: new Date().toISOString() }].slice(-20), statusAt: FieldValue.serverTimestamp() });
    tx.set(db.collection("platformAudit").doc(), { type: "feedback.status", summary: `Feedback from ${f.businessName}: ${f.status} → ${status}`, businessId: f.businessId, feedbackId, actor: operator, before: { status: f.status }, after: { status }, at: FieldValue.serverTimestamp() });
    return { status };
  });
}
