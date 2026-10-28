// Luna Bridal free-trial requests (2026-10-28, the public /bridal page).
// Trial access stays manual: a visitor leaves a name and how to reach them;
// Luna Super Admin sees the request (Overview → Trial requests), creates
// the workspace and grants the Free Trial. Nothing is activated here.
//
//   trialRequests/{auto}          { product, name, contact, coupleNames,
//                                   weddingDate, note, status: new | done,
//                                   createdAt, doneAt, doneBy }   server-only
//   trialRequestLimits/{key}      { count }  per network per day   server-only
//
// Public and unauthenticated, so: fixed fields, short text, a hidden
// "website" field bots fill in (accepted silently, nothing stored), and at
// most LIMIT_PER_DAY requests from one network a day.

import { createHash } from "node:crypto";
import { businessDate } from "../../../shared/metrics.js";

export class TrialRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const LIMIT_PER_DAY = 5;
const FIELDS = ["name", "contact", "coupleNames", "weddingDate", "note", "website"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v, max, label, required = false) => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new TrialRequestError("invalid-input", `Add ${label}`);
    return null;
  }
  if (typeof v !== "string") throw new TrialRequestError("invalid-input", `Invalid ${label}`);
  const t = v.replace(/\s+/g, " ").trim();
  if (!t && required) throw new TrialRequestError("invalid-input", `Add ${label}`);
  if (t.length > max) throw new TrialRequestError("invalid-input", `${label[0].toUpperCase()}${label.slice(1)}: up to ${max} characters`);
  return t || null;
};

export function validateTrialRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TrialRequestError("invalid-input", "Invalid request");
  for (const k of Object.keys(input)) if (!FIELDS.includes(k)) throw new TrialRequestError("invalid-input", `Field ${k} can't be set`);
  const contact = clean(input.contact, 120, "your mobile number, email or Messenger name", true);
  const weddingDate = input.weddingDate ? String(input.weddingDate) : null;
  if (weddingDate && !DAY.test(weddingDate)) throw new TrialRequestError("invalid-input", "Choose a valid wedding date");
  return {
    name: clean(input.name, 80, "your name", true),
    contact,
    coupleNames: clean(input.coupleNames, 120, "the couple's names"),
    weddingDate,
    note: clean(input.note, 500, "the note"),
    bot: typeof input.website === "string" && input.website.trim() !== "",
  };
}

export async function submitTrialRequest({ db, FieldValue, input, ip = "", now = new Date() }) {
  const data = validateTrialRequest(input);
  if (data.bot) return { received: true };
  const day = businessDate("Asia/Manila", now);
  const key = createHash("sha256").update(`${day}|${ip || "unknown"}`, "utf8").digest("hex").slice(0, 40);
  const limitRef = db.collection("trialRequestLimits").doc(key);
  const ref = db.collection("trialRequests").doc();
  await db.runTransaction(async (tx) => {
    const l = await tx.get(limitRef);
    const count = l.exists ? l.data().count || 0 : 0;
    if (count >= LIMIT_PER_DAY) throw new TrialRequestError("rate-limited", "We've received your requests today. Luna will message you soon.");
    tx.set(limitRef, { count: count + 1, day, updatedAt: FieldValue.serverTimestamp() });
    const { bot: _bot, ...fields } = data;
    tx.create(ref, { product: "bridal", ...fields, status: "new", createdAt: FieldValue.serverTimestamp(), doneAt: null, doneBy: null });
  });
  return { received: true };
}

// Super Admin: the requests still to handle (newest first).
export async function listTrialRequests({ db, max = 50 }) {
  const snap = await db.collection("trialRequests").where("status", "==", "new").limit(max).get();
  const at = (v) => (v?.toDate ? v.toDate().toISOString() : null);
  return snap.docs
    .map((d) => {
      const x = d.data();
      return { id: d.id, product: x.product, name: x.name, contact: x.contact, coupleNames: x.coupleNames ?? null, weddingDate: x.weddingDate ?? null, note: x.note ?? null, createdAt: at(x.createdAt) };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function closeTrialRequest({ db, FieldValue, requestId, operator }) {
  if (typeof requestId !== "string" || !/^[A-Za-z0-9]{1,40}$/.test(requestId)) throw new TrialRequestError("invalid-input", "Invalid request");
  const ref = db.collection("trialRequests").doc(requestId);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new TrialRequestError("not-found", "Request not found");
    if (s.data().status !== "new") return { requestId, alreadyDone: true };
    tx.update(ref, { status: "done", doneAt: FieldValue.serverTimestamp(), doneBy: operator ?? null });
    return { requestId, done: true };
  });
}
