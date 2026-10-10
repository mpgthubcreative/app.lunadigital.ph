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
import { ensureAuthUser, addMember, setMemberStatus, ProvisioningError } from "./provisioning.js";
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

// Owner: remove access (they're signed out; their records and history
// stay) or restore it (counts against the user limit again).
export async function setMemberAccess({ db, admin, auth, tenant, businessId, uid, enabled, actor }) {
  if (typeof enabled !== "boolean") throw new MemberError("invalid-input", "Invalid request");
  const { m } = await target(tenant, uid, actor);
  await setMemberStatus({ db, admin, businessId, uid, status: enabled ? "active" : "disabled", audit: { actor, reason: enabled ? "Access restored from the Users page" : "Access removed from the Users page" } });
  if (!enabled) await auth.revokeRefreshTokens(uid).catch(() => {});
  if (m.staffId) await tenant.doc("householdStaff", m.staffId).update({ "login.status": enabled ? (m.activation?.status === "pending" ? "pending" : "active") : "disabled" }).catch(() => {});
  return { uid, status: enabled ? "active" : "disabled" };
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
