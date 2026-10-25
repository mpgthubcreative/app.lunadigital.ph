// Crew Meals (Owner-pilot Bridal; More → Crew Meals): who needs food on the
// wedding day, how many meals, and where they get them.
//   Breakfast 64 · Lunch 76 · Dinner 27   (+ Est. ₱… when prices are set)
//   Crew list | Sample list
//   Photo Team    B 3 · L 3 · D 3    Hotel    ⋯     (phone: meals · place under the name)
// One + Add; ⋯ Edit / Details / Remove (like Money). A crew may be linked to
// one of the wedding's suppliers (optional). Saved through
// /api/wedding-crew-meals (vendors.manage edits; vendors.view reads).

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, skeleton, segmented } from "../../components/ui.js";
import { examplesState } from "../../components/examples.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos } from "../../lib/format.js";
import { parseCentavos } from "@shared/index.js";
import { MEALS, MEAL_LABELS, CREW_LOCATIONS, SAMPLE_CREW, crewTotals, mealLine } from "@shared/wedding-crew.js";
import { sampleKey } from "@shared/wedding-samples.js";
import { sampleList, sampleItem } from "./samples.js";
import { detailsDialog } from "../baby/common.js";
import { activeSuppliers as defaultSuppliers } from "./data.js";

const n = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return 0;
  const x = Number(s);
  if (!Number.isSafeInteger(x) || x < 0) throw new Error("Meals: whole numbers, 0 or more");
  return x;
};
export const crewFields = (i = {}, suppliers = []) => [
  { name: "name", label: "Crew / person", value: i.name ?? "", required: true, placeholder: "e.g. Photographer team" },
  ...MEALS.map((m) => ({ name: m, label: MEAL_LABELS[m], value: i[m] ? String(i[m]) : "", inputmode: "numeric", placeholder: "0" })),
  { name: "location", label: "Location", value: i.location ?? "", placeholder: "Hotel, Church, Reception…", suggestions: CREW_LOCATIONS },
  { name: "supplierId", label: "Linked supplier (optional)", type: "select", options: [{ value: "", label: "— None —" }, ...suppliers.map((s) => ({ value: s.id, label: s.name }))], value: i.supplierId ?? "", more: true, default: true },
  { name: "remarks", label: "Remarks", type: "textarea", value: i.remarks ?? "", more: true },
];
export function toCrewInput(v) {
  return { name: v.name.trim(), breakfast: n(v.breakfast), lunch: n(v.lunch), dinner: n(v.dinner), location: (v.location || "").trim() || null, supplierId: v.supplierId || null, remarks: (v.remarks || "").trim() || null };
}

export function mount(container, session, { api = defaultApi, toast = defaultToast, confirm = confirmDialog, activeSuppliers = defaultSuppliers } = {}) {
  const canManage = session.member.permissions["vendors.manage"] === true;
  const currency = session.business.currency || "PHP";
  const state = { mode: "mine", items: [], prices: {}, suppliers: [], loading: true, error: null };
  let alive = true;
  const call = (body) => api("wedding-crew-meals", { method: "POST", body });
  const money = (c) => formatCentavos(c, currency).replace(/\.00$/, "");

  async function load() {
    try {
      const [r, sup] = await Promise.all([call({ action: "list" }), activeSuppliers(session.business.id).catch(() => [])]);
      state.items = r.items || [];
      state.prices = r.prices || {};
      state.suppliers = sup || [];
      state.error = null;
    } catch (err) {
      state.error = err.message || "Couldn't load crew meals.";
    }
    state.loading = false;
    draw();
  }

  const menu = (it) =>
    html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${it.name}">⋯</summary><div class="line-menu-list" role="menu">${[
      ...(canManage ? [{ act: "edit", label: "Edit" }] : []),
      { act: "view", label: "Details" },
      ...(canManage ? [{ act: "remove", label: "Remove", danger: true }] : []),
    ].map((m) => html`${m.danger ? html`<div class="menu-sep" role="separator"></div>` : ""}<button type="button" class="menu-item${m.danger ? " menu-danger" : ""}" role="menuitem" data-act="${m.act}" data-id="${it.id}">${m.label}</button>`)}</div></details>`;
  const row = (it) =>
    html`<li class="wl-row wl-crew" data-crew="${it.id}">
      <button type="button" class="wl-main" data-act="view" data-id="${it.id}"><span class="wl-name">${it.name}</span><span class="wl-sub m-only-inline" data-role="sub">${[mealLine(it), it.location].filter(Boolean).join(" · ")}</span></button>
      <span class="wl-col wl-crew-meals d-only" data-role="meals">${mealLine(it)}</span>
      <span class="wl-col wl-crew-place d-only" data-role="place">${it.location || "—"}</span>
      ${menu(it)}
    </li>`;

  function summary() {
    const t = crewTotals(state.items, state.prices);
    return html`<p class="wl-count" data-role="crew-summary">${MEALS.map((m, i) => html`${i ? " · " : ""}${MEAL_LABELS[m]} <b>${t[m]}</b>`)}${t.cost !== null ? html` · Est. <b>${money(t.cost)}</b>` : ""}${canManage ? html` <button type="button" class="btn btn-compact btn-ghost" data-act="prices">${t.cost === null ? "Meal prices" : "Edit prices"}</button>` : ""}</p>`;
  }

  function body() {
    if (state.mode === "sample") {
      return sampleList({ groups: [{ id: "crew", label: "Common wedding crews", items: SAMPLE_CREW.map((title) => ({ title, optional: false })) }], added: new Set(state.items.map((i) => sampleKey(i.name))), canAdd: canManage, role: "sample-crew", intro: "Teams that usually need meals on the day. Tap + Add for the ones you have, then set how many meals." });
    }
    if (!state.items.length)
      return examplesState({
        title: "No crew meals yet",
        body: "Each team that needs food on the day, and how many meals:",
        items: [
          { name: "Photographer team", sub: "4 meals · Lunch" },
          { name: "Videographer team", sub: "3 meals" },
          { name: "Coordinator team", sub: "5 meals" },
          { name: "Lights & sounds", sub: "4 meals" },
        ],
        add: canManage ? { act: "new", label: "+ Add Crew Meal" } : null,
        helper: "Or pick from the Sample list above.",
        role: "crew-examples",
      });
    return html`<ul class="wl-list" data-role="crew">${state.items.map(row)}</ul>`;
  }

  function draw() {
    if (!alive) return;
    render(
      container,
      html`
        ${pageHeader({ title: "Crew Meals", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add</button>` : "" })}
        ${state.loading || state.error ? "" : summary()}
        <div class="wl-tools">${segmented("mode", [["mine", "Crew list"], ["sample", "Sample list"]], state.mode, { label: "Crew meals view" })}</div>
        ${state.error ? emptyState({ title: "Couldn't load", body: state.error }) : state.loading ? skeleton(5) : body()}`
    );
  }

  const dialog = (it, prefill = {}) =>
    formDialog({
      title: it ? `Edit: ${it.name}` : "Add crew meals",
      fields: crewFields(it || prefill, state.suppliers),
      moreLabel: "More options",
      submitLabel: it ? "Save changes" : "Add",
      onSubmit: (v) => {
        const input = toCrewInput(v);
        if (!it) return call({ action: "create", item: input });
        const changes = Object.fromEntries(Object.entries(input).filter(([k, val]) => (it[k] ?? null) !== (val ?? null)));
        return Object.keys(changes).length ? call({ action: "update", itemId: it.id, changes }) : { unchanged: true };
      },
    });
  const pricesDialog = () =>
    formDialog({
      title: "Meal prices (optional)",
      intro: "Cost per head, for an estimated total. Leave blank if you don't know yet.",
      fields: MEALS.map((m) => ({ name: m, label: `${MEAL_LABELS[m]} per head (₱)`, value: Number.isSafeInteger(state.prices[m]) ? String(state.prices[m] / 100) : "", inputmode: "decimal" })),
      submitLabel: "Save",
      onSubmit: (v) => {
        const prices = {};
        for (const m of MEALS) {
          const s = String(v[m] || "").trim();
          prices[m] = s ? parseCentavos(s) : null;
          if (s && !(prices[m] >= 0)) throw new Error(`${MEAL_LABELS[m]}: enter an amount`);
        }
        return call({ action: "setPrices", prices });
      },
    });
  const after = (message) => (r) => {
    if (r && !r.unchanged) {
      toast(message, "success");
      load();
    }
  };
  const view = (it) =>
    detailsDialog({
      title: it.name,
      rows: [...MEALS.map((m) => [MEAL_LABELS[m], String(it[m] ?? 0)]), ["Location", it.location || "—"], ["Linked supplier", it.supplierName], ["Remarks", it.remarks]],
      actions: [],
      onAction: async () => false,
    });

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    el.closest("details.line-menu")?.removeAttribute("open");
    const a = el.dataset.act;
    const it = state.items.find((x) => x.id === el.dataset.id);
    try {
      if (a === "seg") {
        state.mode = el.dataset.value === "sample" ? "sample" : "mine";
        draw();
      } else if (a === "new") after("Added.")(await dialog(null));
      else if (a === "prices") after("Prices saved.")(await pricesDialog());
      else if (a === "sample-add") {
        const pick = sampleItem([{ id: "crew", items: SAMPLE_CREW.map((title) => ({ title })) }], el);
        if (pick) after(`Added: ${pick.item.title}`)(await dialog(null, { name: pick.item.title }));
      } else if (!it) return;
      else if (a === "view") view(it);
      else if (a === "edit") after("Saved.")(await dialog(it));
      else if (a === "remove") {
        if (!(await confirm({ title: `Remove ${it.name}?`, body: "It's taken off your crew meals list.", confirmLabel: "Remove", danger: true }))) return;
        await call({ action: "delete", itemId: it.id });
        toast("Removed.", "success");
        load();
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  container.addEventListener("click", onClick);
  draw();
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
  };
}
