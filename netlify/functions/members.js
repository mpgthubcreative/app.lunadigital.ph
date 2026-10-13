// /api/members   (Phase 18.6: the Users page; the business's own team)
//   GET                                                  the members (users.view)
//   POST { action: "invite", member: { name, email?, role } }   users.manage
//        -> a one-time activation link token for a new account (shown once)
//   POST { action: "setRole", uid, role }                users.manage
//   POST { action: "setAccess", uid, enabled }           users.manage (remove / restore)
//   POST { action: "remove", uid }                       users.manage (Remove user: the
//                                                        membership goes for good; records stay)
//   POST { action: "newLink", uid }                      users.manage (account not set up yet,
//                                                        or a login ID that lost its password)
//   POST { action: "linkStaff", uid, staffId }           users.manage + household.manage
//        (Household: an existing login becomes that staff record's own
//        Household Staff login; Manager / Admin permissions are removed)
// Nobody changes their own access; the account owner is protected; Owner is
// never granted here; the plan's user limit applies (./_lib/members.js).

import { respond, withErrorHandling, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { actorOf, only } from "./_lib/inventory-http.js";
import { listMembers, inviteMember, setMemberRole, setMemberAccess, removeMemberFromBusiness, newMemberLink, linkMemberToStaff, staffWithoutLogin, assignableRoles, MemberError, ProvisioningError } from "./_lib/members.js";

const STATUS = { "not-found": 404, "not-yourself": 403, "owner-protected": 403, "already-member": 409, "user-limit-reached": 403, "household-login": 409, "login-disabled": 409, "has-password": 409, "login-id-busy": 503 };
const ACTIONS = {
  invite: { fields: ["action", "member"], created: true, run: (c, b) => inviteMember({ ...c, input: b.member }) },
  setRole: { fields: ["action", "uid", "role"], run: (c, b) => setMemberRole({ ...c, uid: b.uid, role: b.role }) },
  setAccess: { fields: ["action", "uid", "enabled"], run: (c, b) => setMemberAccess({ ...c, uid: b.uid, enabled: b.enabled }) },
  remove: { fields: ["action", "uid"], run: (c, b) => removeMemberFromBusiness({ ...c, uid: b.uid }) },
  newLink: { fields: ["action", "uid"], run: (c, b) => newMemberLink({ ...c, uid: b.uid }) },
  linkStaff: { fields: ["action", "uid", "staffId"], also: "household.manage", run: (c, b) => linkMemberToStaff({ ...c, uid: b.uid, staffId: b.staffId }) },
};

export function createMembersHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("members", async (event) => {
    const { db, auth, admin } = await loadAdmin();
    try {
      if (event.httpMethod === "GET") {
        const ctx = await requireTenant(event, { db, auth, permission: "users.view" });
        const household = ctx.workspace.templateId === "household-payroll" && ctx.permissions["household.manage"] === true;
        return respond(200, { success: true, members: await listMembers({ tenant: ctx.tenant }), roles: assignableRoles(ctx.workspace.templateId), canManage: ctx.permissions["users.manage"] === true, you: ctx.uid, ...(household ? { householdStaffAccess: true, staffWithoutLogin: await staffWithoutLogin({ tenant: ctx.tenant }) } : {}) });
      }
      if (event.httpMethod !== "POST") throw new RequestError("method-not-allowed", "Method not allowed.", 405);
      const ctx = await requireTenant(event, { db, auth, permission: "users.manage", write: true });
      const body = parseJsonBody(event, 4000);
      const action = body && Object.prototype.hasOwnProperty.call(ACTIONS, body.action) ? ACTIONS[body.action] : null;
      if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
      only(body, action.fields);
      if (action.also && ctx.permissions[action.also] !== true) throw new RequestError("forbidden", "Not allowed.", 403);
      const common = { db, admin, auth, tenant: ctx.tenant, businessId: ctx.businessId, workspace: ctx.workspace.templateId, actor: actorOf(ctx), now: now() };
      return respond(action.created ? 201 : 200, { success: true, ...(await action.run(common, body)) });
    } catch (err) {
      if (err instanceof MemberError || err instanceof ProvisioningError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createMembersHandler({ getAdmin });
