// Wedding Expenses (Phase 16): the Expenses Core with the Bridal profile,
// one compact row per expense.
//   Date | Category | Supplier / Payee | Method | Reference | Amount | View details
// Categories are the couple's own (Wedding Budget); an expense may be paid
// to a saved supplier (its name is kept on the expense, and it counts as
// paid to that supplier). Completed spending only: future dates are
// refused (money still to be paid belongs in Supplier Payments).

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, statCard, skeleton, mobileCell, openButton, bindRowOpen, bindFilterBar, rowMenu, bindRowMenus, filterBar } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { EXPENSE_METHODS, EXPENSE_METHOD_IDS, parseCentavos, businessDate } from "@shared/index.js";
import { categoryName, optionsOf, activityLines, detailsDialog } from "../baby/common.js";
import * as defaultData from "./data.js";
import { categoryField, resolveCategory } from "./categories.js";
import { prepareProof as defaultPrepareProof } from "../../lib/image.js";
import { viewProof } from "../../components/proof-viewer.js";

// Owner-pilot Bridal: a receipt photo / screenshot or a PDF on an expense.
const PROOF_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
export const proofField = (label = "Proof: receipt photo or PDF (optional)") => ({ name: "proof", label, type: "file", accept: PROOF_ACCEPT, more: true });
const proofWord = (p) => (p?.contentType === "application/pdf" ? "PDF" : "Photo");
// "Photo · added Oct 17, 2026" (uploadedAt is a Firestore Timestamp).
export function proofLine(p, timezone) {
  if (!p) return "None";
  const at = p.uploadedAt && typeof p.uploadedAt.toDate === "function" ? p.uploadedAt.toDate() : p.uploadedAt ? new Date(p.uploadedAt) : null;
  return `${proofWord(p)}${at && !Number.isNaN(at.getTime()) ? ` · added ${formatDayId(businessDate(timezone, at))}` : ""}`;
}

const methodLabel = (id) => EXPENSE_METHODS[id]?.label ?? id;
const METHOD_OPTIONS = EXPENSE_METHOD_IDS.map((id) => ({ value: id, label: EXPENSE_METHODS[id].label }));
const YES_NO = [{ value: "no", label: "No" }, { value: "yes", label: "Yes" }];

function fields(e, { today, categories, suppliers }) {
  const active = categories.filter((c) => c.status === "active");
  const linked = Boolean(e?.supplierPaymentId);
  return [
    { name: "date", label: "Date paid", type: "date", value: e?.date ?? today, max: today, required: true, hint: "Not paid yet? Schedule it under Supplier Payments instead." },
    { name: "category", label: "Category", type: "select", options: optionsOf(active, { include: e ? { value: e.category, label: `${categoryName(new Map(categories.map((c) => [c.id, c.name])), e)} (inactive)` } : null }), value: e?.category ?? active[0]?.id ?? "" },
    { name: "amount", label: "Amount (PHP)", value: e ? (e.amount / 100).toFixed(2) : "", inputmode: "decimal", required: true },
    { name: "supplierId", label: linked ? "Supplier (from a supplier payment)" : "Supplier (saved)", type: "select", disabled: linked, options: optionsOf(suppliers, { blank: "— None —", include: e?.supplierId ? { value: e.supplierId, label: e.payee || "Saved supplier" } : null }), value: e?.supplierId ?? "" },
    { name: "payee", label: "Or payee name", value: e && !e.supplierId ? e.payee ?? "" : "", hint: "Used when no saved supplier is chosen." },
    { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: e?.method ?? "cash" },
    { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: e?.reference ?? "" },
    { name: "recurring", label: "Recurring", type: "select", options: YES_NO, value: e?.recurring ? "yes" : "no" },
    { name: "notes", label: "Notes", type: "textarea", value: e?.notes ?? "" },
  ];
}

export function parseWeddingExpense(v, current = null) {
  const amount = parseCentavos(v.amount);
  if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
  if (!v.category) throw new Error("Choose a category (add categories on the Wedding Budget screen)");
  // A disabled select isn't submitted: keep the current supplier.
  const supplierId = v.supplierId === undefined ? current?.supplierId ?? null : v.supplierId || null;
  return { date: v.date, category: v.category, amount, supplierId, payee: supplierId ? undefined : (v.payee || "").trim() || null, method: v.method, reference: (v.reference || "").trim() || null, notes: (v.notes || "").trim() || null, recurring: v.recurring === "yes" };
}

export function mount(container, session, { data = defaultData, toast = defaultToast, now = () => new Date(), exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const can = { create: perms["expenses.create"] === true, update: perms["expenses.update"] === true, remove: perms["expenses.delete"] === true };
  const businessId = session.business.id;
  const currency = session.business.currency || "PHP";
  const timezone = session.business.timezone;
  const today = () => businessDate(timezone, now());
  const state = { filters: { status: "active" }, cursors: [], rows: [], hasMore: false, categories: [], suppliers: [], loading: true, error: null };
  let alive = true;
  const names = () => new Map(state.categories.map((c) => [c.id, c.name]));

  async function load() {
    state.loading = true;
    draw();
    try {
      const [cats, sups, page] = await Promise.all([
        state.categories.length || !perms["budget.view"] ? state.categories : data.listCategories(businessId),
        state.suppliers.length || !perms["vendors.view"] ? state.suppliers : data.activeSuppliers(businessId).catch(() => []),
        data.listWeddingExpenses(businessId, state.filters, { cursor: state.cursors.at(-1) || null }),
      ]);
      state.categories = cats;
      state.suppliers = sups;
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("wedding expenses: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load expenses.";
    }
    state.loading = false;
    draw();
  }

  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;

  function draw() {
    if (!alive) return;
    const f = state.filters;
    const n = names();
    render(
      container,
      html`
        ${pageHeader({ title: "Wedding Expenses", subtitle: html`<a href="/wedding-suppliers" data-link>‹ Money</a>`, actions: can.create ? html`<button type="button" class="btn btn-primary" data-act="new">+ Add expense</button>` : "" })}
        ${filterBar({
          fields: [
            { name: "search", label: "Payee or reference", type: "search", primary: true, value: f.search },
            { name: "category", label: "Category", type: "select", primary: true, options: state.categories.map((c) => [c.id, c.name]), value: f.category, all: "Any category" },
            { name: "supplierId", label: "Supplier", type: "select", primary: false, options: state.suppliers.map((s) => [s.id, s.name]), value: f.supplierId, all: "Any supplier" },
            { name: "method", label: "Method", type: "select", primary: false, options: METHOD_OPTIONS.map((m) => [m.value, m.label]), value: f.method, all: "Any method" },
            { name: "from", label: "From", type: "date", value: f.from },
            { name: "to", label: "To", type: "date", value: f.to },
            { name: "status", label: "Show", type: "select", primary: false, options: [["active", "Active"], ["removed", "Removed"]], value: f.status || "active", def: "active" },
          ],
          end: "",
        })}
        <section class="card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? skeleton(5)
              : !state.rows.length
                ? emptyState({ iconName: "budget", title: "No expenses", body: state.categories.length ? "Expenses you add count against your wedding budget right away." : "Add your wedding budget categories first." })
                : html`<div class="table-wrap"><table class="table table-compact rows" data-role="expenses">
                    <thead><tr><th class="m-only"></th><th>Date</th><th>Category</th><th>Supplier / Payee</th><th class="col-secondary">Method</th><th class="col-secondary">Reference</th><th class="num">Amount</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (e) => html`<tr data-expense="${e.id}" data-open>${mobileCell({ title: e.payee || categoryName(n, e), sub: `${categoryName(n, e)} · ${formatDayId(e.date)}`, end: formatCentavos(e.amount, currency) })}
                        <td>${formatDayId(e.date)}</td><td>${categoryName(n, e)}</td><td>${e.payee || "—"}</td>
                        <td class="col-secondary">${methodLabel(e.method)}</td><td class="col-secondary">${e.reference || "—"}</td>
                        <td class="num">${formatCentavos(e.amount, currency)}</td>
                        <td class="row-actions" data-m="more">${openButton(e.id, "View details", { act: "view" })}</td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="pager"><button type="button" class="btn btn-ghost" data-act="prev" ${state.cursors.length ? "" : "disabled"}>‹ Previous</button><button type="button" class="btn btn-ghost" data-act="next" ${state.hasMore ? "" : "disabled"}>Next ›</button></div>`}
        </section>`
    );
  }

  const actions = expenseActions({ data, currency, timezone, can: { ...can, category: perms["budget.manage"] === true }, toast, getCtx: () => ({ today: today(), categories: state.categories, suppliers: state.suppliers }), reload: () => load() });
  const { addDialog, openView } = actions;
  const done = actions.done;

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return undefined;
    switch (el.dataset.act) {
      case "new":
        return done("Expense added")(await addDialog());
      case "view":
        return openView(state.rows.find((r) => r.id === el.dataset.id));
      case "next":
        state.cursors.push(state.rows.at(-1));
        return load();
      case "prev":
        state.cursors.pop();
        return load();
      default:
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
    state.filters = Object.fromEntries(
      [["status", el.status.value], ["from", el.from.value], ["to", el.to.value], ["category", el.category.value], ["supplierId", el.supplierId.value], ["method", el.method.value], ["search", el.search.value.trim()]].filter(([, v]) => v)
    );
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindFilters = bindFilterBar(container);
  const unbindRows = bindRowOpen(container, { act: "view" });
  const unbindMenus = bindRowMenus(container);
  const unbindExport = bindExport(container, () => ({ ...state.filters, status: "active" }), { toast, deps: exportDeps });
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

// Owner-pilot Bridal UX: the add / view / edit / remove dialogs, shared with
// Money (its "Other expenses" section). can: { create, update, remove }.
export function expenseActions({ data, currency, timezone, can, toast, getCtx, reload, prepareProof = defaultPrepareProof }) {
  const ctx = getCtx;
  const names = () => new Map(getCtx().categories.map((c) => [c.id, c.name]));
  // ---- Proof (one per expense; under ⋯ and in Details, never a column) ----
  const sendProof = async (expenseId, file) => data.attachExpenseProof(expenseId, await prepareProof(file, { pdf: true }));
  // After a new expense / payment is saved: attach the chosen file. The
  // money is already recorded, so a failed upload only warns.
  const attachAfter = async (result, file) => {
    if (!file || !result?.expenseId || result.alreadyRecorded) return;
    try {
      await sendProof(result.expenseId, file);
    } catch (err) {
      toast(`Saved, but the proof didn't upload (${err.message || "error"}). Add it from ⋯ → Add proof.`, "danger");
    }
  };
  const proofDialog = (e) =>
    formDialog({
      title: e.proof ? "Replace proof" : "Add proof",
      intro: e.proof ? "The new file replaces the current one." : "A receipt photo or screenshot, or a PDF (up to 2.5 MB).",
      fields: [{ ...proofField("Proof (photo or PDF)"), more: false }],
      submitLabel: e.proof ? "Replace proof" : "Upload proof",
      onSubmit: async (v) => {
        if (!v.proof) throw new Error("Choose a photo or PDF");
        return sendProof(e.id, v.proof);
      },
    });
  const showProof = (e) => viewProof({ title: `Proof · ${formatCentavos(e.amount, currency)}${e.payee ? ` · ${e.payee}` : ""}`, load: async () => (await data.expenseProof(e.id)).proof });
  // ⋯ items for one expense (x: proof-view / proof-add / proof-replace).
  const proofItems = (e) => [...(e.proof ? [{ x: "proof-view", label: "View proof" }] : []), ...(e.status === "active" && can.update ? [e.proof ? { x: "proof-replace", label: "Replace proof" } : { x: "proof-add", label: "Add proof" }] : [])];
  const proofAction = async (x, e) => {
    if (x === "proof-view") return showProof(e);
    if (x === "proof-add" || x === "proof-replace") return done(e.proof ? "Proof replaced" : "Proof added")(await proofDialog(e));
    return undefined;
  };
  // Owner-pilot Bridal UX: Amount, Supplier / Payee, Category, Date; the
  // rest under More options. No budget category needed first: a new name
  // becomes a category (resolveCategory). Typing a saved supplier's name
  // links the expense to it (counts toward its balance).
  const addDialog = (prefill = {}) => {
    const { today: day, categories, suppliers } = ctx();
    return formDialog({
      title: "Add expense",
      fields: [
        { name: "amount", label: "Amount (₱)", value: "", inputmode: "decimal", required: true },
        { name: "payee", label: "Supplier / Payee", value: "", placeholder: "e.g. Van rental", suggestions: suppliers.map((s) => s.name), hint: "Optional." },
        categoryField(categories, { value: prefill.category || "" }),
        { name: "date", label: "Date paid", type: "date", value: day, max: day, required: true },
        { name: "method", label: "Payment method", type: "select", options: METHOD_OPTIONS, value: "cash", more: true, default: true },
        { name: "reference", label: "Reference (OR no., invoice, transfer ref)", value: "", more: true },
        { name: "notes", label: "Notes", type: "textarea", value: "", more: true },
        proofField(),
      ],
      moreLabel: "More options",
      submitLabel: "Add expense",
      onSubmit: async (v) => {
        const amount = parseCentavos(v.amount);
        if (!(amount > 0)) throw new Error("Enter an amount more than ₱0");
        const typed = (v.payee || "").trim();
        const supplier = suppliers.find((s) => s.name.toLocaleLowerCase("en") === typed.toLocaleLowerCase("en"));
        const category = await resolveCategory(v.category, { categories, data, canCreate: can.category === true });
        const e = { date: v.date, category, amount, method: v.method, ...(supplier ? { supplierId: supplier.id } : typed ? { payee: typed } : {}), ...(v.reference.trim() ? { reference: v.reference.trim() } : {}), ...(v.notes.trim() ? { notes: v.notes.trim() } : {}) };
        const r = await data.expensesApi({ action: "create", expense: e });
        await attachAfter(r, v.proof);
        return r;
      },
    });
  };
  // Edit: the expense's fields, plus its proof (Owner-pilot Bridal: one place).
  const editDialog = (e) =>
    formDialog({
      title: "Edit expense",
      fields: [...fields(e, ctx()), ...(e.status === "active" ? [{ ...proofField(e.proof ? "Replace proof (photo or PDF)" : "Add proof (photo or PDF)"), more: false }] : [])],
      submitLabel: "Save changes",
      onSubmit: async (v) => {
        const next = parseWeddingExpense(v, e);
        const changes = {};
        for (const [k, val] of Object.entries(next)) {
          if (val === undefined) continue; // payee comes from the saved supplier
          if (k === "recurring" ? Boolean(e.recurring) !== val : (e[k] ?? null) !== (val ?? null)) changes[k] = val;
        }
        const r = Object.keys(changes).length ? await data.expensesApi({ action: "update", expenseId: e.id, expectedRevision: e.revision, changes }) : null;
        if (v.proof) await sendProof(e.id, v.proof);
        return r || (v.proof ? { proof: true } : { unchanged: true });
      },
    });
  const removeDialog = (e) =>
    formDialog({
      title: "Remove this money item?",
      intro: `It will no longer appear in your active wedding money list (${formatCentavos(e.amount, currency)}). ${e.supplierPaymentId ? "It no longer counts as spent or as paid to the supplier; its supplier payment goes back to the schedule." : "It no longer counts as spent."} The record stays in your history.`,
      fields: [{ name: "reason", label: "Reason", type: "textarea", required: true }],
      submitLabel: "Remove expense",
      onSubmit: (v) => data.expensesApi({ action: "remove", expenseId: e.id, reason: v.reason }),
    });
  const done = (message) => (result) => {
    if (!result) return false;
    if (!result.unchanged) toast(message, "success");
    reload();
    return true;
  };

  // readOnly (Money's Details): no Edit / Remove buttons; View proof stays.
  function openView(e, { readOnly = false } = {}) {
    const active = e.status === "active";
    detailsDialog({
      title: `${formatCentavos(e.amount, currency)} · ${categoryName(names(), e)}`,
      badgeHtml: active ? "" : badge("Removed", "neutral"),
      rows: [
        ["Date paid", formatDayId(e.date)],
        ["Amount", formatCentavos(e.amount, currency)],
        ["Category", categoryName(names(), e)],
        ["Supplier / payee", e.payee || "—"],
        ["Payment method", methodLabel(e.method)],
        ["Reference", e.reference || "—"],
        ["Recurring", e.recurring ? "Yes" : "No"],
        ["From a supplier payment", e.supplierPaymentId ? "Yes" : null],
        ["Notes", e.notes],
        ["Proof", proofLine(e.proof, timezone)],
      ],
      activity: activityLines(e.history, timezone),
      actions: readOnly ? (e.proof ? [{ act: "proof-view", label: "View proof" }] : []) : [...(active && can.remove ? [{ act: "remove", label: "Remove expense", danger: true }] : []), ...proofItems(e).map((i) => ({ act: i.x, label: i.label })), ...(active && can.update ? [{ act: "edit", label: "Edit" }] : [])],
      onAction: async (act) => {
        try {
          if (act === "proof-view") {
            showProof(e);
            return false;
          }
          if (act.startsWith("proof-")) return await proofAction(act, e);
          if (act === "edit") return done("Expense updated")(await editDialog(e));
          if (act === "remove") return done("Expense removed")(await removeDialog(e));
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
        return false;
      },
    });
  }

  return { addDialog, editDialog, removeDialog, openView, done, proofItems, proofAction, attachAfter };
}
