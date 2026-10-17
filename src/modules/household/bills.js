// Luna Household: Bills = telling Luna which household bills repeat.
//   My Bills | Sample Bills
//   My Bills: ONE row per bill (its occurrences are managed inside Luna):
//     Meralco     Monthly · next due Oct 28                          ₱5,000  ⋯ (Edit / Remove)
//     Insurance   Monthly · next due Oct 25 · Amount changes by period ₱3,000  ⋯
//   Sample Bills: Meralco ₱5,000 / PLDT ₱2,000 / Parking ₱3,000, Monthly,
//     each with + Add (opens the bill form, editable before adding).
//   + Add bill: Bill name, Amount, Category, Due date, Repeat
//     (+ Add future amount change: "₱3,000 starting Oct 1")
// A recurring bill's amount can change by period (amountSchedule): each
// occurrence takes the amount in force on its due date; paid ones keep
// theirs. Paying (and Mark unpaid) happens on Expenses, where each month's
// occurrence shows under its category. Scheduled one-time expenses aren't
// bills and aren't listed here.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, skeleton, segmented } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { parseCentavos, businessDate, upcomingPart, repeatLabel, amountOn } from "@shared/index.js";
import { categoryNameOf, resolveCategory } from "../wedding/categories.js";
import { householdCategoryField } from "./expenses.js";
import * as defaultData from "./money-data.js";

// One random key per Paid tap: a retried request records nothing twice.
export const partKey = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

// The repeat choices ("" = doesn't repeat).
export const REPEAT_OPTIONS = [
  { value: "", label: "Doesn't repeat" },
  { value: "week:1", label: "Weekly" },
  { value: "week:2", label: "Every 2 weeks" },
  { value: "month:1", label: "Monthly" },
  { value: "month:3", label: "Every 3 months" },
  { value: "month:6", label: "Every 6 months" },
  { value: "year:1", label: "Yearly" },
];
export const repeatValue = (r) => (r ? `${r.every}:${r.interval ?? 1}` : "");
export const repeatWord = (r) => REPEAT_OPTIONS.find((o) => o.value === repeatValue(r))?.label ?? (r ? repeatLabel(r) : "");
export function parseRepeat(text) {
  if (!text) return null;
  const [every, n] = text.split(":");
  return { every, interval: Number(n) || 1 };
}
export const changesByPeriod = (s) => Array.isArray(s?.amountSchedule) && s.amountSchedule.length > 1;

const pesos = (c) => (Number.isSafeInteger(c) ? (c / 100).toFixed(2) : "");
const FUTURE_SLOTS = 2;
// The bill's amounts as the editor shows them: the one in force on its due
// date (+ when it started) and the later changes (earlier periods are history).
export function amountPlan(s) {
  const sched = Array.isArray(s?.amountSchedule) ? s.amountSchedule : [];
  const due = s?.dueDate ?? "";
  const current = [...sched].reverse().find((p) => p.from <= due) ?? null;
  return { amount: s ? amountOn(sched, due) ?? s.amount : null, from: current?.from ?? "", future: sched.filter((p) => p.from > due).slice(0, FUTURE_SLOTS) };
}

// Bill name, Amount, Category, Due date, Repeat; + future amount changes.
export const billFields = (s, categories, today, prefill = null) => {
  const plan = amountPlan(s);
  return [
    { name: "description", label: "Bill name", value: s?.description ?? prefill?.description ?? "", required: true, placeholder: "e.g. Meralco, Rent, Insurance" },
    { name: "amount", label: "Amount (₱)", value: s ? pesos(plan.amount) : prefill ? pesos(prefill.amount) : "", inputmode: "decimal", required: true, hint: "Changes each month? Put the usual amount; edit it when the bill comes." },
    householdCategoryField(categories, { value: s ? categoryNameOf(categories, s.category) || s.categoryName || "" : prefill?.category ?? "Utilities" }),
    { name: "dueDate", label: s ? "Next due date" : "Due date", type: "date", value: s?.dueDate ?? today, required: true },
    { name: "repeat", label: "Repeat", type: "select", options: REPEAT_OPTIONS, value: s ? repeatValue(s.repeat) : prefill ? repeatValue(prefill.repeat) : "month:1" },
    { name: "from", label: "This amount applies from", type: "date", value: plan.from, more: true, hint: "Optional. Used when the amount changes later." },
    ...Array.from({ length: FUTURE_SLOTS }, (_, i) => [
      { name: `futureAmount${i}`, label: i ? "Another change: new amount (₱)" : "New amount (₱)", value: pesos(plan.future[i]?.amount), inputmode: "decimal", more: true },
      { name: `futureFrom${i}`, label: "Starting", type: "date", value: plan.future[i]?.from ?? "", more: true },
    ]).flat(),
  ];
};

// The amount schedule from the form, or null when the amount doesn't change.
export function parseAmountPlan(v, { amount, dueDate }) {
  const future = [];
  for (let i = 0; i < FUTURE_SLOTS; i++) {
    const a = (v[`futureAmount${i}`] || "").trim();
    const f = v[`futureFrom${i}`] || "";
    if (!a && !f) continue;
    const c = parseCentavos(a);
    if (!(c > 0)) throw new Error("Enter the new amount (more than ₱0)");
    if (!f) throw new Error("Choose when the new amount starts");
    future.push({ amount: c, from: f });
  }
  if (!future.length) return null;
  const from = v.from || dueDate;
  future.sort((x, y) => x.from.localeCompare(y.from));
  if (future[0].from <= from) throw new Error("A new amount must start after the current one");
  return [{ amount, from }, ...future];
}

export async function parseBill(v, { categories, data, canCategory }) {
  const amount = parseCentavos(v.amount);
  if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
  if (!v.dueDate) throw new Error("Choose a due date");
  const repeat = parseRepeat(v.repeat);
  const amountSchedule = parseAmountPlan(v, { amount, dueDate: v.dueDate });
  if (amountSchedule && !repeat) throw new Error("Amount changes are for repeating bills: choose how often it repeats");
  const category = await resolveCategory(v.category, { categories, data, canCreate: canCategory });
  return { description: v.description.trim(), amount, dueDate: v.dueDate, repeat, category, amountSchedule };
}

const TABS = [["mine", "My Bills"], ["sample", "Sample Bills"]];
const isBill = (s) => s.kind !== "scheduled";
// Sample Bills (a starter list; nothing is a bill until + Add).
export const SAMPLE_BILLS = Object.freeze([
  { description: "Meralco", amount: 500000, category: "Utilities", repeat: { every: "month", interval: 1 } },
  { description: "PLDT", amount: 200000, category: "Utilities", repeat: { every: "month", interval: 1 } },
  { description: "Parking", amount: 300000, category: "Transportation", repeat: { every: "month", interval: 1 } },
]);
const nameKey = (t) => String(t || "").trim().toLocaleLowerCase("en");
// One row per bill: the unpaid occurrences of the same bill (a reopened one
// and the next one already made, linked by nextId) show once, as the latest.
export function billRows(rows) {
  const upcoming = rows.filter((r) => r.status === "upcoming" && isBill(r));
  const byId = new Map(upcoming.map((r) => [r.id, r]));
  const head = (r) => {
    let x = r;
    for (let i = 0; i < 50 && x.nextId && byId.has(x.nextId); i++) x = byId.get(x.nextId);
    return x;
  };
  const groups = new Map();
  for (const r of upcoming) {
    const h = head(r);
    const g = groups.get(h.id) || { bill: h, occurrences: [] };
    g.occurrences.push(r);
    groups.set(h.id, g);
  }
  return [...groups.values()].sort((a, b) => a.bill.description.localeCompare(b.bill.description));
}

export function mount(container, session, { data = defaultData, toast = defaultToast, confirm = confirmDialog, now = () => new Date() } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["schedule.manage"] === true;
  const canCategory = perms["budget.manage"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const today = () => businessDate(session.business.timezone, now());
  const state = { view: "mine", rows: [], hasMore: false, categories: [], loading: true, error: null, busy: new Set() };
  let alive = true;
  const money = (c) => formatCentavos(c ?? 0, currency);
  const short = (d) => formatDayId(d).replace(/, \d{4}$/, "");

  async function load() {
    state.loading = !state.rows.length;
    draw();
    try {
      const [cats, page] = await Promise.all([
        state.categories.length || !perms["budget.view"] ? state.categories : data.listCategories(businessId),
        data.listBills(businessId, { status: "upcoming" }, { pageSize: 200 }),
      ]);
      state.categories = cats;
      state.rows = page.rows.filter(isBill);
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("bills: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load your bills.";
    }
    state.loading = false;
    draw();
  }

  const groupOf = (id) => billRows(state.rows).find((g) => g.bill.id === id);
  const menu = (s) =>
    canManage
      ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${s.description}">⋯</summary><div class="line-menu-list" role="menu">
          <button type="button" class="menu-item" role="menuitem" data-act="edit" data-id="${s.id}">Edit</button>
          <div class="menu-sep" role="separator"></div><button type="button" class="menu-item menu-danger" role="menuitem" data-act="remove" data-id="${s.id}">Remove</button>
        </div></details>`
      : html`<span class="wl-menu-gap" aria-hidden="true"></span>`;
  const sub = (g) => {
    const s = g.bill;
    const late = g.occurrences.filter((o) => o.dueDate < today()).length;
    return html`${s.repeat ? `${repeatWord(s.repeat)} · next due ` : "Due "}<span class="hx-due${s.dueDate < today() ? " is-over" : ""}">${short(s.dueDate)}</span>${late && g.occurrences.length > 1 ? ` · ${late} unpaid` : ""}${changesByPeriod(s) ? html` · <span data-role="by-period">Amount changes by period</span>` : ""}`;
  };
  const row = (g) => html`<li class="wl-row hx-row" data-bill="${g.bill.id}">
    <span class="wl-main hx-main"><span class="wl-name">${g.bill.description}</span><span class="wl-sub hx-sub" data-col="repeat">${sub(g)}</span></span>
    <span class="wl-amt hx-amt">${money(upcomingPart(g.bill))}</span>
    ${menu(g.bill)}
  </li>`;
  const sampleRow = (x, i, mine) => {
    const added = mine.has(nameKey(x.description));
    return html`<li class="wl-row hx-row wl-sample" data-sample="${i}">
      <span class="wl-main hx-main"><span class="wl-name">${x.description}</span><span class="wl-sub hx-sub">${repeatWord(x.repeat)} · ${x.category}</span></span>
      <span class="wl-amt hx-amt">${money(x.amount)}</span>
      ${added ? html`<span class="wl-added" data-role="added">Added ✓</span>` : canManage ? html`<button type="button" class="btn btn-compact" data-act="sample-add" data-i="${i}" aria-label="Add ${x.description}">+ Add</button>` : ""}
    </li>`;
  };

  function draw() {
    if (!alive) return;
    render(
      container,
      html`
        ${pageHeader({ title: "Bills", subtitle: html`The household bills that repeat. Unpaid ones count in Bills remaining. <a href="/expenses" data-link>Expenses ›</a>`, actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add bill</button>` : "" })}
        <div class="wl-tools">${segmented("view", TABS, state.view, { label: "Show" })}</div>
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : state.loading
            ? skeleton(4)
            : state.view === "sample"
              ? html`<p class="stat-hint wl-sample-intro">Common household bills. Tap + Add to set one up (you can change the amount, category, due date and repeat first).</p>
                  <ul class="wl-list" data-role="sample-bills">${SAMPLE_BILLS.map((x, i) => sampleRow(x, i, new Set(billRows(state.rows).map((g) => nameKey(g.bill.description)))))}</ul>`
              : !state.rows.filter(isBill).length
                ? html`<p class="stat-hint wl-none" data-role="none">No bills yet. Add the bills you pay every month, like electricity or rent, or pick from Sample Bills.</p>`
                : html`<ul class="wl-list" data-role="bills">${billRows(state.rows).map(row)}</ul>`}`
    );
  }

  const after = (message) => (r) => {
    if (!r) return false;
    if (!r.unchanged) toast(message, "success");
    load();
    return true;
  };
  const dialog = (s = null, prefill = null) => billDialog({ bill: s, prefill, categories: state.categories, today: today(), data, canCategory });

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return undefined;
    el.closest("details.line-menu")?.removeAttribute("open");
    const s = state.rows.find((r) => r.id === el.dataset.id);
    const key = `${el.dataset.act}:${el.dataset.id || ""}`;
    if (state.busy.has(key)) return undefined;
    state.busy.add(key);
    try {
      switch (el.dataset.act) {
        case "new":
          return after("Bill added.")(await dialog());
        case "seg":
          state.view = el.dataset.value;
          return draw();
        case "edit":
          return s ? after("Saved.")(await dialog(s)) : undefined;
        case "sample-add": {
          const x = SAMPLE_BILLS[Number(el.dataset.i)];
          return x ? after(`${x.description} added to My Bills.`)(await dialog(null, x)) : undefined;
        }
        case "remove": {
          const g = groupOf(el.dataset.id);
          if (!g || !(await confirm({ title: `Remove ${g.bill.description}?`, body: `It leaves Bills remaining${g.bill.repeat ? " and won't repeat" : ""}. Payments already made stay in Expenses.`, confirmLabel: "Remove bill", danger: true }))) return undefined;
          for (const o of g.occurrences) await data.scheduleApi({ action: "cancel", scheduleId: o.id, reason: "Removed" });
          return after("Bill removed.")({});
        }
        default:
          return undefined;
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
      return undefined;
    } finally {
      state.busy.delete(key);
    }
  };
  container.addEventListener("click", onClick);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
  };
}

// Add / edit a bill (shared with the Expenses list).
export function billDialog({ bill: s = null, prefill = null, categories, today, data, canCategory }) {
  return formDialog({
    title: s ? `Edit ${s.description}` : prefill ? `Add ${prefill.description}` : "Add bill",
    fields: billFields(s, categories, today, prefill),
    moreLabel: "+ Add future amount change",
    submitLabel: s ? "Save changes" : "Add bill",
    onSubmit: async (v) => {
      const next = await parseBill(v, { categories, data, canCategory });
      if (!s) {
        for (const k of ["repeat", "amountSchedule"]) if (next[k] === null) delete next[k];
        return data.scheduleApi({ action: "create", payment: next });
      }
      const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => JSON.stringify(s[k] ?? null) !== JSON.stringify(val ?? null)));
      // With amount changes, the server sets this occurrence's amount from them.
      if (changes.amountSchedule && "amount" in changes && amountOn(changes.amountSchedule, next.dueDate) !== null) delete changes.amount;
      return Object.keys(changes).length ? data.scheduleApi({ action: "update", scheduleId: s.id, expectedRevision: s.revision, changes }) : { unchanged: true };
    },
  });
}
