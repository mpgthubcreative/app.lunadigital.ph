// Luna Household: Bills = telling Luna which household bills repeat.
//   + Add bill: Bill name, Amount, Category, Due date, Repeat
//     (+ Add future amount change: "₱3,000 starting Oct 1")
//   Bills | Paid history, one compact line each:
//     Insurance   Monthly · next due Nov 25 · Amount changes by period   ₱3,000  ⋯ (Paid / Edit / Remove)
//     Parking     Paid Oct 15                                             ₱3,000  ⋯ (Mark unpaid / Remove)
// One row per bill: a recurring bill has one next occurrence at a time (the
// next is created when it's paid), and its amount can change by period
// (amountSchedule): each occurrence takes the amount in force on its due
// date; paid ones keep theirs. Scheduled one-time expenses (Expenses →
// Schedule for later) aren't bills and aren't listed here.
// "Paid" records ONE expense (idempotent mark-paid: cash, today, the full
// amount; the expense can be edited after). "Mark unpaid" removes it.

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
export const billFields = (s, categories, today) => {
  const plan = amountPlan(s);
  return [
    { name: "description", label: "Bill name", value: s?.description ?? "", required: true, placeholder: "e.g. Meralco, Rent, Insurance" },
    { name: "amount", label: "Amount (₱)", value: s ? pesos(plan.amount) : "", inputmode: "decimal", required: true, hint: "Changes each month? Put the usual amount; edit it when the bill comes." },
    householdCategoryField(categories, { value: s ? categoryNameOf(categories, s.category) || s.categoryName || "" : "Utilities" }),
    { name: "dueDate", label: s ? "Next due date" : "Due date", type: "date", value: s?.dueDate ?? today, required: true },
    { name: "repeat", label: "Repeat", type: "select", options: REPEAT_OPTIONS, value: s ? repeatValue(s.repeat) : "month:1" },
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

const TABS = [["upcoming", "Bills"], ["paid", "Paid history"]];
const isBill = (s) => s.kind !== "scheduled";

export function mount(container, session, { data = defaultData, toast = defaultToast, confirm = confirmDialog, now = () => new Date() } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["schedule.manage"] === true;
  const canPay = canManage && perms["expenses.create"] === true;
  const canUnpay = perms["expenses.delete"] === true;
  const canCategory = perms["budget.manage"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const today = () => businessDate(session.business.timezone, now());
  const state = { status: "upcoming", rows: [], hasMore: false, categories: [], loading: true, error: null, busy: new Set() };
  let alive = true;
  const money = (c) => formatCentavos(c ?? 0, currency);
  const short = (d) => formatDayId(d).replace(/, \d{4}$/, "");

  async function load() {
    state.loading = !state.rows.length;
    draw();
    try {
      const [cats, page] = await Promise.all([
        state.categories.length || !perms["budget.view"] ? state.categories : data.listCategories(businessId),
        data.listBills(businessId, { status: state.status }, { pageSize: 100 }),
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

  const items = (s) =>
    s.status === "upcoming"
      ? [...(canPay ? [{ act: "paid", label: "Paid" }] : []), ...(canManage ? [{ act: "edit", label: "Edit" }, { sep: true }, { act: "remove", label: "Remove", danger: true }] : [])]
      : s.status === "paid" && s.expenseId && canUnpay
        ? [{ act: "unpaid", label: "Mark unpaid" }, ...(canManage ? [{ sep: true }, { act: "remove-paid", label: "Remove", danger: true }] : [])]
        : [];
  const menu = (s) => {
    const list = items(s);
    return list.length
      ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="More for ${s.description}">⋯</summary><div class="line-menu-list" role="menu">
          ${list.map((i) => (i.sep ? html`<div class="menu-sep" role="separator"></div>` : html`<button type="button" class="menu-item${i.danger ? " menu-danger" : ""}" role="menuitem" data-act="${i.act}" data-id="${s.id}">${i.label}</button>`))}
        </div></details>`
      : html`<span class="wl-menu-gap" aria-hidden="true"></span>`;
  };
  const sub = (s) =>
    s.status === "paid"
      ? `Paid ${short(s.paidDate || s.dueDate)}`
      : html`${s.repeat ? `${repeatWord(s.repeat)} · next due ` : "Due "}<span class="hx-due${s.dueDate < today() ? " is-over" : ""}">${short(s.dueDate)}</span>${changesByPeriod(s) ? html` · <span data-role="by-period">Amount changes by period</span>` : ""}`;
  const row = (s) => html`<li class="wl-row hx-row" data-bill="${s.id}">
    <span class="wl-main hx-main"><span class="wl-name">${s.description}</span><span class="wl-sub hx-sub" data-col="repeat">${sub(s)}</span></span>
    <span class="wl-amt hx-amt">${money(s.status === "paid" ? s.paidAmount ?? s.amount : upcomingPart(s))}</span>
    ${menu(s)}
  </li>`;

  function draw() {
    if (!alive) return;
    render(
      container,
      html`
        ${pageHeader({ title: "Bills", subtitle: html`The household bills that repeat. Unpaid ones count in Bills remaining. <a href="/expenses" data-link>Expenses ›</a>`, actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add bill</button>` : "" })}
        <div class="wl-tools">${segmented("status", TABS, state.status, { label: "Show" })}</div>
        ${state.error
          ? html`<section class="card">${emptyState({ title: "Couldn't load", body: state.error })}</section>`
          : state.loading
            ? skeleton(4)
            : !state.rows.length
              ? html`<p class="stat-hint wl-none" data-role="none">${state.status === "upcoming" ? "No bills yet. Add the bills you pay every month, like electricity or rent." : "No paid bills yet."}</p>`
              : html`<ul class="wl-list" data-role="bills">${state.rows.map(row)}</ul>${state.hasMore ? html`<p class="stat-hint">Showing the first 100.</p>` : ""}`}`
    );
  }

  const after = (message) => (r) => {
    if (!r) return false;
    if (!r.unchanged) toast(message, "success");
    load();
    return true;
  };
  const dialog = (s = null) => billDialog({ bill: s, categories: state.categories, today: today(), data, canCategory });

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
          state.status = el.dataset.value;
          state.rows = [];
          return load();
        case "edit":
          return s ? after("Saved.")(await dialog(s)) : undefined;
        case "paid": {
          if (!s) return undefined;
          const r = await data.scheduleApi({ action: "markPaid", scheduleId: s.id, payment: { method: "cash", amount: upcomingPart(s), paidDate: today(), final: true, key: partKey() } });
          return after(r?.alreadyPaid ? "Already paid." : r?.nextScheduleId ? `${s.description} paid. The next one is scheduled.` : `${s.description} paid.`)(r);
        }
        case "unpaid":
          if (!s || !(await confirm({ title: `Mark ${s.description} unpaid?`, body: "Its payment no longer counts as spent and the bill goes back to Bills remaining.", confirmLabel: "Mark unpaid" }))) return undefined;
          return after("Marked unpaid.")(await data.expensesApi({ action: "remove", expenseId: s.expenseId, reason: "Marked unpaid" }));
        case "remove":
          if (!s || !(await confirm({ title: `Remove ${s.description}?`, body: `It leaves Bills remaining${s.repeat ? " and won't repeat" : ""}.`, confirmLabel: "Remove bill", danger: true }))) return undefined;
          return after("Bill removed.")(await data.scheduleApi({ action: "cancel", scheduleId: s.id, reason: "Removed" }));
        case "remove-paid":
          if (!s || !(await confirm({ title: `Remove ${s.description}?`, body: "Its payment no longer counts as spent and this bill is removed. Later bills already scheduled stay.", confirmLabel: "Remove", danger: true }))) return undefined;
          await data.expensesApi({ action: "remove", expenseId: s.expenseId, reason: "Removed" });
          await data.scheduleApi({ action: "cancel", scheduleId: s.id, reason: "Removed" });
          return after("Removed.")({});
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
export function billDialog({ bill: s = null, categories, today, data, canCategory }) {
  return formDialog({
    title: s ? `Edit ${s.description}` : "Add bill",
    fields: billFields(s, categories, today),
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
