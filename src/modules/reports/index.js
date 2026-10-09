// Reports (Phase 11, Distributor): one page, a business-local date range
// at the top, compact sections below. Everything comes from
// GET /api/reports, which aggregates on the server from the summary
// documents and returns money only to dashboard.financials holders, so
// this page never computes a total and never receives what it may not show.
//
// null means "no data for this period" and is shown as such; 0 is a real
// zero. CSV downloads (reports.export) are built from the rows on screen.

import { html, render } from "../../lib/html.js";
import { exportButton, bindExport, mayExport } from "../../lib/export.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { pageHeader, emptyState, card } from "../../components/ui.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos, formatDayId, formatNumber } from "../../lib/format.js";
import { reportPresets, validateRange, businessDate, expenseCategoryLabel, EXPENSE_METHODS, PAYMENT_METHODS, formatQuantity, UNITS, ESTIMATED_PROFIT_NOTE } from "@shared/index.js";

export const NO_DATA = "No data yet";

const money = (v, currency) => (v === null || v === undefined ? NO_DATA : formatCentavos(v, currency));
const count = (v) => (v === null || v === undefined ? NO_DATA : formatNumber(v));
const pct = (v) => (v === null || v === undefined ? "—" : `${v.toFixed(1)}%`);
const periodLabel = (p) => (p.length === 10 ? formatDayId(p) : new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", year: "numeric", timeZone: "UTC" }));
const qty = (v, unit) => `${formatQuantity(v)} ${UNITS[unit]?.label ?? unit ?? ""}`.trim();
const payMethod = (m) => PAYMENT_METHODS[m]?.label ?? m;
const expMethod = (m) => EXPENSE_METHODS[m]?.label ?? m;

// CSV: plain values, quoted, formula-injection safe (=, +, -, @ prefixed).
export function toCsv(headers, rows) {
  const cell = (v) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
}

// The tables a report renders, as { id, title, headers, rows(display), csv(raw) }.
export function reportTables(r, { currency = "PHP" } = {}) {
  const fin = r.access?.financials === true;
  const tables = [];
  tables.push({
    id: "series",
    tab: "sales",
    title: r.range.granularity === "day" ? "By day" : "By month",
    headers: ["Period", "Orders created", "Orders fulfilled", ...(fin ? ["Net sales", "Gross profit", "Operating expenses", "Payments received"] : [])],
    rows: r.series.map((s) => [periodLabel(s.period), count(s.ordersCreated), count(s.fulfilledOrders), ...(fin ? [money(s.netSales, currency), money(s.grossProfit, currency), money(s.operatingExpenses, currency), money(s.paymentsReceived, currency)] : [])]),
    csv: r.series.map((s) => [s.period, s.ordersCreated, s.fulfilledOrders, ...(fin ? [s.netSales, s.grossProfit, s.operatingExpenses, s.paymentsReceived] : [])]),
  });
  if (r.products) {
    const rows = r.products.rows || [];
    tables.push({
      id: "products",
      tab: "products",
      title: `Products sold${r.products.total > rows.length ? ` (top ${rows.length} of ${r.products.total})` : ""}`,
      headers: ["Product", "Qty sold", ...(fin ? ["Sales", "COGS", "Gross profit"] : [])],
      rows: r.products.rows === null ? null : rows.map((p) => [`${p.sku ?? ""} · ${p.name ?? p.productId}`, qty(p.qty, p.unit), ...(fin ? [money(p.netSales, currency), money(p.cogs, currency), money(p.grossProfit, currency)] : [])]),
      csv: rows.map((p) => [p.sku, p.name, p.qty / 1000, ...(fin ? [p.netSales, p.cogs, p.grossProfit] : [])]),
      csvHeaders: ["SKU", "Product", "Qty sold", ...(fin ? ["Sales (centavos)", "COGS (centavos)", "Gross profit (centavos)"] : [])],
      note: fin ? "Sales are after order discounts (shared across each order's lines); COGS is the cost snapshotted when each order was fulfilled." : "",
    });
  }
  if (r.lowStock) {
    tables.push({
      id: "lowStock",
      tab: "products",
      title: "Low stock now",
      headers: ["Product", "Available", "Reorder at"],
      rows: r.lowStock.map((p) => [`${p.sku} · ${p.name}`, qty(p.available, p.unit), qty(p.reorderLevel, p.unit)]),
      csv: r.lowStock.map((p) => [p.sku, p.name, p.available / 1000, p.reorderLevel / 1000]),
      csvHeaders: ["SKU", "Product", "Available", "Reorder at"],
    });
  }
  if (r.customers) {
    const rows = r.customers.rows || [];
    tables.push({
      id: "customers",
      tab: "customers",
      title: `Customers${r.customers.total > rows.length ? ` (top ${rows.length} of ${r.customers.total})` : ""}`,
      headers: ["Customer", "Orders fulfilled", ...(fin ? ["Sales", "Outstanding balance (now)"] : []), "Last order"],
      rows: r.customers.rows === null ? null : rows.map((c) => [c.walkIn ? "Walk-in orders" : c.name ?? "(deleted customer)", count(c.orders), ...(fin ? [money(c.netSales, currency), c.walkIn ? "—" : money(c.outstandingBalanceNow, currency)] : []), c.lastOrderNumber ?? "—"]),
      csv: rows.map((c) => [c.walkIn ? "Walk-in orders" : c.name, c.orders, ...(fin ? [c.netSales, c.walkIn ? "" : c.outstandingBalanceNow] : []), c.lastOrderNumber]),
    });
  }
  if (r.payments) {
    const rows = r.payments.methods || [];
    tables.push({
      id: "paymentMethods",
      tab: "payments",
      title: "Payments received by method",
      headers: ["Method", "Transactions", ...(fin ? ["Amount"] : [])],
      rows: r.payments.methods === null ? null : rows.map((m) => [payMethod(m.method), count(m.count), ...(fin ? [money(m.amount, currency)] : [])]),
      csv: rows.map((m) => [payMethod(m.method), m.count, ...(fin ? [m.amount] : [])]),
      note: "Payments received are not sales: sales count when an order is fulfilled.",
    });
  }
  if (r.expenses) {
    const cat = r.expenses.categories || [];
    const meth = r.expenses.methods || [];
    tables.push({
      id: "expenseCategories",
      tab: "expenses",
      title: "Operating expenses by category",
      headers: ["Category", "Expenses", "Total"],
      rows: r.expenses.categories === null ? null : cat.map((c) => [expenseCategoryLabel(c.key), count(c.count), money(c.amount, currency)]),
      csv: cat.map((c) => [expenseCategoryLabel(c.key), c.count, c.amount]),
    });
    tables.push({
      id: "expenseMethods",
      tab: "expenses",
      title: "By payment method",
      headers: ["Method", "Expenses", "Total"],
      rows: r.expenses.methods === null ? null : meth.map((m) => [expMethod(m.key), count(m.count), money(m.amount, currency)]),
      csv: meth.map((m) => [expMethod(m.key), m.count, m.amount]),
    });
  }
  return tables;
}

export function mount(container, session, { api = defaultApi, now = () => new Date(), download = defaultDownload, toast = defaultToast, exportDeps = {} } = {}) {
  const perms = session.member.permissions;
  const canExport = perms["reports.export"] === true;
  const currency = session.business.currency || "PHP";
  const today = businessDate(session.business.timezone, now());
  const presets = reportPresets(today);
  const state = { preset: "thisMonth", from: presets.thisMonth.from, to: presets.thisMonth.to, tab: "overview", report: null, loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      validateRange({ from: state.from, to: state.to }, today);
      state.report = await api(`reports?from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}`);
      state.error = null;
    } catch (err) {
      state.error = err.message || "Couldn't load the report.";
      state.report = null;
    }
    state.loading = false;
    if (alive) draw();
  }

  function overview(r) {
    const o = r.overview;
    const fin = r.access.financials;
    const tile = (label, value, extra = "") => html`<div class="card stat-card" data-stat="${label}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${extra ? html`<div class="stat-hint">${extra}</div>` : ""}</div>`;
    return html`
      ${fin
        ? html`<section class="section"><h2 class="section-title">Sales and profit</h2><div class="stat-grid" data-role="profit">
            ${tile("Net sales", money(o.netSales, currency), "Recognized when orders are fulfilled")}
            ${tile("COGS", money(o.cogs, currency))}
            ${tile("Gross profit", money(o.grossProfit, currency), `Gross margin ${pct(o.grossMarginPct)}`)}
            ${tile("Operating expenses", money(o.operatingExpenses, currency))}
            ${tile("Estimated operating profit", money(o.estimatedOperatingProfit, currency), ESTIMATED_PROFIT_NOTE)}
            ${tile("Average order value", money(o.averageOrderValue, currency), "Net sales ÷ orders fulfilled")}
          </div></section>`
        : ""}
      <section class="section"><h2 class="section-title">Orders</h2><div class="stat-grid" data-role="orders">
        ${tile("Orders created", count(o.ordersCreated))}
        ${tile("Orders fulfilled", count(o.fulfilledOrders))}
        ${tile("Orders cancelled", count(o.cancelledOrders))}
      </div></section>
      ${r.payments
        ? html`<section class="section"><h2 class="section-title">Payments</h2><div class="stat-grid" data-role="payments">
            ${fin ? tile("Payments received", money(o.paymentsReceived, currency), "Not sales: money collected in the period") : ""}
            ${fin ? tile("Unpaid balance (now)", money(r.payments.unpaidBalanceNow, currency)) : ""}
            ${tile("Unpaid orders (now)", count(r.payments.unpaidOrdersNow))}
          </div></section>`
        : ""}`;
  }

  function tableCard(t) {
    const body =
      t.rows === null
        ? emptyState({ title: NO_DATA, body: "There's no report data for this period." })
        : !t.rows.length
          ? emptyState({ title: "Nothing in this period" })
          : html`<div class="table-wrap"><table class="table table-compact" data-table="${t.id}">
              <thead><tr>${t.headers.map((h, i) => html`<th class="${i ? "num" : ""}">${h}</th>`)}</tr></thead>
              <tbody>${t.rows.map((row) => html`<tr>${row.map((v, i) => html`<td class="${i ? "num" : ""}">${v}</td>`)}</tr>`)}</tbody></table></div>
            ${t.note ? html`<p class="stat-hint">${t.note}</p>` : ""}`;
    const actions = canExport && t.rows && t.rows.length ? html`<button type="button" class="btn btn-compact" data-act="csv" data-table="${t.id}">Download CSV</button>` : "";
    return html`<div class="section" data-section="${t.id}">${card({ title: t.title, actions, body })}</div>`;
  }

  function draw() {
    if (!alive) return;
    const r = state.report;
    const tables = r ? reportTables(r, { currency }) : [];
    const tabs = [["overview", "Overview"], ["sales", "Sales"], ["products", "Products"], ["customers", "Customers"], ["payments", "Payments"], ["expenses", "Expenses"]].filter(([id]) => id === "overview" || tables.some((t) => t.tab === id));
    if (!tabs.some(([id]) => id === state.tab)) state.tab = "overview";
    const opt = (v, l) => html`<option value="${v}" ${state.preset === v ? "selected" : ""}>${l}</option>`;
    render(
      container,
      html`
        ${pageHeader({ title: "Reports", subtitle: `Business days in ${session.business.timezone}, inclusive.` })}
        <form class="section card filters filters-inline" data-role="range">
          <select class="select" name="preset" aria-label="Period">${Object.entries(presets).map(([k, p]) => opt(k, p.label))}${opt("custom", "Custom")}</select>
          <input class="input" type="date" name="from" value="${state.from}" max="${today}" aria-label="From" />
          <input class="input" type="date" name="to" value="${state.to}" max="${today}" aria-label="To" />
          <button type="submit" class="btn">Apply</button>
          ${mayExport(session, "reports") && state.report ? exportButton("reports", "Download Excel (all sections)") : ""}
        </form>
        ${state.loading
          ? card({ body: emptyState({ title: "Loading…" }) })
          : state.error
            ? card({ body: emptyState({ title: "Couldn't load", body: state.error }) })
            : html`
                <nav class="tabs section" data-role="tabs">${tabs.map(([id, label]) => html`<button type="button" class="btn btn-compact ${state.tab === id ? "btn-primary" : ""}" data-act="tab" data-tab="${id}">${label}</button>`)}</nav>
                <div data-role="report">${state.tab === "overview" ? overview(r) : tables.filter((t) => t.tab === state.tab).map(tableCard)}</div>`}`
    );
  }

  const onClick = (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    if (el.dataset.act === "tab") {
      state.tab = el.dataset.tab;
      draw();
    }
    if (el.dataset.act === "csv" && state.report) {
      const t = reportTables(state.report, { currency }).find((x) => x.id === el.dataset.table);
      if (t) download(`luna-${t.id}-${state.from}_to_${state.to}.csv`, toCsv(t.csvHeaders || t.headers, t.csv));
    }
  };
  const onChange = (event) => {
    if (event.target.name !== "preset") return;
    state.preset = event.target.value;
    const p = presets[state.preset];
    if (p) {
      state.from = p.from;
      state.to = p.to;
      load();
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "range") return;
    event.preventDefault();
    state.from = event.target.elements.from.value;
    state.to = event.target.elements.to.value;
    state.preset = Object.entries(presets).find(([, p]) => p.from === state.from && p.to === state.to)?.[0] ?? "custom";
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  // The workbook is for the range the report on screen shows.
  const unbindExport = bindExport(container, () => ({ from: state.from, to: state.to }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("submit", onSubmit);
  };
}

function defaultDownload(name, text) {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
