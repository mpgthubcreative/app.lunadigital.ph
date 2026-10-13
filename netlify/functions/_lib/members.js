// Team members (Phase 18.6): the Owner manages who can use the business
// from the Users page, without Luna's help. Built on the same membership
// functions as provisioning (./provisioning.js addMember / setMemberStatus:
// plan user limit, owner protection, audit) and the activation links
// (./activation.js: the person sets their own password).
//
// Rules, checked here on the server (never just hidden in the browser):
//   - users.manage to change anything; users.view to see the list
//   - nobody changes their own role or access (no self-promotion)
//   - the account owner can't be changed or removed here
//   - "Owner" is never granted here (only Luna can transfer ownership)
//   - roles offered = the workspace's own (a Distributor "Staff" role means
//     nothing in a Baby tracker); household staff logins are made from
//     Household Staff, linked to their pay record
//   - adding / restoring counts against the plan's user limit
// A new account gets a one-time activation link, shown once. An email that
// already has a Luna account is added as is: they sign in as before.

import { ROLE_TEMPLATES } from "../../../shared/permissions.js";
import { ensureAuthUser, addMember, setMemberStatus, removeMember, ProvisioningError } from "./provisioning.js";
import { newActivation, writeActivationLink, loginName, isLoginIdEmail, makeLoginId, loginIdEmail } from "./activation.js";

export class MemberError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UID = /^[A-Za-z0-9:_-]{1,128}$/;

// Roles an Owner may give in this workspace.
export function assignableRoles(workspaceTemplateId) {
  return ["manager", ...(workspaceTemplateId === "distributor" ? ["staff"] : [])];
}

const view = (m) => ({
  uid: m.uid,
  name: m.name || "",
  login: loginName(m.email || ""),
  usesLoginId: isLoginIdEmail(m.email || ""),
  role: m.roleTemplate,
  roleLabel: ROLE_TEMPLATES[m.roleTemplate]?.label ?? "Custom",
  status: m.status,
  isAccountOwner: m.isAccountOwner === true,
  activation: m.activation?.status === "pending" ? "pending" : "active",
  householdStaff: Boolean(m.staffId),
});

// Household workspace: staff records that don't have a login yet (the
// Users page offers them for "Household Staff" access).
export async function staffWithoutLogin({ tenant }) {
  const snap = await tenant.collection("householdStaff").where("status", "==", "active").get();
  return snap.docs.filter((d) => !d.data().memberUid).map((d) => ({ id: d.id, name: d.data().name })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function listMembers({ tenant }) {
  const snap = await tenant.collection("members").get();
  const order = { owner: 0, manager: 1, staff: 2, household_staff: 3 };
  return snap.docs
    .map((d) => view({ uid: d.id, ...d.data() }))
    .sort((a, b) => Number(b.isAccountOwner) - Number(a.isAccountOwner) || (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.name.localeCompare(b.name));
}

async function target(tenant, uid, actor) {
  if (typeof uid !== "string" || !UID.test(uid)) throw new MemberError("invalid-input", "Choose a member");
  if (uid === actor.uid) throw new MemberError("not-yourself", "You can't change your own access. Ask another owner or Luna.");
  const snap = await tenant.member(uid).get();
  if (!snap.exists) throw new MemberError("not-found", "Member not found");
  const m = snap.data();
  if (m.isAccountOwner === true) throw new MemberError("owner-protected", "The business owner's access can't be changed here.");
  return { uid, m };
}

// Owner: Add member. email optional for a login ID (people without email).
export async function inviteMember({ db, admin, auth, tenant, businessId, workspace, input, actor, now = new Date() }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new MemberError("invalid-input", "Invalid member");
  for (const k of Object.keys(input)) if (!["name", "email", "role"].includes(k)) throw new MemberError("invalid-input", `Unknown field ${k}`);
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (!name || name.length > 80) throw new MemberError("invalid-input", "Enter the person's name");
  if (!assignableRoles(workspace).includes(input.role)) throw new MemberError("invalid-role", "Choose one of the roles offered");
  const email = typeof input.email === "string" && input.email.trim() ? input.email.trim().toLowerCase() : null;
  if (email && !EMAIL.test(email)) throw new MemberError("invalid-input", "Enter a valid email, or leave it blank for a login ID");

  let user = null;
  if (email) user = await ensureAuthUser({ auth, email, name });
  else {
    for (let i = 0; i < 5 && !user; i += 1) {
      const candidate = await ensureAuthUser({ auth, email: loginIdEmail(makeLoginId(name)), name });
      if (candidate.created) user = candidate;
    }
    if (!user) throw new MemberError("login-id-busy", "Couldn't make a login ID. Try again.");
  }
  if ((await tenant.member(user.uid).get()).exists) throw new MemberError("already-member", "That person is already on your team. Restore their access instead.");
  const pending = user.created ? newActivation(now) : null;
  await addMember({
    db,
    admin,
    businessId,
    uid: user.uid,
    email: user.email,
    name,
    roleTemplate: input.role,
    createdBy: actor.uid,
    audit: { actor, reason: "Added from the Users page" },
    extra: { invitedBy: { uid: actor.uid, name: actor.name ?? null }, activation: pending ? pending.activation : { status: "active", linkHash: null, activatedAt: now } },
    // The link is stored in the same transaction as the membership.
    within: pending ? async (tx) => () => writeActivationLink(tx, { db, businessId, uid: user.uid, activation: pending, actor, now }) : null,
  });
  return { uid: user.uid, login: loginName(user.email), existingAccount: !user.created, ...(pending ? { activationToken: pending.token, expiresAt: pending.expiresAt.toISOString() } : {}) };
}

// Owner: change someone's role (not their own, not the account owner's,
// never to Owner, not a household staff login).
export async function setMemberRole({ db, admin, tenant, businessId, workspace, uid, role, actor }) {
  const { m } = await target(tenant, uid, actor);
  if (m.staffId) throw new MemberError("household-login", "This is a household staff login. Manage it from Household Staff.");
  if (!assignableRoles(workspace).includes(role)) throw new MemberError("invalid-role", "Choose one of the roles offered");
  if (m.roleTemplate === role) return { uid, role, unchanged: true };
  await addMember({ db, admin, businessId, uid, email: m.email, name: m.name, roleTemplate: role, permissionOverrides: m.permissionOverrides || {}, status: m.status, audit: { actor, reason: `Role changed from ${ROLE_TEMPLATES[m.roleTemplate]?.label ?? m.roleTemplate} to ${ROLE_TEMPLATES[role].label}` } });
  return { uid, role };
}

// Owner-pilot fix (2026-10-11): an existing login that is really a
// kasambahay (e.g. added as Manager / Admin from Add member) becomes a
// Household Staff login linked to exactly one staff record, in one
// transaction: the role is replaced (Manager permissions are gone), the
// member gets the staffId and the staff record the memberUid. Audited.
export async function linkMemberToStaff({ db, admin, tenant, businessId, workspace, uid, staffId, actor }) {
  if (workspace !== "household-payroll") throw new MemberError("invalid-role", "Household Staff is only for Household workspaces");
  const { m } = await target(tenant, uid, actor);
  if (m.staffId) throw new MemberError("household-login", "This login is already linked to a staff record");
  if (typeof staffId !== "string" || !UID.test(staffId)) throw new MemberError("invalid-input", "Choose the staff record");
  const staffRef = tenant.doc("householdStaff", staffId);
  const first = await staffRef.get();
  if (!first.exists) throw new MemberError("not-found", "Staff record not found");
  if (first.data().status !== "active") throw new MemberError("invalid-input", `${first.data().name} is inactive`);
  await addMember({
    db,
    admin,
    businessId,
    uid,
    email: m.email,
    name: m.name,
    roleTemplate: "household_staff",
    status: m.status,
    audit: { actor, reason: `Changed from ${ROLE_TEMPLATES[m.roleTemplate]?.label ?? m.roleTemplate} to Household Staff, linked to ${first.data().name}` },
    extra: { staffId },
    within: async (tx) => {
      const snap = await tx.get(staffRef);
      if (!snap.exists || snap.data().memberUid) throw new MemberError("household-login", `${first.data().name} already has a login`);
      return () => tx.update(staffRef, { memberUid: uid, login: { login: loginName(m.email || ""), status: m.status !== "active" ? "disabled" : m.activation?.status === "pending" ? "pending" : "active", createdAt: new Date(), createdBy: { uid: actor.uid, name: actor.name ?? null } } });
    },
  });
  return { uid, role: "household_staff", staffId };
}

// Owner: remove access (they're signed out; their records and history
// stay) or restore it (counts against the user limit again).
export async function setMemberAccess({ db, admin, auth, tenant, businessId, uid, enabled, actor }) {
  if (typeof enabled !== "boolean") throw new MemberError("invalid-input", "Invalid request");
  const { m } = await target(tenant, uid, actor);
  await setMemberStatus({ db, admin, businessId, uid, status: enabled ? "active" : "disabled", audit: { actor, reason: enabled ? "Access restored from the Users page" : "Access removed from the Users page" } });
  if (!enabled) await auth.revokeRefreshTokens(uid).catch(() => {});
  // Only while the staff record is still linked to this login (a Remove
  // user in between unlinks it; nothing is written back then).
  if (m.staffId) {
    const ref = tenant.doc("householdStaff", m.staffId);
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (s.exists && s.data().memberUid === uid) tx.update(ref, { "login.status": enabled ? (m.activation?.status === "pending" ? "pending" : "active") : "disabled" });
    }).catch(() => {});
  }
  return { uid, status: enabled ? "active" : "disabled" };
}

// Owner-pilot cleanup: Remove user. The person's membership of THIS
// business goes for good (not "No access": they leave the Users list; the
// audit log keeps it). A household staff login is unlinked from its staff
// record, which stays, with its attendance, payroll, advances and
// confirmations: removing access doesn't end employment (Household Staff
// does that). Their Luna account itself is kept (it may belong to other
// businesses); they're signed out. Re-adding later links the same staff
// record again (Create login / Add member -> Household Staff). Retrying is
// harmless.
export async function removeMemberFromBusiness({ db, admin, auth, tenant, businessId, uid, actor }) {
  if (typeof uid !== "string" || !UID.test(uid)) throw new MemberError("invalid-input", "Choose a member");
  if (uid === actor.uid) throw new MemberError("not-yourself", "You can't remove yourself. Ask another owner or Luna.");
  const snap = await tenant.member(uid).get();
  if (!snap.exists) return { uid, removed: false, alreadyRemoved: true };
  if (snap.data().isAccountOwner === true) throw new MemberError("owner-protected", "The business owner can't be removed.");
  const r = await removeMember({
    db,
    admin,
    businessId,
    uid,
    audit: { actor, reason: "Removed from the Users page" },
    within: async (tx, { member }) => {
      if (!member.staffId) return null;
      const ref = tenant.doc("householdStaff", member.staffId);
      const s = await tx.get(ref);
      if (!s.exists || s.data().memberUid !== uid) return null;
      const history = Array.isArray(s.data().history) ? s.data().history : [];
      return () => tx.update(ref, { memberUid: null, login: null, history: [...history, { at: new Date(), actor: { uid: actor.uid, name: actor.name ?? null }, label: `Luna access removed (login ${loginName(member.email || "")})` }].slice(-200) });
    },
  });
  await auth.revokeRefreshTokens(uid).catch(() => {});
  return { uid, removed: r.removed, ...(r.alreadyRemoved ? { alreadyRemoved: true } : {}) };
}

// Owner: a new activation link, for someone who hasn't set up their
// account yet, or a login-ID account that lost its password (no email to
// reset with). An active email account resets its own password.
export async function newMemberLink({ db, auth, tenant, businessId, uid, actor, now = new Date() }) {
  const { m } = await target(tenant, uid, actor);
  if (m.status !== "active") throw new MemberError("login-disabled", "Restore their access first");
  if (m.activation?.status !== "pending" && !isLoginIdEmail(m.email || "")) throw new MemberError("has-password", "They already set up their account. They can use \"Forgot password\" on the sign-in screen.");
  const pending = newActivation(now);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(tenant.member(uid));
    writeActivationLink(tx, { db, businessId, uid, activation: pending, previousHash: snap.data().activation?.linkHash ?? null, actor, now });
    tx.update(snap.ref, { activation: pending.activation });
    if (m.staffId) tx.update(tenant.doc("householdStaff", m.staffId), { "login.status": "pending" });
  });
  await auth.revokeRefreshTokens(uid).catch(() => {});
  return { uid, login: loginName(m.email || ""), activationToken: pending.token, expiresAt: pending.expiresAt.toISOString() };
}

export { ProvisioningError };
