// Account activation links (Phase 18.6). How an Owner gives someone a Luna
// login WITHOUT ever knowing their password:
//
//   1. The Owner adds the person (a team member on the Users page, or a
//      kasambahay from Household Staff). Luna creates the account with NO
//      password and returns a one-time activation link, shown once, for the
//      Owner to send (Messenger, Viber, SMS).
//   2. The person opens it, sees which business it's for and their login,
//      and chooses their own password. The link then stops working.
//
// The link: 24 random bytes, stored only as a SHA-256 hash at
//   activationLinks/{hash}  { businessId, uid, expiresAt, usedAt, createdAt }
// (top level, server only: no browser can read it), valid
// ACTIVATION_LINK_DAYS, used once, replaced when a new one is issued (the
// member's `activation.linkHash` names the current one). Every bad, used,
// replaced or unknown token gets the same answer. The token travels in the
// POST body (the page reads it from the URL fragment), so it doesn't reach
// server logs.
//
// People without an email (common for household staff) get a LOGIN ID:
// "maria.4821". It is stored as a Firebase email on a reserved domain that
// can't receive mail (STAFF_LOGIN_DOMAIN); the sign-in screen adds the
// domain when someone types a login ID. They can't reset their own
// password by email: the Owner issues a new activation link instead (which
// also signs them out everywhere).

import { createHash, randomBytes, randomInt } from "node:crypto";
import { tenantDb } from "./tenant-db.js";
import { STAFF_LOGIN_DOMAIN } from "../../../shared/tenancy.js";

export const ACTIVATION_LINK_DAYS = 7;
export { STAFF_LOGIN_DOMAIN };
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 128;

export class ActivationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const NOT_VALID = () => new ActivationError("link-invalid", "This link isn't valid. Ask for a new one.");
export const hashToken = (token) => createHash("sha256").update(token, "utf8").digest("hex");
const toDate = (v) => (v instanceof Date ? v : typeof v?.toDate === "function" ? v.toDate() : null);

// "Maria Santos" -> "maria.4821" (letters only from the first name).
export function makeLoginId(name, random = () => randomInt(1000, 10000)) {
  const first = String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/\s+/)[0]
    .replace(/[^a-z]/g, "")
    .slice(0, 12);
  return `${first || "staff"}.${random()}`;
}
export const loginIdEmail = (loginId) => `${loginId}@${STAFF_LOGIN_DOMAIN}`;
export const isLoginIdEmail = (email) => typeof email === "string" && email.endsWith(`@${STAFF_LOGIN_DOMAIN}`);
// What the person types to sign in: their email, or the login ID.
export const loginName = (email) => (isLoginIdEmail(email) ? email.slice(0, -STAFF_LOGIN_DOMAIN.length - 1) : email);

// A new token (shown once) and the member's `activation` field for it.
export function newActivation(now = new Date()) {
  const token = randomBytes(24).toString("base64url");
  const hash = hashToken(token);
  const expiresAt = new Date(now.getTime() + ACTIVATION_LINK_DAYS * 86_400_000);
  return { token, hash, expiresAt, activation: { status: "pending", linkHash: hash, expiresAt, issuedAt: now, activatedAt: null } };
}

// Inside a caller's transaction, in its write phase: stores the link for
// (businessId, uid), deleting the one it replaces.
export function writeActivationLink(tx, { db, businessId, uid, activation, previousHash = null, actor = null, now = new Date() }) {
  if (previousHash && previousHash !== activation.hash) tx.delete(db.collection("activationLinks").doc(previousHash));
  tx.create(db.collection("activationLinks").doc(activation.hash), { businessId, uid, expiresAt: activation.expiresAt, usedAt: null, createdAt: now, createdBy: actor ? { uid: actor.uid, name: actor.name ?? null } : null });
}

async function linkState(tx, db, token, now) {
  if (typeof token !== "string" || !TOKEN.test(token)) throw NOT_VALID();
  const linkRef = db.collection("activationLinks").doc(hashToken(token));
  const linkSnap = await tx.get(linkRef);
  if (!linkSnap.exists) throw NOT_VALID();
  const link = linkSnap.data();
  const tenant = tenantDb(db, link.businessId);
  const [bizSnap, memberSnap] = await Promise.all([tx.get(tenant.ref), tx.get(tenant.member(link.uid))]);
  if (!bizSnap.exists || !memberSnap.exists) throw NOT_VALID();
  const member = memberSnap.data();
  if (member.activation?.linkHash !== linkSnap.id) throw NOT_VALID(); // replaced by a newer link
  if (member.status !== "active") throw NOT_VALID(); // access removed since
  const expires = toDate(link.expiresAt);
  return { linkRef, link, tenant, memberRef: memberSnap.ref, member, business: bizSnap.data(), expired: !expires || expires.getTime() < now.getTime() };
}

// Only what the person needs to recognise the invitation.
const publicView = ({ member, business, expired, link }) => ({
  businessName: business.name || "",
  name: member.name || "",
  login: loginName(member.email),
  usesLoginId: isLoginIdEmail(member.email),
  used: Boolean(link.usedAt),
  expired: !link.usedAt && expired,
});

export async function readActivation({ db, token, now = new Date() }) {
  return db.runTransaction(async (tx) => publicView(await linkState(tx, db, token, now)));
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new ActivationError("weak-password", `Use at least ${MIN_PASSWORD} characters`);
  if (password.length > MAX_PASSWORD) throw new ActivationError("weak-password", "That password is too long");
  if (/^(.)\1+$/.test(password) || /^(?:12345678|password|qwertyui)/i.test(password)) throw new ActivationError("weak-password", "Choose a password that's harder to guess");
  return password;
}

// The person sets their password. Claim the link (used once), set the
// password, then mark the membership active; if setting the password
// fails, the claim is released so the same link can be tried again.
export async function activateAccount({ db, auth, FieldValue, token, password, now = new Date() }) {
  const pw = validatePassword(password);
  const claimed = await db.runTransaction(async (tx) => {
    const s = await linkState(tx, db, token, now);
    if (s.link.usedAt) throw new ActivationError("link-used", "This link was already used. Sign in with your password, or ask for a new link.");
    if (s.expired) throw new ActivationError("link-expired", "This link has expired. Ask for a new one.");
    tx.update(s.linkRef, { usedAt: now });
    return s;
  });
  try {
    await auth.updateUser(claimed.link.uid, { password: pw });
  } catch (err) {
    await claimed.linkRef.update({ usedAt: null });
    throw err;
  }
  await claimed.memberRef.update({ "activation.status": "active", "activation.activatedAt": FieldValue.serverTimestamp() });
  if (claimed.member.staffId) await claimed.tenant.doc("householdStaff", claimed.member.staffId).update({ "login.status": "active", "login.activatedAt": FieldValue.serverTimestamp() }).catch(() => {});
  return { ...publicView({ ...claimed, link: { ...claimed.link, usedAt: now } }), activated: true };
}
