// Users (Phase 18.6): the Owner manages the team here, no Luna help needed.
//   Member | Login | Role | Status | actions (Change role · New activation
//   link · Deactivate access / Restore access · Remove user)
// Owner-pilot cleanup: Deactivate access = temporary ("No access", can be
// restored); Remove user = the membership goes for good (records stay).
// "Add member" creates the account with no password and shows a one-time
// activation link to send; the person chooses their own password. Every
// rule (no self-changes, owner protected, no Owner role, user limit) is
// checked by the server (/api/members); the screen only asks.
// Role templates are a small reference section at the bottom.

import { ROLE_TEMPLATES, PERMISSION_KEYS } from "@shared/index.js";
import { html, render } from "../../lib/html.js";
import { pageHeader, card, badge, emptyState, skeleton, mobileCell, rowMenu, bindRowMenus } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { shareLinkDialog, activationUrl } from "../../components/share-link.js";
import { api as defaultApi } from "../../lib/api.js";

const STATUS = { active: ["Active", "success"], disabled: ["No access", "neutral"] };

export function mount(container, session, { api = defaultApi, toast = defaultToast, confirm = confirmDialog, share = shareLinkDialog } = {}) {
  const state = { members: [], roles: [], canManage: false, you: null, householdStaffAccess: false, staffWithoutLogin: [], loading: true, error: null };
  let alive = true;

  async function load() {
    try {
      const r = await api("members");
      Object.assign(state, { members: r.members || [], roles: r.roles || [], canManage: r.canManage === true, you: r.you, householdStaffAccess: r.householdStaffAccess === true, staffWithoutLogin: r.staffWithoutLogin || [], error: null });
    } catch (err) {
      state.error = err.message || "Couldn't load your team.";
    }
    state.loading = false;
    if (alive) draw();
  }

  const roleOptions = () => state.roles.map((id) => ({ value: id, label: ROLE_TEMPLATES[id]?.label ?? id }));
  const statusOf = (m) => (m.status === "active" && m.activation === "pending" ? badge("Not set up yet", "warning") : badge(...(STATUS[m.status] || [m.status, "neutral"])));
  const actionsFor = (m) => {
    if (!state.canManage || m.isAccountOwner || m.uid === state.you) return "";
    const items = [];
    if (m.status === "active" && !m.householdStaff && state.roles.length > 1) items.push({ act: "role", label: "Change role" });
    // Owner-pilot fix: a kasambahay who was added as Manager / Admin.
    if (state.householdStaffAccess && !m.householdStaff) items.push({ act: "make-staff", label: "Make household staff" });
    if (m.status === "active" && (m.activation === "pending" || m.usesLoginId)) items.push({ act: "link", label: m.activation === "pending" ? "New activation link" : "Reset password (new link)" });
    items.push(m.status === "active" ? { act: "deactivate", label: "Deactivate access" } : { act: "restore", label: "Restore access" });
    items.push({ sep: true }, { act: "remove-user", label: "Remove user", danger: true });
    return rowMenu(m.uid, items, { label: `Actions for ${m.name}` });
  };

  function draw() {
    if (!alive) return;
    const templates = Object.entries(ROLE_TEMPLATES);
    render(
      container,
      html`
        ${pageHeader({ title: "Users", subtitle: "Who can sign in to Luna.", actions: state.canManage ? html`<button type="button" class="btn btn-primary" data-act="add">+ Add member</button>` : "" })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(4)
              : html`<div class="table-wrap"><table class="table table-compact rows" data-role="members">
                  <thead><tr><th class="m-only"></th><th>Member</th><th class="col-secondary">Login</th><th>Role</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
                  <tbody>${state.members.map(
                    (m) => html`<tr data-member="${m.uid}">
                      ${mobileCell({ title: `${m.name}${m.uid === state.you ? " (you)" : ""}`, sub: `${m.isAccountOwner ? "Owner" : m.roleLabel} · ${m.login}`, end: m.status === "active" ? (m.activation === "pending" ? "Not set up" : "Active") : "No access" })}
                      <td class="cell-strong">${m.name}${m.uid === state.you ? html` <span class="stat-hint">(you)</span>` : ""}</td>
                      <td class="col-secondary">${m.login}${m.usesLoginId ? html` <span class="stat-hint">login ID</span>` : ""}</td>
                      <td data-col="role">${m.isAccountOwner ? badge("Owner", "primary") : m.roleLabel}</td>
                      <td data-col="status">${statusOf(m)}</td>
                      <td class="row-actions" data-m="more">${actionsFor(m)}</td>
                    </tr>`
                  )}</tbody></table></div>`}
        </section>
        <details class="card section roles-ref" data-role="role-templates">
          <summary class="card-title">Role templates</summary>
          <ul class="list">${templates.map(([id, t]) => html`<li><strong>${t.label}</strong> · ${t.description} <span class="stat-hint">${t.permissions.length} of ${PERMISSION_KEYS.length} permissions</span></li>`)}</ul>
        </details>
      `
    );
  }

  // Household: a kasambahay's login is ALWAYS linked to their staff record
  // (Household Staff access: their own attendance, leave, advances, salary).
  async function addHouseholdStaff() {
    if (!state.staffWithoutLogin.length) {
      toast("Add the kasambahay under Household Staff first, then give them a login here.", "danger");
      return;
    }
    const r = await formDialog({
      title: "Give a kasambahay a login",
      intro: "Household Staff access: they mark their own attendance, ask for leave or a cash advance, and see their own salary. Nothing else.",
      fields: [
        { name: "staffId", label: "Staff record", type: "select", options: state.staffWithoutLogin.map((s) => ({ value: s.id, label: s.name })), value: state.staffWithoutLogin[0].id },
        { name: "email", label: "Email (optional)", inputmode: "email", placeholder: "Leave blank if they don't use email", hint: "No email? Luna makes a login ID for them, like ana.4821." },
      ],
      submitLabel: "Create login",
      onSubmit: (v) => api("household-staff", { method: "POST", body: { action: "createLogin", staffId: v.staffId, ...(v.email.trim() ? { email: v.email.trim() } : {}) } }),
    });
    if (!r) return;
    if (r.activationToken) await share({ title: "Send this to them", intro: "They open it and choose their own password. You won't know it.", link: activationUrl(r.activationToken), rows: [[r.login.includes("@") ? "Their login" : "Their login ID", r.login]], message: `You've been added to ${session.business.name} on Luna (login: ${r.login}). Set up your account:`, toast });
    else toast(`Linked. They sign in with their existing Luna account (${r.login}).`, "success");
    load();
  }

  async function add() {
    if (state.householdStaffAccess) {
      const kind = await formDialog({
        title: "Add a member",
        fields: [{ name: "kind", label: "Access type", type: "select", value: "household_staff", options: [{ value: "household_staff", label: "Household Staff (kasambahay): their own attendance, leave, advances and salary" }, { value: "manager", label: "Manager / Admin: helps run the household's payroll" }] }],
        submitLabel: "Next",
        onSubmit: (v) => ({ kind: v.kind }),
      });
      if (!kind) return;
      if (kind.kind === "household_staff") return addHouseholdStaff();
    }
    const r = await formDialog({
      title: "Add a member",
      intro: "Luna makes their account and gives you a link to send them. They choose their own password.",
      fields: [
        { name: "name", label: "Name", required: true },
        { name: "email", label: "Email (optional)", inputmode: "email", placeholder: "Leave blank if they don't use email", hint: "No email? Luna makes a login ID for them, like ana.4821." },
        { name: "role", label: "Role", type: "select", options: roleOptions(), value: state.roles[0] },
      ],
      submitLabel: "Add member",
      onSubmit: (v) => api("members", { method: "POST", body: { action: "invite", member: { name: v.name.trim(), role: v.role, ...(v.email.trim() ? { email: v.email.trim() } : {}) } } }),
    });
    if (!r) return;
    if (r.activationToken) await share({ title: "Send this to the new member", intro: "They open it and choose their own password. You won't know it.", link: activationUrl(r.activationToken), rows: [[r.login.includes("@") ? "Their login" : "Their login ID", r.login]], message: `You've been added to ${session.business.name} on Luna (login: ${r.login}). Set up your account:`, toast });
    else toast(`Added. They sign in with their existing Luna account (${r.login}).`, "success");
    load();
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    const m = state.members.find((x) => x.uid === el.dataset.id);
    try {
      if (el.dataset.act === "add") return add();
      if (!m) return;
      if (el.dataset.act === "make-staff") {
        if (!state.staffWithoutLogin.length) {
          toast("Add their staff record under Household Staff first.", "danger");
          return;
        }
        const r = await formDialog({
          title: `Make ${m.name} household staff`,
          intro: `${m.name} keeps their login but gets Household Staff access only (their own attendance, leave, advances and salary). ${m.role === "manager" ? "Their Manager / Admin access is removed." : ""}`,
          fields: [{ name: "staffId", label: "Their staff record", type: "select", options: state.staffWithoutLogin.map((s) => ({ value: s.id, label: s.name })), value: state.staffWithoutLogin[0].id }],
          submitLabel: "Make household staff",
          onSubmit: (v) => api("members", { method: "POST", body: { action: "linkStaff", uid: m.uid, staffId: v.staffId } }),
        });
        if (r) toast(`${m.name} now has Household Staff access.`, "success");
        if (r) load();
        return;
      }
      if (el.dataset.act === "role") {
        const r = await formDialog({ title: `Change ${m.name}'s role`, fields: [{ name: "role", label: "Role", type: "select", options: roleOptions(), value: m.role }], submitLabel: "Save", onSubmit: (v) => api("members", { method: "POST", body: { action: "setRole", uid: m.uid, role: v.role } }) });
        if (r && !r.unchanged) toast("Role changed.", "success");
      } else if (el.dataset.act === "deactivate") {
        if (!(await confirm({ title: `Deactivate ${m.name}'s access?`, body: "They're signed out and can't use Luna for this business until you restore access. Everything they recorded stays.", confirmLabel: "Deactivate access", danger: true }))) return;
        await api("members", { method: "POST", body: { action: "setAccess", uid: m.uid, enabled: false } });
        toast(`${m.name} no longer has access.`, "success");
      } else if (el.dataset.act === "remove-user") {
        const body = m.householdStaff
          ? "They will no longer be able to sign in to this Household workspace. Their attendance, payroll and advance history will be kept. This does not automatically deactivate their Household Staff employment record."
          : "They will no longer be able to sign in to this business, and they leave this list. Everything they recorded stays.";
        if (!(await confirm({ title: `Remove ${m.name}'s Luna access?`, body, confirmLabel: "Remove user", danger: true }))) return;
        await api("members", { method: "POST", body: { action: "remove", uid: m.uid } });
        toast(`${m.name} was removed.`, "success");
      } else if (el.dataset.act === "restore") {
        await api("members", { method: "POST", body: { action: "setAccess", uid: m.uid, enabled: true } });
        toast(`${m.name} has access again.`, "success");
      } else if (el.dataset.act === "link") {
        const r = await api("members", { method: "POST", body: { action: "newLink", uid: m.uid } });
        await share({ title: `Send this to ${m.name}`, intro: "The old link stops working. They choose a new password with this one.", link: activationUrl(r.activationToken), rows: [["Their login", r.login]], message: `Your Luna link for ${session.business.name}:`, toast });
      } else return;
      load();
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  container.addEventListener("click", onClick);
  const unbindMenus = bindRowMenus(container);
  draw();
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    unbindMenus();
  };
}
