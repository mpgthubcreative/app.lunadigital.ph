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
import { pageHeader, emptyState, card, skeleton } from "../../components/ui.js";
import { waterfall, stackedColumns, groupedColumns, shareBar, legend, SHARE_FILLS } from "../../components/charts.js";
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

// ---------- Phase 18.5: Reports = Analyze ----------
// "How is the business performing, and why?" The Overview opens with the
// money story as charts (Sales → COGS → Gross profit → Operating expenses →
// Estimated operating profit; sales split into cost and profit over time),
// then what drove it (products, expense categories, payment methods,
// orders over time). The detailed tables sit under their own tabs with
// CSV, and Download Excel exports every section. Charts use only the
// server's figures (no money is computed here).

const shortPeriod = (p) => (p.length === 10 ? formatDayId(p).replace(/, \d{4}$/, "") : new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", timeZone: "UTC" }));

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

  const kpi = (label, value, hint = "") => html`<div class="kpi" data-stat="${label}"><div class="kpi-label">${label}</div><div class="kpi-value${value === NO_DATA ? " is-empty" : ""}">${value}</div>${hint ? html`<div class="kpi-hint">${hint}</div>` : ""}</div>`;
  const strip = (role, items) => html`<div class="kpis" data-cols="${items.length}" data-role="${role}">${items}</div>`;
  const chartCard = ({ id, title, hint = "", body, note = "", link = null }) =>
    html`<section class="card" data-chart="${id}">
      <div class="section-head"><h2>${title}${hint ? html` <span class="hint">${hint}</span>` : ""}</h2>${link ? html`<button type="button" class="link-more btn-linklike" data-act="tab" data-tab="${link}">Details ›</button>` : ""}</div>
      ${body}
      ${note ? html`<p class="chart-note">${note}</p>` : ""}
    </section>`;

  function profitStory(r) {
    const o = r.overview;
    if (o.netSales === null || o.netSales === undefined || o.netSales <= 0) return html`<section class="card" data-chart="waterfall">${emptyState({ iconName: "reports", title: "No sales in this period yet", body: "Sales count when orders are fulfilled. Choose a longer period or come back after the first fulfilled order." })}</section>`;
    const steps = [
      { label: "Sales", value: o.netSales, kind: "total", cls: "fill-sales" },
      ...(o.cogs !== null && o.cogs !== undefined ? [{ label: "COGS", value: o.cogs, kind: "minus", cls: "fill-cost" }, { label: ["Gross", "profit"], value: o.grossProfit, kind: "total", cls: "fill-profit" }] : []),
      ...(o.operatingExpenses !== null && o.operatingExpenses !== undefined && o.estimatedOperatingProfit !== null && o.estimatedOperatingProfit !== undefined
        ? [{ label: ["Operating", "expenses"], value: o.operatingExpenses, kind: "minus", cls: "fill-expense" }, { label: ["Est. op.", "profit"], value: o.estimatedOperatingProfit, kind: "total", cls: "fill-profit" }]
        : []),
    ];
    const per100 = (v) => Math.round((v / o.netSales) * 100);
    const note =
      o.cogs !== null && o.estimatedOperatingProfit !== null && o.estimatedOperatingProfit !== undefined
        ? `Of every ₱100 of sales, ₱${per100(o.cogs)} paid for the goods and ₱${per100(o.estimatedOperatingProfit)} is left after operating expenses.`
        : o.cogs !== null
          ? `Of every ₱100 of sales, ₱${per100(o.cogs)} paid for the goods.`
          : "";
    return chartCard({ id: "waterfall", title: "Where each peso of sales went", body: html`<div class="chart">${waterfall(steps, { aria: steps.map((s) => `${Array.isArray(s.label) ? s.label.join(" ") : s.label} ${formatCentavos(s.value, currency)}`).join(", ") })}</div>`, note });
  }

  function trend(r) {
    const rows = r.series.filter((s) => s.netSales !== null && s.netSales !== undefined);
    if (rows.length < 2) return chartCard({ id: "trend", title: "Sales, cost and gross profit over time", body: html`<p class="chart-note">Choose a period of at least two ${r.range.granularity === "day" ? "days" : "months"} with sales to see the trend.</p>` });
    const periods = rows.map((s, i) => {
      const cogs = s.cogs ?? s.netSales - s.grossProfit;
      const margin = s.netSales > 0 ? `${Math.round((s.grossProfit / s.netSales) * 100)}%` : "";
      return { label: shortPeriod(s.period), parts: [{ value: cogs, cls: "fill-cost" }, { value: s.grossProfit, cls: "fill-profit" }], loss: s.grossProfit < 0, note: i === rows.length - 1 ? margin : "" };
    });
    const last = rows.at(-1);
    return chartCard({
      id: "trend",
      title: "Sales, cost and gross profit over time",
      hint: r.range.granularity === "day" ? "by day" : "by month",
      link: "sales",
      body: html`${legend([{ cls: "fill-cost", label: "COGS" }, { cls: "fill-profit", label: "Gross profit" }])}<div class="chart">${stackedColumns(periods, { aria: `Sales split into COGS and gross profit for ${rows.length} periods` })}</div>`,
      note: `Bar height = sales. Latest gross margin: ${last.netSales > 0 ? `${((last.grossProfit / last.netSales) * 100).toFixed(1)}%` : "—"}.`,
    });
  }

  function ranking(id, title, rows, { link, valueOf, labelOf, fmt, cls = "fill-sales", empty }) {
    const list = (rows || []).filter((x) => valueOf(x) > 0).sort((a, b) => valueOf(b) - valueOf(a)).slice(0, 6);
    if (!list.length) return chartCard({ id, title, link, body: html`<p class="chart-note">${empty}</p>` });
    const max = valueOf(list[0]);
    return chartCard({
      id,
      title,
      link,
      body: html`<div class="hbars">${list.map(
        (x) => html`<div class="bar-row"><div class="bar-row-top"><span>${labelOf(x)}</span><span>${fmt(valueOf(x))}</span></div><svg class="bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true"><rect class="bar-track" width="100" height="8" rx="4"></rect><rect class="${cls}" width="${((valueOf(x) / max) * 100).toFixed(2)}" height="8" rx="4"></rect></svg></div>`
      )}</div>`,
    });
  }

  function overview(r) {
    const o = r.overview;
    const fin = r.access.financials;
    const series = r.series || [];
    const ordersChart =
      series.length >= 2
        ? html`${legend([{ cls: "fill-sales", label: "Created" }, { cls: "fill-profit", label: "Fulfilled" }])}<div class="chart">${groupedColumns(series.map((s) => ({ label: shortPeriod(s.period), values: [s.ordersCreated || 0, s.fulfilledOrders || 0] })), [{ cls: "fill-sales" }, { cls: "fill-profit" }], { aria: "Orders created and fulfilled per period" })}</div>`
        : "";
    const methods = r.payments?.methods || [];
    const methodParts = [...methods].sort((a, b) => (fin ? b.amount - a.amount : b.count - a.count)).map((m, i) => ({ label: payMethod(m.method), value: fin ? m.amount : m.count, cls: SHARE_FILLS[Math.min(i, SHARE_FILLS.length - 1)] }));
    return html`
      ${fin
        ? strip("profit", [
            kpi("Net sales", money(o.netSales, currency), "Recognized when orders are fulfilled"),
            kpi("COGS", money(o.cogs, currency)),
            kpi("Gross profit", money(o.grossProfit, currency), `Gross margin ${pct(o.grossMarginPct)}`),
            kpi("Gross margin", pct(o.grossMarginPct)),
            kpi("Operating expenses", money(o.operatingExpenses, currency)),
            kpi("Estimated operating profit", money(o.estimatedOperatingProfit, currency), ESTIMATED_PROFIT_NOTE),
          ])
        : ""}
      ${fin ? html`<div class="split section">${profitStory(r)}${trend(r)}</div>` : ""}
      <div class="grid grid-3 section">
        ${r.products
          ? ranking("products", fin ? "Top products by sales" : "Top products by quantity", r.products.rows, {
              link: "products",
              valueOf: (p) => (fin ? p.netSales : p.qty),
              labelOf: (p) => p.name ?? p.sku ?? p.productId,
              fmt: (v) => (fin ? formatCentavos(v, currency) : formatQuantity(v)),
              empty: "No products sold in this period.",
            })
          : ""}
        ${fin && r.expenses
          ? ranking("expenses", "Operating expenses by category", r.expenses.categories, { link: "expenses", valueOf: (c) => c.amount, labelOf: (c) => expenseCategoryLabel(c.key), fmt: (v) => formatCentavos(v, currency), cls: "fill-expense", empty: "No operating expenses recorded in this period." })
          : ""}
        ${r.payments
          ? html`<section class="card" data-chart="payments">
              <div class="section-head"><h2>Payments received <span class="hint">not sales</span></h2><button type="button" class="link-more btn-linklike" data-act="tab" data-tab="payments">Details ›</button></div>
              <div class="kpis kpis-flat" data-cols="2" data-role="payments">
                ${fin ? kpi("Payments received", money(o.paymentsReceived, currency)) : ""}
                ${fin ? kpi("Unpaid balance (now)", money(r.payments.unpaidBalanceNow, currency)) : ""}
                ${kpi("Unpaid orders (now)", count(r.payments.unpaidOrdersNow))}
              </div>
              ${methodParts.length ? html`<div class="hero-bar">${shareBar(methodParts, { aria: methodParts.map((m) => `${m.label} ${m.value}`).join(", ") })}${legend(methodParts.map((m) => ({ cls: m.cls, label: `${m.label} ${fin ? formatCentavos(m.value, currency) : `${m.value}×`}` })))}</div>` : html`<p class="chart-note">No payments in this period.</p>`}
            </section>`
          : ""}
      </div>
      <section class="card section" data-chart="orders">
        <div class="section-head"><h2>Orders</h2><button type="button" class="link-more btn-linklike" data-act="tab" data-tab="sales">Details ›</button></div>
        <div class="kpis kpis-flat" data-cols="3" data-role="orders">
          ${kpi("Orders created", count(o.ordersCreated))}
          ${kpi("Orders fulfilled", count(o.fulfilledOrders))}
          ${kpi("Orders cancelled", count(o.cancelledOrders))}
        </div>
        ${ordersChart}
        ${fin ? html`<p class="chart-note">Average order value ${money(o.averageOrderValue, currency)} (net sales ÷ orders fulfilled).</p>` : ""}
      </section>`;
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
            ${t.note ? html`<p class="chart-note">${t.note}</p>` : ""}`;
    const actions = canExport && t.rows && t.rows.length ? html`<button type="button" class="btn btn-ghost btn-compact" data-act="csv" data-table="${t.id}">Download CSV</button>` : "";
    return html`<div class="section" data-section="${t.id}"><section class="card"><div class="section-head"><h2>${t.title}</h2>${actions}</div>${body}</section></div>`;
  }

  function draw() {
    if (!alive) return;
    const r = state.report;
    const tables = r ? reportTables(r, { currency }) : [];
    const tabs = [["overview", "Overview"], ["sales", "Sales"], ["products", "Products"], ["customers", "Customers"], ["payments", "Payments"], ["expenses", "Expenses"]].filter(([id]) => id === "overview" || tables.some((t) => t.tab === id));
    if (!tabs.some(([id]) => id === state.tab)) state.tab = "overview";
    const opt = (v, l) => html`<option value="${v}" ${state.preset === v ? "selected" : ""}>${l}</option>`;
    const custom = state.preset === "custom";
    render(
      container,
      html`
        ${pageHeader({
          title: "Reports",
          subtitle: `How the business performed, and why · ${formatDayId(state.from)} – ${formatDayId(state.to)} (business days, ${session.business.timezone})`,
          actions: html`<form class="dash-head-actions" data-role="range">
              <select class="select" name="preset" aria-label="Period">${Object.entries(presets).map(([k, p]) => opt(k, p.label))}${opt("custom", "Custom dates")}</select>
              <span class="dash-dates" ${custom ? "" : "hidden"}>
                <input class="input" type="date" name="from" value="${state.from}" max="${today}" aria-label="From" />
                <input class="input" type="date" name="to" value="${state.to}" max="${today}" aria-label="To" />
                <button type="submit" class="btn">Apply</button>
              </span>
              ${mayExport(session, "reports") && state.report ? exportButton("reports", "Download Excel") : ""}
            </form>`,
        })}
        ${state.loading
          ? html`<section class="card">${skeleton(5)}</section>`
          : state.error
            ? card({ body: emptyState({ title: "Couldn't load", body: state.error }) })
            : html`
                <nav class="seg section-tabs" data-role="tabs" aria-label="Report sections">${tabs.map(([id, label]) => html`<button type="button" class="seg-btn${state.tab === id ? " is-on" : ""}" aria-pressed="${state.tab === id ? "true" : "false"}" data-act="tab" data-tab="${id}">${label}</button>`)}</nav>
                <div class="reports" data-role="report">${state.tab === "overview" ? overview(r) : tables.filter((t) => t.tab === state.tab).map(tableCard)}</div>`}`
    );
  }

  const onClick = (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    if (el.dataset.act === "tab") {
      state.tab = el.dataset.tab;
      draw();
      container.querySelector('[data-role="tabs"]')?.scrollIntoView?.({ block: "nearest" });
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
    } else draw();
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
