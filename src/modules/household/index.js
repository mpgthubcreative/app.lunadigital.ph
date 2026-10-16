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
import { PAY_CYCLES, STAFF_STATUSES, parseCentavos, cycleLabel } from "@shared/index.js";
import * as defaultData from "./data.js";

const cycleOptions = Object.entries(PAY_CYCLES).map(([value, c]) => ({ value, label: c.label }));
const centsText = (c) => (c ? String(c / 100) : "");
const REST_OPTIONS = [["0", "Sunday"], ["1", "Monday"], ["2", "Tuesday"], ["3", "Wednesday"], ["4", "Thursday"], ["5", "Friday"], ["6", "Saturday"], ["0,6", "Saturday and Sunday"], ["none", "No usual rest day"]].map(([value, label]) => ({ value, label }));

function staffFields(s = {}, leaveDefault = null) {
  return [
    { name: "name", label: "Name", value: s.name ?? "", required: true },
    { name: "position", label: "Position", value: s.position ?? "", hint: "e.g. Kasambahay, Yaya, Driver" },
    { name: "dailyWage", label: "Daily wage (₱)", value: centsText(s.dailyWage), required: true, inputmode: "decimal" },
    { name: "payCycle", label: "Pay cycle", type: "select", value: s.payCycle ?? "semi_monthly", options: cycleOptions },
    // Owner-pilot batch: custom semi-monthly cutoffs and the advance limit.
    { name: "cutoffs", label: "Semi-monthly cutoff days", value: Array.isArray(s.cutoffs) ? `${s.cutoffs[0]} and ${s.cutoffs[1]}` : "", placeholder: "15 and end of month", hint: "Last day of each period, e.g. 14 and 29. Leave blank for 1–15 and 16–end. Short months stop at their last day." },
    { name: "advanceLimit", label: "Cash advance limit (₱)", value: Number.isSafeInteger(s.advanceLimit) ? String(s.advanceLimit / 100) : "", inputmode: "decimal", placeholder: "No limit", hint: "The most they can owe at once. Blank = no limit; 0 = no advances." },
    // Owner-pilot cleanup: blank = the household's Paid Leave allowance.
    { name: "paidLeaveDays", label: "Paid Leave days a year", value: Number.isSafeInteger(s.paidLeaveDays) ? String(s.paidLeaveDays) : "", inputmode: "numeric", placeholder: leaveDefault === null ? "Household default" : `Household default (${leaveDefault})`, hint: "Only if this helper gets a different number. Counted per calendar year." },
    // Owner-pilot polish: the normal week ("Fill normal schedule" on Attendance).
    { name: "restDays", label: "Usual rest day", type: "select", value: (Array.isArray(s.restDays) ? s.restDays : [0]).join(",") || "none", options: REST_OPTIONS, hint: "Other days are working days. Attendance can fill the normal week for you; nothing is recorded until you confirm." },
    { name: "phone", label: "Phone", value: s.phone ?? "", inputmode: "tel" },
    { name: "startDate", label: "Start date", type: "date", value: s.startDate ?? "", hint: "Payroll includes them from this date." },
    { name: "endDate", label: "End date (if they've left)", type: "date", value: s.endDate ?? "", hint: "No payroll after this date; their history stays." },
    { name: "notes", label: "Notes", type: "textarea", value: s.notes ?? "" },
  ];
}

// "14 and 29" -> [14, 29]; blank -> null (1–15 / 16–end). "end" = 31.
export function parseCutoffs(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return null;
  const nums = t.replace(/end( of (the )?month)?/g, "31").match(/\d+/g) || [];
  if (nums.length !== 2) throw new Error("Write the two cutoff days, e.g. 14 and 29");
  return nums.map(Number);
}

function toInput(v) {
  const out = { ...v, dailyWage: parseCentavos(v.dailyWage), cutoffs: v.payCycle === "semi_monthly" ? parseCutoffs(v.cutoffs) : null, advanceLimit: String(v.advanceLimit ?? "").trim() === "" ? null : parseCentavos(v.advanceLimit), paidLeaveDays: String(v.paidLeaveDays ?? "").trim() === "" ? null : Number(String(v.paidLeaveDays).trim()), restDays: v.restDays === undefined ? undefined : v.restDays === "none" ? [] : String(v.restDays).split(",").map(Number) };
  if (out.restDays === undefined) delete out.restDays;
  if (out.paidLeaveDays !== null && !(Number.isInteger(out.paidLeaveDays) && out.paidLeaveDays >= 0)) throw new Error("Paid Leave days must be a whole number (blank = household default)");
  if (out.cutoffs && out.cutoffs[0] === 15 && out.cutoffs[1] === 31) out.cutoffs = null;
  if (out.advanceLimit !== null && !(out.advanceLimit >= 0)) throw new Error("The advance limit must be ₱0 or more (blank = no limit)");
  for (const k of ["position", "phone", "startDate", "endDate", "notes"]) if (out[k] === "") out[k] = null;
  return out;
}

const LOGIN = { pending: ["Waiting to set up", "warning"], active: ["Active", "success"], disabled: ["Off", "neutral"] };

export function mount(container, session, { data = defaultData, toast = defaultToast, exportDeps = {}, confirm = confirmDialog, share = shareLinkDialog } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["household.manage"] === true;
  const canLogins = canManage && perms["users.manage"] === true;
  const loginBadge = (x) => (x.login ? badge(...(LOGIN[x.login.status] || [x.login.status, "neutral"])) : html`<span class="stat-hint">No login</span>`);
  const businessId = session.business.id;
  const state = { status: "active", rows: [], loading: true, error: null, settings: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      state.rows = (await data.listStaff(businessId, { status: state.status })).rows;
      if (canManage && !state.settingsAsked) {
        state.settingsAsked = true;
        state.settings = (await data.staffApi({ action: "settings" }).catch(() => null))?.settings ?? null;
      }
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
        ${pageHeader({ title: "Household Staff", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add staff</button>` : "" })}
        ${canManage && state.settings ? html`<p class="chart-note" data-role="leave-default">Paid Leave allowance: <strong>${state.settings.paidLeaveDays} day${state.settings.paidLeaveDays === 1 ? "" : "s"} a year</strong> per helper (Jan–Dec). <button type="button" class="btn btn-compact btn-ghost" data-act="leave-default">Change</button></p>` : ""}
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
                        ${mobileCell({ title: x.name, sub: `${x.position || "Staff"} · ${cycleLabel(x)}${Number.isSafeInteger(x.advanceLimit) ? ` · advance limit ${formatCentavos(x.advanceLimit)}` : ""}`, end: formatCentavos(x.dailyWage), endSub: "per day" })}
                        <td class="cell-strong">${x.name}</td><td class="col-secondary">${x.position || "—"}</td>
                        <td class="num">${formatCentavos(x.dailyWage)}</td><td class="col-secondary">${cycleLabel(x)}${Number.isSafeInteger(x.advanceLimit) ? html`<span class="cell-sub">Advance limit ${formatCentavos(x.advanceLimit)}</span>` : ""}</td>
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
      if (el.dataset.act === "leave-default") {
        const r = await formDialog({ title: "Paid Leave allowance", intro: "Days of Paid Leave each helper gets per calendar year (Jan 1 to Dec 31). A helper with their own number on Household Staff keeps it.", fields: [{ name: "days", label: "Days per year", value: String(state.settings?.paidLeaveDays ?? 5), required: true, inputmode: "numeric" }], submitLabel: "Save", onSubmit: (v) => {
          const n = Number(String(v.days).trim());
          if (!Number.isInteger(n) || n < 0) throw new Error("Enter a whole number of days");
          return data.staffApi({ action: "saveSettings", settings: { paidLeaveDays: n } });
        } });
        if (!r) return;
        state.settingsAsked = false;
        toast("Paid Leave allowance saved.", "success");
      } else if (el.dataset.act === "new") {
        const r = await formDialog({ title: "Add household staff", fields: staffFields({}, state.settings?.paidLeaveDays ?? null), submitLabel: "Save", onSubmit: (v) => data.staffApi({ action: "create", staff: toInput(v) }) });
        if (r) toast("Staff member added.", "success");
      } else if (el.dataset.act === "edit" && s) {
        const r = await formDialog({
          title: `Edit ${s.name}`,
          fields: staffFields(s, state.settings?.paidLeaveDays ?? null),
          onSubmit: (v) => {
            const next = toInput(v);
            const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => JSON.stringify(s[k] ?? null) !== JSON.stringify(val ?? null)));
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
        // Owner-pilot cleanup: a deactivated helper gets no new payroll.
        if (s.status === "active" && !(await confirm({ title: `Deactivate ${s.name}?`, body: "They stop appearing on Attendance and Payroll, including the current pay period, so pay any salary still owed first. Their attendance, payroll and advance history stays. Their Luna login is managed separately under Users.", confirmLabel: "Deactivate", danger: true }))) return;
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
