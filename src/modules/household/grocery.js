// Luna Household: Grocery List. A shopping checklist, one line per item:
//   ☐ Eggs                    ⋯
//     2 trays · Dairy & Eggs
// My Grocery List | Sample Grocery List. Ticking an item moves it into a
// folded "Bought (n)" at the bottom; Clear bought empties it. The sample
// library adds nothing until + Add / Add selected. Checking never records
// money: "Record grocery expense" opens Expenses (Groceries, today) for the
// trip's real total. Used by Owner / Admin here and by household staff in
// their portal (grocery.view + grocery.check; adding only when allowed).

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, skeleton, segmented } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { SAMPLE_GROCERY, GROCERY_CATEGORIES, groceryKey, sortGrocery } from "@shared/grocery.js";
import * as defaultData from "./grocery-data.js";

const itemFields = (it = {}) => [
  { name: "name", label: "Item", value: it.name ?? "", required: true, placeholder: "e.g. Eggs" },
  { name: "qty", label: "Qty (optional)", value: it.qty ?? "", placeholder: "e.g. 2 trays, 5 kg" },
  { name: "category", label: "Category (optional)", value: it.category ?? "", suggestions: GROCERY_CATEGORIES, placeholder: "e.g. Pantry" },
];
const toItem = (v) => ({ name: v.name.trim(), qty: (v.qty || "").trim() || null, category: (v.category || "").trim() || null });

export function mount(container, session, { data = defaultData, toast = defaultToast, confirm = confirmDialog, portal = false } = {}) {
  const perms = session.member.permissions || {};
  const can = { manage: perms["grocery.manage"] === true, check: perms["grocery.check"] === true, expense: perms["expenses.create"] === true };
  const businessId = session.business.id;
  const state = { rows: [], settings: { staffCanAdd: false }, loading: true, error: null, view: "mine", showBought: false, picked: new Set() };
  let alive = true;
  const canAdd = () => can.manage || (can.check && state.settings.staffCanAdd);

  async function load() {
    state.loading = !state.rows.length;
    draw();
    try {
      [state.rows, state.settings] = await Promise.all([data.listGrocery(businessId), data.grocerySettings(businessId)]);
      state.error = null;
    } catch (err) {
      console.error("grocery: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load the grocery list.";
    }
    state.loading = false;
    draw();
  }

  const sub = (it) => [it.qty, it.category].filter(Boolean).join(" · ");
  const row = (it) => html`<li class="wl-row gl-row${it.bought ? " is-bought" : ""}" data-item="${it.id}">
    <input type="checkbox" class="gl-check" data-act="check" data-id="${it.id}" ${it.bought ? "checked" : ""} ${can.check ? "" : "disabled"} aria-label="${it.bought ? "Bought" : "Mark bought"}: ${it.name}">
    <span class="wl-main gl-main"><span class="wl-name">${it.name}</span>${sub(it) ? html`<span class="wl-sub">${sub(it)}</span>` : ""}</span>
    ${can.manage
      ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${it.name}">⋯</summary><div class="line-menu-list" role="menu">
          <button type="button" class="menu-item" role="menuitem" data-act="edit" data-id="${it.id}">Edit</button>
          <div class="menu-sep" role="separator"></div><button type="button" class="menu-item menu-danger" role="menuitem" data-act="delete" data-id="${it.id}">Delete</button>
        </div></details>`
      : ""}
  </li>`;

  function mine() {
    const { active, bought } = sortGrocery(state.rows);
    if (!state.rows.length) return emptyState({ iconName: "cart", title: "Your list is empty", body: canAdd() ? "Add what you need, or pick from the Sample Grocery List." : "Nothing to buy right now." });
    return html`
      ${active.length ? html`<ul class="wl-list wl-section" data-role="grocery">${active.map(row)}</ul>` : html`<p class="stat-hint wl-none" data-role="all-bought">Everything is bought.</p>`}
      ${bought.length
        ? html`<details class="wl-fold" data-role="bought" ${state.showBought ? "open" : ""}><summary>Bought (${bought.length})</summary>
            <ul class="wl-list">${bought.map(row)}</ul>
            ${can.manage || can.expense ? html`<div class="page-actions gl-after">${can.expense ? html`<a class="btn btn-compact" href="/expenses?add=groceries" data-link data-role="record-expense">Record grocery expense</a>` : ""}${can.manage ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="clear">Clear bought</button>` : ""}</div>` : ""}
          </details>`
        : ""}`;
  }

  function samples() {
    const onList = new Set(state.rows.filter((r) => !r.bought).map((r) => r.nameLower));
    const n = state.picked.size;
    return html`<p class="stat-hint wl-sample-intro">Common household items. Nothing is added until you tap + Add${canAdd() ? " or select several" : ""}.</p>
      ${canAdd() ? html`<div class="gl-pick-bar"><button type="button" class="btn btn-primary btn-compact" data-act="add-picked" ${n ? "" : "disabled"}>Add selected${n ? ` (${n})` : ""}</button></div>` : ""}
      ${SAMPLE_GROCERY.map(
        (g, gi) => html`<section class="wl-section wl-sample-group" data-sample-group="${gi}">
          <h2 class="wl-cat-head"><span class="wl-group-title">${g.group}</span></h2>
          <ul class="wl-list" data-role="sample-grocery">${g.items.map((name, i) => {
            const id = `${gi}:${i}`;
            const added = onList.has(groceryKey(name));
            return html`<li class="wl-row wl-sample gl-sample" data-sample="${id}">
              ${canAdd() && !added ? html`<input type="checkbox" class="gl-check" data-act="pick" data-s="${id}" ${state.picked.has(id) ? "checked" : ""} aria-label="Select ${name}">` : html`<span class="gl-check-space" aria-hidden="true"></span>`}
              <span class="wl-main"><span class="wl-name">${name}</span></span>
              ${added ? html`<span class="wl-added" data-role="added">On list ✓</span>` : canAdd() ? html`<button type="button" class="btn btn-compact" data-act="sample-add" data-s="${id}" aria-label="Add ${name}">+ Add</button>` : ""}
            </li>`;
          })}</ul>
        </section>`
      )}`;
  }

  function draw() {
    if (!alive) return;
    const open = state.rows.filter((r) => !r.bought).length;
    render(
      container,
      html`
        ${portal ? html`<div class="gl-portal-head"><h2 class="section-title">Grocery List</h2>${canAdd() && state.view === "mine" ? html`<button type="button" class="btn btn-primary btn-compact" data-act="new">+ Add item</button>` : ""}</div>` : pageHeader({ title: "Grocery List", subtitle: open ? `${open} to buy` : "", actions: canAdd() ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add item</button>` : "" })}
        <div class="wl-tools">${segmented("view", [["mine", "My Grocery List"], ["sample", "Sample Grocery List"]], state.view, { label: "Grocery view" })}</div>
        ${state.error ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>` : state.loading ? skeleton(5) : state.view === "sample" ? samples() : mine()}
        ${can.manage && !portal && state.view === "mine" && !state.loading
          ? html`<label class="gl-setting"><input type="checkbox" data-act="staff-add" ${state.settings.staffCanAdd ? "checked" : ""}> Helpers can add items</label>`
          : ""}`
    );
  }

  const sampleOf = (id) => {
    const [gi, i] = id.split(":").map(Number);
    const g = SAMPLE_GROCERY[gi];
    return g && g.items[i] ? { name: g.items[i], category: g.group } : null;
  };
  const after = (message) => (r) => {
    if (!r) return false;
    if (!r.unchanged) toast(message, "success");
    load();
    return true;
  };

  async function toggle(el) {
    const it = state.rows.find((r) => r.id === el.dataset.id);
    if (!it) return;
    const bought = el.checked;
    it.bought = bought; // optimistic: the row moves at once
    it.boughtAt = bought ? new Date() : null;
    draw();
    try {
      await data.groceryApi({ action: "check", itemId: it.id, bought });
    } catch (err) {
      toast(err.message || "Couldn't save. Try again.", "danger");
    }
    load();
  }

  const onChange = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    if (el.dataset.act === "check") return toggle(el);
    if (el.dataset.act === "pick") {
      if (el.checked) state.picked.add(el.dataset.s);
      else state.picked.delete(el.dataset.s);
      return draw();
    }
    if (el.dataset.act === "staff-add") {
      try {
        await data.groceryApi({ action: "settings", staffCanAdd: el.checked });
        toast(el.checked ? "Helpers can now add items." : "Only you and admins add items now.", "success");
      } catch (err) {
        toast(err.message || "Couldn't save", "danger");
      }
      return load();
    }
    return undefined;
  };

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || ["check", "pick", "staff-add"].includes(el.dataset.act)) return undefined;
    el.closest("details.line-menu")?.removeAttribute("open");
    const it = state.rows.find((r) => r.id === el.dataset.id);
    try {
      switch (el.dataset.act) {
        case "seg":
          state.view = el.dataset.value;
          return draw();
        case "new":
          return after("Added.")(await formDialog({ title: "Add item", fields: itemFields(), submitLabel: "Add item", onSubmit: (v) => data.groceryApi({ action: "add", item: toItem(v) }) }));
        case "edit":
          if (!it) return undefined;
          return after("Saved.")(
            await formDialog({
              title: `Edit ${it.name}`,
              fields: itemFields(it),
              onSubmit: (v) => {
                const next = toItem(v);
                const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (it[k] ?? null) !== (val ?? null)));
                return Object.keys(changes).length ? data.groceryApi({ action: "update", itemId: it.id, changes }) : { unchanged: true };
              },
            })
          );
        case "delete":
          if (!it || !(await confirm({ title: `Delete ${it.name}?`, body: "It leaves the grocery list.", confirmLabel: "Delete", danger: true }))) return undefined;
          return after("Deleted.")(await data.groceryApi({ action: "remove", itemId: it.id }));
        case "clear": {
          const n = state.rows.filter((r) => r.bought).length;
          if (!(await confirm({ title: `Clear ${n} bought item${n === 1 ? "" : "s"}?`, body: "They leave the list. Your expenses aren't affected.", confirmLabel: "Clear bought" }))) return undefined;
          state.showBought = false;
          return after("Bought items cleared.")(await data.groceryApi({ action: "clearBought" }));
        }
        case "sample-add": {
          const s = sampleOf(el.dataset.s);
          if (!s) return undefined;
          el.disabled = true;
          const r = await data.groceryApi({ action: "addMany", items: [s], source: "sample" });
          state.picked.delete(el.dataset.s);
          return after(`${s.name} added.`)(r);
        }
        case "add-picked": {
          const items = [...state.picked].map(sampleOf).filter(Boolean);
          if (!items.length) return undefined;
          el.disabled = true;
          const r = await data.groceryApi({ action: "addMany", items, source: "sample" });
          state.picked.clear();
          return after(`${r.added ?? items.length} item${(r.added ?? items.length) === 1 ? "" : "s"} added to My Grocery List.`)(r);
        }
        default:
          return undefined;
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
      return undefined;
    }
  };
  const onToggle = (event) => {
    if (event.target.matches?.('details[data-role="bought"]')) state.showBought = event.target.open;
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("toggle", onToggle, true);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("toggle", onToggle, true);
  };
}
