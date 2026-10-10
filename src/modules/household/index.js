// Household Staff (Phase 14; Phase 18.5 layout): one compact row per person.
//   Name | Position | Daily wage | Pay cycle | Luna login | Status | ⋯ (Edit · Login · Deactivate · Delete)
// Phase 18.6: "Create login" gives the person their own simple Luna (mark
// attendance, ask for leave or an advance, see and confirm their salary).
// Luna makes the account and a one-time activation link to send them; they
// choose their own password. Needs household.manage + users.manage.
// Delete is only for someone added by mistake (no attendance, payroll or
// advances): the server refuses it otherwise, and Deactivate keeps history.
// The daily wage and pay cycle drive attendance and payroll; Luna computes
// pay from them, nobody types base pay.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, filterBar, bindFilterBar, mobileCell, rowMenu, bindRowMenus, skeleton } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos } from "../../lib/format.js";
import { shareLinkDialog, activationUrl } from "../../components/share-link.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { PAY_CYCLES, STAFF_STATUSES, parseCentavos } from "@shared/index.js";
import * as defaultData from "./data.js";

const cycleOptions = Object.entries(PAY_CYCLES).map(([value, c]) => ({ value, label: c.label }));
const centsText = (c) => (c ? String(c / 100) : "");

function staffFields(s = {}) {
  return [
    { name: "name", label: "Name", value: s.name ?? "", required: true },
    { name: "position", label: "Position", value: s.position ?? "", hint: "e.g. Kasambahay, Yaya, Driver" },
    { name: "dailyWage", label: "Daily wage (₱)", value: centsText(s.dailyWage), required: true, inputmode: "decimal" },
    { name: "payCycle", label: "Pay cycle", type: "select", value: s.payCycle ?? "semi_monthly", options: cycleOptions },
    { name: "phone", label: "Phone", value: s.phone ?? "", inputmode: "tel" },
    { name: "startDate", label: "Start date", type: "date", value: s.startDate ?? "" },
    { name: "notes", label: "Notes", type: "textarea", value: s.notes ?? "" },
  ];
}

function toInput(v) {
  const out = { ...v, dailyWage: parseCentavos(v.dailyWage) };
  for (const k of ["position", "phone", "startDate", "notes"]) if (out[k] === "") out[k] = null;
  return out;
}

const LOGIN = { pending: ["Waiting to set up", "warning"], active: ["Active", "success"], disabled: ["Off", "neutral"] };

export function mount(container, session, { data = defaultData, toast = defaultToast, exportDeps = {}, confirm = confirmDialog, share = shareLinkDialog } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["household.manage"] === true;
  const canLogins = canManage && perms["users.manage"] === true;
  const loginBadge = (x) => (x.login ? badge(...(LOGIN[x.login.status] || [x.login.status, "neutral"])) : html`<span class="stat-hint">No login</span>`);
  const businessId = session.business.id;
  const state = { status: "active", rows: [], loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      state.rows = (await data.listStaff(businessId, { status: state.status })).rows;
      state.error = null;
    } catch (err) {
      console.error("household: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load household staff.";
    }
    state.loading = false;
    draw();
  }

  function draw() {
    if (!alive) return;
    render(
      container,
      html`
        ${pageHeader({ title: "Household Staff", subtitle: "The people you pay: their daily wage and pay cycle drive attendance and payroll.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add staff</button>` : "" })}
        ${filterBar({
          fields: [{ name: "status", label: "Status", type: "select", primary: true, def: "active", options: Object.entries(STAFF_STATUSES).map(([k, x]) => [k, x.label]), value: state.status }],
          end: mayExport(session, "householdStaff") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("householdStaff")}` : "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(4)
              : !state.rows.length
                ? emptyState({ iconName: "staff", title: state.status === "active" ? "No household staff yet" : "No inactive staff", body: "Add the people you pay to start marking attendance." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="staff">
                    <thead><tr><th class="m-only"></th><th>Name</th><th class="col-secondary">Position</th><th class="num">Daily wage</th><th class="col-secondary">Pay cycle</th><th>Luna login</th><th>Status</th><th><span class="visually-hidden">Actions</span></th></tr></thead>
                    <tbody>${state.rows.map(
                      (x) => html`<tr data-staff="${x.id}">
                        ${mobileCell({ title: x.name, sub: `${x.position || "Staff"} · ${PAY_CYCLES[x.payCycle]?.label ?? x.payCycle}`, end: formatCentavos(x.dailyWage), endSub: "per day" })}
                        <td class="cell-strong">${x.name}</td><td class="col-secondary">${x.position || "—"}</td>
                        <td class="num">${formatCentavos(x.dailyWage)}</td><td class="col-secondary">${PAY_CYCLES[x.payCycle]?.label ?? x.payCycle}</td>
                        <td data-col="login">${loginBadge(x)}</td>
                        <td>${badge(STAFF_STATUSES[x.status]?.label ?? x.status, x.status === "active" ? "success" : "neutral")}</td>
                        <td class="row-actions" data-m="more">${canManage
                          ? rowMenu(x.id, [
                              { act: "edit", label: "Edit" },
                              ...(canLogins && x.status === "active"
                                ? !x.login
                                  ? [{ act: "login", label: "Create login" }]
                                  : [...(x.login.status !== "disabled" ? [{ act: "newlink", label: x.login.status === "pending" ? "New activation link" : "Reset password (new link)" }] : []), { act: "setlogin", label: x.login.status === "disabled" ? "Turn login on" : "Turn login off" }]
                                : []),
                              { act: "status", label: x.status === "active" ? "Deactivate" : "Reactivate" },
                              { sep: true },
                              { act: "delete", label: "Delete (added by mistake)", danger: true },
                            ], { label: `Actions for ${x.name}` })
                          : ""}</td>
                      </tr>`
                    )}</tbody></table></div>`}
        </section>`
    );
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return;
    const s = state.rows.find((r) => r.id === el.dataset.id);
    try {
      if (el.dataset.act === "new") {
        const r = await formDialog({ title: "Add household staff", fields: staffFields(), submitLabel: "Save", onSubmit: (v) => data.staffApi({ action: "create", staff: toInput(v) }) });
        if (r) toast("Staff member added.", "success");
      } else if (el.dataset.act === "edit" && s) {
        const r = await formDialog({
          title: `Edit ${s.name}`,
          fields: staffFields(s),
          onSubmit: (v) => {
            const next = toInput(v);
            const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (s[k] ?? null) !== (val ?? null)));
            return Object.keys(changes).length ? data.staffApi({ action: "update", staffId: s.id, changes }) : { unchanged: true };
          },
        });
        if (r && !r.unchanged) toast("Saved.", "success");
      } else if (el.dataset.act === "login" && s) {
        const r = await formDialog({
          title: `Create a login for ${s.name}`,
          intro: `${s.name} will be able to mark attendance, ask for leave or a cash advance, and see and confirm their salary. Nothing changes pay until you approve it.`,
          fields: [{ name: "email", label: "Email (optional)", value: "", inputmode: "email", placeholder: "Leave blank if they don't use email", hint: "No email? Luna makes a login ID for them, like maria.4821." }],
          submitLabel: "Create login",
          onSubmit: (v) => data.staffApi({ action: "createLogin", staffId: s.id, ...(v.email.trim() ? { email: v.email.trim() } : {}) }),
        });
        if (!r) return;
        if (r.activationToken) await share({ title: `Send this to ${s.name}`, intro: "They open it on their phone and choose their own password. You won't know it.", link: activationUrl(r.activationToken), rows: [[r.login.includes("@") ? "Their login" : "Their login ID", r.login]], message: `Hi ${s.name.split(" ")[0]}! Set up your Luna account (login: ${r.login}):`, toast });
        else toast(`${s.name} can sign in with their existing Luna account (${r.login}).`, "success");
      } else if (el.dataset.act === "newlink" && s) {
        const ok = await confirm({ title: `New link for ${s.name}?`, body: "The old link stops working and they're signed out everywhere. They'll choose a new password with the new link.", confirmLabel: "Make new link" });
        if (!ok) return;
        const r = await data.staffApi({ action: "newLink", staffId: s.id });
        await share({ title: `Send this to ${s.name}`, intro: "They open it and choose a new password.", link: activationUrl(r.activationToken), rows: r.login ? [["Their login", r.login]] : [], message: `Hi ${s.name.split(" ")[0]}! Here's your new Luna link:`, toast });
      } else if (el.dataset.act === "setlogin" && s) {
        const on = s.login?.status === "disabled";
        if (!on && !(await confirm({ title: `Turn off ${s.name}'s login?`, body: "They're signed out and can't use Luna. Their records stay. You can turn it back on.", confirmLabel: "Turn off", danger: true }))) return;
        await data.staffApi({ action: "setLogin", staffId: s.id, enabled: on });
        toast(on ? `${s.name}'s login is on.` : `${s.name}'s login is off.`, "success");
      } else if (el.dataset.act === "status" && s) {
        await data.staffApi({ action: "setStatus", staffId: s.id, status: s.status === "active" ? "inactive" : "active" });
      } else if (el.dataset.act === "delete" && s) {
        const ok = await confirm({ title: `Delete ${s.name}?`, body: "Only for someone added by mistake. People with attendance, payroll or advances can't be deleted; deactivate them instead so their pay history stays.", confirmLabel: "Delete", danger: true });
        if (!ok) return;
        await data.staffApi({ action: "delete", staffId: s.id });
        toast(`${s.name} deleted.`, "success");
      } else return;
      load();
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    state.status = event.target.elements.status.value || "active";
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindExport = bindExport(container, () => ({ status: state.status }), { toast, deps: exportDeps });
  const unbindFilters = bindFilterBar(container);
  const unbindMenus = bindRowMenus(container);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
    unbindExport();
    unbindFilters();
    unbindMenus();
  };
}
