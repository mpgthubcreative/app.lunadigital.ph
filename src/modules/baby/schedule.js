// Payment Schedule (Phase 15): money expected to be paid later, one
// compact row per payment.
//   Due date | Description | Category | Provider / Payee | Amount | Status | Mark paid · View details
// An Upcoming payment is committed money, not spending. "Pay" records a
// Baby Expense (the server makes a retry or a second click return the same
// one); only then does Spent go up. Phase 18.6: a payment can be paid in
// parts; it stays Upcoming with only the unpaid part counted, until the
// last part (or a payment marked final) finishes it.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, statCard, skeleton, mobileCell, openButton, bindRowOpen, bindFilterBar, rowMenu, bindRowMenus, filterBar } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { SCHEDULE_STATUSES, EXPENSE_METHODS, EXPENSE_METHOD_IDS, parseCentavos, businessDate, upcomingPart, parsePaidByText } from "@shared/index.js";
import * as defaultData from "./data.js";
import { categoryName, optionsOf, activityLines, detailsDialog } from "./common.js";

const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
const TONE = { upcoming: "warning", paid: "success", cancelled: "neutral" };
// One random key per Pay dialog: a retried request records nothing twice.
const partKey = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const partPaid = (s) => s.status === "upcoming" && (s.paidAmount ?? 0) > 0;

function paymentFields(s, { categories, providers }) {
  const active = categories.filter((c) => c.status === "active");
  return [
    { name: "description", label: "Description", value: s?.description ?? "", required: true, hint: "e.g. Hospital deposit, Crib balance" },
    { name: "category", label: "Category", type: "select", options: optionsOf(active, { include: s ? { value: s.category, label: `${s.categoryName ?? "Category"} (inactive)` } : null }), value: s?.category ?? active[0]?.id ?? "" },
    { name: "amount", label: "Amount (PHP)", value: s ? (s.amount / 100).toFixed(2) : "", inputmode: "decimal", required: true },
    { name: "dueDate", label: "Due date", type: "date", value: s?.dueDate ?? "", required: true },
    { name: "providerId", label: "Provider / vendor (saved)", type: "select", options: optionsOf(providers, { blank: "— None —", include: s?.providerId ? { value: s.providerId, label: s.payee || "Saved provider" } : null }), value: s?.providerId ?? "" },
    { name: "payee", label: "Or payee name", value: s && !s.providerId ? s.payee ?? "" : "" },
    { name: "notes", label: "Notes", type: "textarea", value: s?.notes ?? "" },
  ];
}

export function parsePayment(v) {
  const amount = parseCentavos(v.amount);
  if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
  if (!v.category) throw new Error("Choose a category (add categories on the Budget screen)");
  if (!v.dueDate) throw new Error("Choose a due date");
  const providerId = v.providerId || null;
  return { description: v.description.trim(), category: v.category, amount, dueDate: v.dueDate, providerId, payee: providerId ? undefined : v.payee.trim() || null, notes: v.notes.trim() || null };
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const canManage = perms["schedule.manage"] === true;
  const canPay = canManage && perms["expenses.create"] === true;
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { filters: { status: "upcoming" }, cursors: [], rows: [], hasMore: false, categories: [], providers: [], loading: true, error: null };
  let alive = true;
  const names = () => new Map(state.categories.map((c) => [c.id, c.name]));

  async function load() {
    state.loading = true;
    draw();
    try {
      const [cats, provs, page] = await Promise.all([
        state.categories.length || !perms["budget.view"] ? state.categories : data.listCategories(businessId),
        state.providers.length || !perms["providers.view"] ? state.providers : data.activeProviders(businessId).catch(() => []),
        data.listScheduled(businessId, state.filters, { cursor: state.cursors.at(-1) || null }),
      ]);
      state.categories = cats;
      state.providers = provs;
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("schedule: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load the payment schedule.";
    }
    state.loading = false;
    draw();
  }

  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;
  const statusBadge = (s) => (s.status === "upcoming" && s.dueDate < today() ? badge("Overdue", "danger") : partPaid(s) ? badge("Part paid", "info") : badge(SCHEDULE_STATUSES[s.status]?.label ?? s.status, TONE[s.status] || "neutral"));
  // Upcoming: what's still to pay (and of how much, once part-paid); Paid: what was paid.
  const amountText = (s) => (s.status === "paid" ? formatCentavos(s.paidAmount ?? s.amount, currency) : partPaid(s) ? `${formatCentavos(upcomingPart(s), currency)} left of ${formatCentavos(s.amount, currency)}` : formatCentavos(s.amount, currency));

  function draw() {
    if (!alive) return;
    const f = state.filters;
    const n = names();
    render(
      container,
      html`
        ${pageHeader({ title: "Payment Schedule", subtitle: "Deposits and bills still to be paid. They count as spent only once you mark them paid.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">Schedule payment</button>` : "" })}
        ${filterBar({
          fields: [
            { name: "status", label: "Status", type: "select", primary: true, options: Object.entries(SCHEDULE_STATUSES).map(([k, s]) => [k, s.label]), value: f.status || "upcoming", def: "upcoming" },
            { name: "providerId", label: "Provider", type: "select", primary: true, options: state.providers.map((p) => [p.id, p.name]), value: f.providerId, all: "Any provider" },
            { name: "category", label: "Category", type: "select", primary: false, options: state.categories.map((c) => [c.id, c.name]), value: f.category, all: "Any category" },
            { name: "from", label: "Due from", type: "date", value: f.from },
            { name: "to", label: "Due to", type: "date", value: f.to },
          ],
          end: mayExport(session, "paymentSchedule") ? html`<span class="visually-hidden">${exportHint}</span>${exportButton("paymentSchedule")}` : "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(5)
              : !state.rows.length
                ? emptyState({ iconName: "calendar", title: f.status === "upcoming" ? "No upcoming payments" : "Nothing here", body: "Schedule deposits and due bills so you can see what's still to be paid." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="schedule">
                    <thead><tr><th class="m-only"></th><th>Due date</th><th>Description</th><th class="col-secondary">Category</th><th class="col-secondary">Paid to</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (s) => html`<tr data-payment="${s.id}" data-open>${mobileCell({ title: s.description, sub: `${s.status === "upcoming" ? "due" : "was due"} ${formatDayId(s.dueDate)}${s.payee ? ` · ${s.payee}` : ""}`, end: amountText(s) })}
                        <td>${formatDayId(s.dueDate)}</td><td>${s.description}</td>
                        <td class="col-secondary">${categoryName(n, s)}</td><td class="col-secondary">${s.payee || "—"}</td>
                        <td class="num" data-col="amount">${amountText(s)}</td>
                        <td data-m="ctl">${statusBadge(s)}</td>
                        <td class="row-actions" data-m="more">
                          ${canPay && s.status === "upcoming" ? html`<button type="button" class="btn btn-compact" data-act="pay" data-id="${s.id}">Pay</button>` : ""}
                          ${openButton(s.id, "View details", { act: "view" })}
                        </td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager"><button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button><button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button></div>`}
        </section>`
    );
  }

  const ctx = () => ({ categories: state.categories, providers: state.providers });

  const newDialog = () =>
    formDialog({
      title: "Schedule a payment",
      intro: "Not spending yet: it shows under Upcoming payments until you mark it paid.",
      fields: paymentFields(null, ctx()),
      onSubmit: (v) => {
        const p = parsePayment(v);
        for (const k of Object.keys(p)) if (p[k] === null || p[k] === undefined) delete p[k];
        return data.scheduleApi({ action: "create", payment: p });
      },
    });

  const editDialog = (s) =>
    formDialog({
      title: `Edit ${s.description}`,
      fields: paymentFields(s, ctx()),
      onSubmit: (v) => {
        const next = parsePayment(v);
        const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => val !== undefined && (s[k] ?? null) !== (val ?? null)));
        return Object.keys(changes).length ? data.scheduleApi({ action: "update", scheduleId: s.id, expectedRevision: s.revision, changes }) : { unchanged: true };
      },
    });

  // Each payment (full or part) is one expense, recorded once: the dialog's
  // key makes a retry return the same expense.
  const payDialog = (s) => {
    const left = upcomingPart(s);
    const key = partKey();
    return formDialog({
      title: `Pay ${s.description}`,
      intro: partPaid(s) ? `${formatCentavos(s.paidAmount, currency)} already paid · ${formatCentavos(left, currency)} left to pay.` : `${formatCentavos(left, currency)} to pay. It counts as spent once recorded.`,
      fields: [
        { name: "amount", label: "Amount paid now (PHP)", value: (left / 100).toFixed(2), inputmode: "decimal", required: true },
        { name: "final", label: "Is this the full payment?", type: "select", options: [{ value: "yes", label: "Yes, this finishes it" }, { value: "no", label: "No, part payment (the rest stays to pay)" }], value: "yes", hint: "Paid less because the bill was lower? Choose Yes." },
        { name: "paidDate", label: "Date paid", type: "date", value: today(), max: today(), required: true },
        { name: "paidBy", label: "Paid by", value: "", placeholder: "e.g. Mom   or   Mom 600, Dad 400" },
        { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: "cash" },
        { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: "", more: true },
      ],
      submitLabel: "Record payment",
      onSubmit: (v) => {
        const amount = parseCentavos(v.amount);
        if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
        const paidBy = parsePaidByText(v.paidBy, amount);
        const payment = { paidDate: v.paidDate, method: v.method, amount, final: v.final !== "no", key, ...(paidBy ? { paidBy } : {}), ...(v.reference.trim() ? { reference: v.reference.trim() } : {}) };
        return data.scheduleApi({ action: "markPaid", scheduleId: s.id, payment });
      },
    });
  };

  const cancelDialog = (s) =>
    formDialog({
      title: `Cancel ${s.description}?`,
      intro: partPaid(s) ? "The unpaid part leaves Still to pay. What was already paid stays as spent." : "It leaves Still to pay. Nothing is spent.",
      fields: [{ name: "reason", label: "Reason (optional)", type: "textarea" }],
      submitLabel: "Cancel payment",
      onSubmit: (v) => data.scheduleApi({ action: "cancel", scheduleId: s.id, ...(v.reason.trim() ? { reason: v.reason.trim() } : {}) }),
    });

  const after = (message) => (r) => {
    if (!r) return false;
    if (!r.unchanged) toast(r.alreadyPaid ? "Already recorded: no second expense was made." : r.partPaid ? `Part payment recorded. ${formatCentavos(r.remaining, currency)} still to pay.` : message, "success");
    load();
    return true;
  };

  function openView(s) {
    const upcoming = s.status === "upcoming";
    detailsDialog({
      title: `${s.description} · ${formatCentavos(s.amount, currency)}`,
      badgeHtml: statusBadge(s),
      rows: [
        ["Due date", formatDayId(s.dueDate)],
        ["Amount", formatCentavos(s.amount, currency)],
        ["Still to pay", s.status === "upcoming" ? formatCentavos(upcomingPart(s), currency) : null],
        ["Paid in parts", Array.isArray(s.parts) && s.parts.length > 1 ? s.parts.map((p) => `${formatDayId(p.date)} ${formatCentavos(p.amount, currency)}`).join(" · ") : null],
        ["Category", categoryName(names(), s)],
        ["Paid to", s.payee || "—"],
        ["Status", SCHEDULE_STATUSES[s.status]?.label ?? s.status],
        ["Paid on", s.paidDate ? formatDayId(s.paidDate) : null],
        ["Amount paid so far", s.paidAmount ? formatCentavos(s.paidAmount, currency) : null],
        ["Payment method", s.method ? EXPENSE_METHODS[s.method]?.label ?? s.method : null],
        ["Reference", s.reference],
        ["Linked expense", s.expenseId ? "Recorded in Baby Expenses" : null],
        ["Cancel reason", s.cancelReason],
        ["Notes", s.notes],
      ],
      activity: activityLines(s.history, timezone),
      actions: upcoming && canManage ? [{ act: "cancel", label: "Cancel payment", danger: true }, { act: "edit", label: "Edit" }, ...(canPay ? [{ act: "pay", label: "Pay" }] : [])] : [],
      onAction: async (act) => {
        try {
          if (act === "edit") return after("Saved.")(await editDialog(s));
          if (act === "cancel") return after("Payment cancelled.")(await cancelDialog(s));
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
    if (!el || !container.contains(el) || el.dataset.act === "export") return undefined;
    const s = state.rows.find((r) => r.id === el.dataset.id);
    try {
      switch (el.dataset.act) {
        case "new":
          if (!state.categories.some((c) => c.status === "active")) {
            toast("Add a budget category first (Budget & Categories).", "danger");
            return undefined;
          }
          return after("Payment scheduled.")(await newDialog());
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
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const el = event.target.elements;
    if (el.from.value && el.to.value && el.from.value > el.to.value) {
      toast("Choose a valid date range (the start can't be after the end).", "danger");
      return;
    }
    state.filters = Object.fromEntries([["status", el.status.value], ["from", el.from.value], ["to", el.to.value], ["category", el.category.value], ["providerId", el.providerId.value]].filter(([, v]) => v));
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  const unbindMenus = bindRowMenus(container);
  const unbindExport = bindExport(container, () => ({ ...state.filters }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    unbindFilters();
    unbindRows();
    unbindMenus();
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
