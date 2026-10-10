// Household staff logins (Phase 18.6). The Owner gives a kasambahay their
// own simple Luna account, linked to their householdStaff record:
//
//   member  businesses/{bid}/members/{uid}  roleTemplate "household_staff",
//           staffId (the link, server-set), activation { status, linkHash, ... }
//   staff   householdStaff/{staffId}.memberUid + login { login, status }
//
// The account is created WITHOUT a password and comes with a one-time
// activation link (./activation.js): the person sets their own password,
// so the Owner never knows it. No email? Luna makes a login ID instead
// (maria.4821). An existing Luna account (the email is already used) is
// linked as is: that person signs in with the password they already have.
//
// A staff login is a membership like any other: it counts towards the
// plan's user limit, can be switched off (Remove access) and is audited.

import { ensureAuthUser, addMember, setMemberStatus, ProvisioningError } from "./provisioning.js";
import { newActivation, writeActivationLink, makeLoginId, loginIdEmail, loginName } from "./activation.js";
import { PayrollError, isValidStaffId } from "../../../shared/payroll.js";

const ROLE = "household_staff";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function staffSnap(tenant, staffId) {
  if (!isValidStaffId(staffId)) throw new PayrollError("invalid-staff", "Choose a staff member");
  const snap = await tenant.doc("householdStaff", staffId).get();
  if (!snap.exists) throw new PayrollError("not-found", "Staff member not found");
  return snap;
}

// Owner: "Create login". email optional (null = a login ID). Returns the
// activation token ONCE (none when an existing account was linked).
export async function createStaffLogin({ db, admin, auth, tenant, businessId, staffId, email = null, actor, now = new Date() }) {
  const staff = (await staffSnap(tenant, staffId)).data();
  if (staff.status !== "active") throw new PayrollError("inactive-staff", `${staff.name} is inactive`);
  if (staff.memberUid) throw new PayrollError("has-login", `${staff.name} already has a login. Use "New activation link" instead.`);
  const typed = typeof email === "string" && email.trim() ? email.trim().toLowerCase() : null;
  if (typed && !EMAIL.test(typed)) throw new PayrollError("invalid-input", "Enter a valid email, or leave it blank for a login ID");

  // The Firebase account: the typed email, or a fresh login ID.
  let user = null;
  if (typed) user = await ensureAuthUser({ auth, email: typed, name: staff.name });
  else {
    for (let i = 0; i < 5 && !user; i += 1) {
      const candidate = await ensureAuthUser({ auth, email: loginIdEmail(makeLoginId(staff.name)), name: staff.name });
      if (candidate.created) user = candidate;
    }
    if (!user) throw new PayrollError("login-id-busy", "Couldn't make a login ID. Try again.");
  }
  const existing = await tenant.member(user.uid).get();
  if (existing.exists) throw new PayrollError("already-member", "That account is already a member of this business");

  const pending = user.created ? newActivation(now) : null;
  await addMember({
    db,
    admin,
    businessId,
    uid: user.uid,
    email: user.email,
    name: staff.name,
    roleTemplate: ROLE,
    createdBy: actor.uid,
    audit: { actor, reason: `Login for household staff ${staff.name}` },
    extra: { staffId, invitedBy: { uid: actor.uid, name: actor.name ?? null }, activation: pending ? pending.activation : { status: "active", linkHash: null, activatedAt: now } },
    within: async (tx) => {
      // The staff record is re-read in the same transaction: two "Create
      // login" clicks can't link two accounts to one person.
      const ref = tenant.doc("householdStaff", staffId);
      const snap = await tx.get(ref);
      if (!snap.exists || snap.data().memberUid) throw new PayrollError("has-login", `${staff.name} already has a login`);
      return () => {
        tx.update(ref, { memberUid: user.uid, login: { login: loginName(user.email), status: pending ? "pending" : "active", createdAt: now, createdBy: { uid: actor.uid, name: actor.name ?? null } } });
        if (pending) writeActivationLink(tx, { db, businessId, uid: user.uid, activation: pending, actor, now });
      };
    },
  });
  return { staffId, uid: user.uid, login: loginName(user.email), existingAccount: !user.created, ...(pending ? { activationToken: pending.token, expiresAt: pending.expiresAt.toISOString() } : {}) };
}

// Owner: a new activation link (the old one stops working). Also the way
// to reset a forgotten password for a login-ID account: the person is
// signed out everywhere and sets a new password.
export async function newStaffActivation({ db, auth, tenant, businessId, staffId, actor, now = new Date() }) {
  const staff = (await staffSnap(tenant, staffId)).data();
  if (!staff.memberUid) throw new PayrollError("no-login", `${staff.name} has no login yet`);
  const pending = newActivation(now);
  await db.runTransaction(async (tx) => {
    const mSnap = await tx.get(tenant.member(staff.memberUid));
    if (!mSnap.exists || mSnap.data().staffId !== staffId) throw new PayrollError("no-login", `${staff.name} has no login yet`);
    if (mSnap.data().status !== "active") throw new PayrollError("login-disabled", "Turn the login back on first");
    writeActivationLink(tx, { db, businessId, uid: staff.memberUid, activation: pending, previousHash: mSnap.data().activation?.linkHash ?? null, actor, now });
    tx.update(mSnap.ref, { activation: pending.activation });
    tx.update(tenant.doc("householdStaff", staffId), { "login.status": "pending" });
  });
  await auth.revokeRefreshTokens(staff.memberUid).catch(() => {});
  return { staffId, login: staff.login?.login ?? null, activationToken: pending.token, expiresAt: pending.expiresAt.toISOString() };
}

// Owner: switch the login off (the record and its history stay) or on.
export async function setStaffLogin({ db, admin, auth, tenant, businessId, staffId, enabled, actor }) {
  const staff = (await staffSnap(tenant, staffId)).data();
  if (!staff.memberUid) throw new PayrollError("no-login", `${staff.name} has no login yet`);
  await setMemberStatus({ db, admin, businessId, uid: staff.memberUid, status: enabled ? "active" : "disabled", audit: { actor, reason: `${enabled ? "Login turned on" : "Login turned off"} for household staff ${staff.name}` } });
  const member = (await tenant.member(staff.memberUid).get()).data();
  await tenant.doc("householdStaff", staffId).update({ "login.status": enabled ? (member?.activation?.status === "pending" ? "pending" : "active") : "disabled" });
  if (!enabled) await auth.revokeRefreshTokens(staff.memberUid).catch(() => {});
  return { staffId, enabled };
}

export { ProvisioningError };
