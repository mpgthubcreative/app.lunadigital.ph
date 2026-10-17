// Luna Household: Bills (the Payment Schedule, household-payroll v3), one
// compact row per bill.
//   Due date | Bill | Category | Repeats | Amount | Status | Pay · View details
// An unpaid bill is money still to pay (Bills remaining), not spending.
// Pay records the household expense (once: a retry returns the same one)
// and, for a repeating bill, adds the next one in the same step. Paid in
// parts: the bill stays unpaid with only the rest counted.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, skeleton, mobileCell, openButton, bindRowOpen, segmented } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { EXPENSE_METHODS, EXPENSE_METHOD_IDS, parseCentavos, businessDate, upcomingPart, repeatLabel } from "@shared/index.js";
import { categoryName, activityLines, detailsDialog } from "../baby/common.js";
import { categoryNameOf, resolveCategory } from "../wedding/categories.js";
import { proofField } from "../wedding/expenses.js";
import { prepareProof as defaultPrepareProof } from "../../lib/image.js";
import { householdCategoryField } from "./expenses.js";
import * as defaultData from "./money-data.js";

const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
const partKey = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const partPaid = (s) => s.status === "upcoming" && (s.paidAmount ?? 0) > 0;

// The repeat choices ("" = doesn't repeat).
export const REPEAT_OPTIONS = [
  { value: "", label: "Doesn't repeat" },
  { value: "week:1", label: "Every week" },
  { value: "week:2", label: "Every 2 weeks" },
  { value: "month:1", label: "Every month" },
  { value: "month:3", label: "Every 3 months" },
  { value: "month:6", label: "Every 6 months" },
  { value: "year:1", label: "Every year" },
];
export const repeatValue = (r) => (r ? `${r.every}:${r.interval ?? 1}` : "");
export function parseRepeat(text) {
  if (!text) return null;
  const [every, n] = text.split(":");
  return { every, interval: Number(n) || 1 };
}

const STATUS_TABS = [["upcoming", "Unpaid"], ["paid", "Paid"], ["cancelled", "Cancelled"]];

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), prepareProof = defaultPrepareProof } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["schedule.manage"] === true;
  const canPay = canManage && perms["expenses.create"] === true;
  const canCategory = perms["budget.manage"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { status: "upcoming", cursors: [], rows: [], hasMore: false, categories: [], loading: true, error: null };
  let alive = true;
  const names = () => new Map(state.categories.map((c) => [c.id, c.name]));
  const money = (c) => formatCentavos(c ?? 0, currency);

  async function load() {
    state.loading = true;
    draw();
    try {
      const [cats, page] = await Promise.all([
        state.categories.length || !perms["budget.view"] ? state.categories : data.listCategories(businessId),
        data.listBills(businessId, { status: state.status }, { cursor: state.cursors.at(-1) || null }),
      ]);
      state.categories = cats;
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("bills: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load your bills.";
    }
    state.loading = false;
    draw();
  }

  const statusBadge = (s) => (s.status === "upcoming" && s.dueDate < today() ? badge("Overdue", "danger") : partPaid(s) ? badge("Part paid", "info") : s.status === "upcoming" ? badge("Unpaid", "warning") : s.status === "paid" ? badge("Paid", "success") : badge("Cancelled", "neutral"));
  const amountText = (s) => (s.status === "paid" ? money(s.paidAmount ?? s.amount) : partPaid(s) ? `${money(upcomingPart(s))} left of ${money(s.amount)}` : money(s.amount));

  function draw() {
    if (!alive) return;
    const n = names();
    render(
      container,
      html`
        ${pageHeader({ title: "Bills", subtitle: html`Electricity, water, rent, internet… Unpaid bills count under Bills remaining; paying one records the expense. <a href="/expenses" data-link>Expenses ›</a>`, actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add bill</button>` : "" })}
        <div class="toolbar">${segmented("status", STATUS_TABS, state.status, { label: "Show" })}</div>
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(5)
              : !state.rows.length
                ? emptyState({ iconName: "calendar", title: state.status === "upcoming" ? "No unpaid bills" : "Nothing here", body: state.status === "upcoming" ? "Add the bills you pay, like electricity or rent. A monthly bill comes back on its own once paid." : "" })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="bills">
                    <thead><tr><th class="m-only"></th><th>Due date</th><th>Bill</th><th class="col-secondary">Category</th><th class="col-secondary">Repeats</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (s) => html`<tr data-bill="${s.id}" data-open>${mobileCell({ title: s.description, sub: `${s.status === "upcoming" ? "due" : "was due"} ${formatDayId(s.dueDate)}${s.repeat ? ` · ${repeatLabel(s.repeat)}` : ""}`, end: amountText(s) })}
                        <td>${formatDayId(s.dueDate)}</td><td>${s.description}</td>
                        <td class="col-secondary">${categoryName(n, s)}</td><td class="col-secondary" data-col="repeat">${s.repeat ? repeatLabel(s.repeat) : "—"}</td>
                        <td class="num" data-col="amount">${amountText(s)}</td>
                        <td data-m="ctl">${statusBadge(s)}</td>
                        <td class="row-actions" data-m="more">
                          ${canPay && s.status === "upcoming" ? html`<button type="button" class="btn btn-compact" data-act="pay" data-id="${s.id}">Pay</button>` : ""}
                          ${openButton(s.id, "View details", { act: "view" })}
                        </td>
                      </tr>`
                    )}</tbody></table></div>
                  ${state.cursors.length || state.hasMore ? html`<div class="pager"><button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button><button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button></div>` : ""}`}
        </section>`
    );
  }

  const billFields = (s = null) => [
    { name: "description", label: "Bill", value: s?.description ?? "", required: true, placeholder: "e.g. Electricity, Rent, Internet" },
    { name: "amount", label: "Amount (₱)", value: s ? (s.amount / 100).toFixed(2) : "", inputmode: "decimal", required: true, hint: "Changes each month? Put the usual amount; pay what the bill says." },
    { name: "dueDate", label: "Due date", type: "date", value: s?.dueDate ?? today(), required: true },
    { name: "repeat", label: "Repeats", type: "select", options: REPEAT_OPTIONS, value: repeatValue(s?.repeat) || (s ? "" : "month:1") },
    householdCategoryField(state.categories, { value: s ? categoryNameOf(state.categories, s.category) || s.categoryName || "" : "Utilities" }),
    { name: "payee", label: "Paid to", value: s?.payee ?? "", placeholder: "e.g. Meralco, Maynilad", more: true },
    { name: "notes", label: "Notes", type: "textarea", value: s?.notes ?? "", placeholder: "e.g. account no.", more: true },
  ];
  const parseBill = async (v) => {
    const amount = parseCentavos(v.amount);
    if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
    if (!v.dueDate) throw new Error("Choose a due date");
    const category = await resolveCategory(v.category, { categories: state.categories, data, canCreate: canCategory });
    return { description: v.description.trim(), amount, dueDate: v.dueDate, repeat: parseRepeat(v.repeat), category, payee: (v.payee || "").trim() || null, notes: (v.notes || "").trim() || null };
  };

  const newDialog = () =>
    formDialog({
      title: "Add bill",
      intro: "Not spending yet: it shows under Bills remaining until you pay it.",
      fields: billFields(),
      moreLabel: "More details",
      submitLabel: "Add bill",
      onSubmit: async (v) => {
        const p = await parseBill(v);
        for (const k of Object.keys(p)) if (p[k] === null) delete p[k];
        return data.scheduleApi({ action: "create", payment: p });
      },
    });

  const editDialog = (s) =>
    formDialog({
      title: `Edit ${s.description}`,
      fields: billFields(s),
      moreLabel: "More details",
      submitLabel: "Save changes",
      onSubmit: async (v) => {
        const next = await parseBill(v);
        const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => JSON.stringify(s[k] ?? null) !== JSON.stringify(val ?? null)));
        return Object.keys(changes).length ? data.scheduleApi({ action: "update", scheduleId: s.id, expectedRevision: s.revision, changes }) : { unchanged: true };
      },
    });

  const payDialog = (s) => {
    const left = upcomingPart(s);
    const key = partKey();
    return formDialog({
      title: `Pay ${s.description}`,
      intro: partPaid(s) ? `${money(s.paidAmount)} already paid · ${money(left)} left.` : `${money(left)} to pay. It's recorded as an expense${s.repeat ? `, and the next one (${repeatLabel(s.repeat).toLowerCase()}) is added` : ""}.`,
      fields: [
        { name: "amount", label: "Amount paid (₱)", value: (left / 100).toFixed(2), inputmode: "decimal", required: true },
        { name: "paidDate", label: "Date paid", type: "date", value: today(), max: today(), required: true },
        { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: "cash" },
        { name: "final", label: "Is this the full payment?", type: "select", options: [{ value: "yes", label: "Yes, this finishes it" }, { value: "no", label: "No, part payment (the rest stays to pay)" }], value: "yes", hint: "Paid less because the bill was lower? Choose Yes.", more: true },
        { name: "reference", label: "Reference (OR no., transfer ref)", value: "", more: true },
        proofField(),
      ],
      moreLabel: "More details",
      submitLabel: "Record payment",
      onSubmit: async (v) => {
        const amount = parseCentavos(v.amount);
        if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
        const payment = { paidDate: v.paidDate, method: v.method, amount, final: v.final !== "no", key, ...(v.reference.trim() ? { reference: v.reference.trim() } : {}) };
        const r = await data.scheduleApi({ action: "markPaid", scheduleId: s.id, payment });
        if (v.proof && r?.expenseId && !r.alreadyPaid) {
          try {
            await data.attachExpenseProof(r.expenseId, await prepareProof(v.proof, { pdf: true }));
          } catch (err) {
            toast(`Paid, but the proof didn't upload (${err.message || "error"}). Add it from the expense.`, "danger");
          }
        }
        return r;
      },
    });
  };

  const cancelDialog = (s) =>
    formDialog({
      title: `Cancel ${s.description}?`,
      intro: `${partPaid(s) ? "The unpaid part leaves Bills remaining. What was already paid stays as spent." : "It leaves Bills remaining. Nothing is spent."}${s.repeat ? " It won't come back: add it again if it should." : ""}`,
      fields: [{ name: "reason", label: "Reason (optional)", type: "textarea" }],
      submitLabel: "Cancel bill",
      onSubmit: (v) => data.scheduleApi({ action: "cancel", scheduleId: s.id, ...(v.reason.trim() ? { reason: v.reason.trim() } : {}) }),
    });

  const after = (message) => (r) => {
    if (!r) return false;
    if (!r.unchanged) toast(r.alreadyPaid ? "Already recorded: no second expense was made." : r.partPaid ? `Part payment recorded. ${money(r.remaining)} still to pay.` : r.nextScheduleId ? `${message} The next one is on your list.` : message, "success");
    load();
    return true;
  };

  function openView(s) {
    const upcoming = s.status === "upcoming";
    detailsDialog({
      title: `${s.description} · ${money(s.amount)}`,
      badgeHtml: statusBadge(s),
      rows: [
        ["Due date", formatDayId(s.dueDate)],
        ["Amount", money(s.amount)],
        ["Repeats", s.repeat ? repeatLabel(s.repeat) : "Doesn't repeat"],
        ["Still to pay", upcoming ? money(upcomingPart(s)) : null],
        ["Paid in parts", Array.isArray(s.parts) && s.parts.length > 1 ? s.parts.map((p) => `${formatDayId(p.date)} ${money(p.amount)}`).join(" · ") : null],
        ["Category", categoryName(names(), s)],
        ["Paid to", s.payee || "—"],
        ["Paid on", s.paidDate ? formatDayId(s.paidDate) : null],
        ["Payment method", s.method ? EXPENSE_METHODS[s.method]?.label ?? s.method : null],
        ["Reference", s.reference],
        ["Expense", s.expenseId ? "Recorded under Expenses" : null],
        ["Cancel reason", s.cancelReason],
        ["Notes", s.notes],
      ],
      activity: activityLines(s.history, timezone),
      actions: upcoming && canManage ? [{ act: "cancel", label: "Cancel bill", danger: true }, { act: "edit", label: "Edit" }, ...(canPay ? [{ act: "pay", label: "Pay" }] : [])] : [],
      onAction: async (act) => {
        try {
          if (act === "edit") return after("Saved.")(await editDialog(s));
          if (act === "cancel") return after("Bill cancelled.")(await cancelDialog(s));
          if (act === "pay") return after("Paid. The expense was recorded.")(await payDialog(s));
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
        return false;
      },
    });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return undefined;
    const s = state.rows.find((r) => r.id === el.dataset.id);
    try {
      switch (el.dataset.act) {
        case "new":
          return after("Bill added.")(await newDialog());
        case "seg":
          state.status = el.dataset.value;
          state.cursors = [];
          return load();
        case "pay":
          return s ? after("Paid. The expense was recorded.")(await payDialog(s)) : undefined;
        case "view":
          return s ? openView(s) : undefined;
        case "next":
          state.cursors.push(state.rows.at(-1));
          return load();
        case "prev":
          state.cursors.pop();
          return load();
        default:
          return undefined;
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
      return undefined;
    }
  };
  container.addEventListener("click", onClick);
  const unbindRows = bindRowOpen(container, { act: "view" });
  load();
  return () => {
    alive = false;
    unbindRows();
    container.removeEventListener("click", onClick);
  };
}
