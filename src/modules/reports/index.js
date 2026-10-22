// Reports (Luna Business, Owner pilot 2026-10-19): a simple owner summary.
// Everything comes from GET /api/reports, which aggregates on the server and
// returns money only to dashboard.financials holders; this page computes no
// money of its own. Two separate questions:
//
// How did the business do in this period? (actual transactions)
//   Total Sales         gross sales of fulfilled orders (before discounts)
//   Total Orders        orders created in the period (fulfilled ones noted)
//   Total Net Profit    a peso amount: net sales (sales − discounts −
//                       returns) − actual COGS of the units sold − operating
//                       expenses (shared/finance.js estimatedOperatingProfit)
//   Net Profit graph    one bar per day (≤ 62 days) or per month, the same
//                       formula for each period
//
// Are my products priced profitably right now? (current lineup, no sales)
//   Overall SKU Margin  Σ (price − unit cost) ÷ Σ price over the active SKUs
//                       with a cost, as a % (shared/finance.js skuMargins);
//                       quantities sold never weigh in
//   Products            every active SKU: Current Price, Profit / Unit
//                       (price − current unit cost), Net Margin % (Profit /
//                       Unit ÷ price)
// Business has no payroll module: operating expenses are the Costs page's
// expenses only, so nothing is counted twice. null = no data, never 0.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, card, skeleton } from "../../components/ui.js";
import { profitColumns, compactMoney } from "../../components/charts.js";
import { api as defaultApi } from "../../lib/api.js";
import { formatCentavos, formatDayId } from "../../lib/format.js";
import { reportPresets, validateRange, businessDate } from "@shared/index.js";

export const NO_DATA = "No data yet";

const addMonths = (day, n) => {
  const d = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
};
// The day presets plus multi-month ones (one Net Profit bar per month).
export function presetsFor(today) {
  const p = reportPresets(today);
  return {
    thisMonth: p.thisMonth,
    lastMonth: p.lastMonth,
    last3Months: { label: "Last 3 months", from: addMonths(today, -2), to: today },
    last6Months: { label: "Last 6 months", from: addMonths(today, -5), to: today },
    thisYear: { label: "This year", from: `${today.slice(0, 4)}-01-01`, to: today },
    thisWeek: p.thisWeek,
    today: p.today,
  };
}
const shortPeriod = (p) => (p.length === 10 ? formatDayId(p).replace(/, \d{4}$/, "") : new Date(`${p}-01T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", timeZone: "UTC" }));

export function mount(container, session, { api = defaultApi, now = () => new Date() } = {}) {
  const currency = session.business.currency || "PHP";
  const money = (v) => (v === null || v === undefined ? NO_DATA : formatCentavos(v, currency));
  const today = businessDate(session.business.timezone, now());
  const presets = presetsFor(today);
  const state = { preset: "thisMonth", from: presets.thisMonth.from, to: presets.thisMonth.to, report: null, loading: true, error: null };
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

  const pct = (v) => (v === null || v === undefined ? NO_DATA : `${v.toFixed(1)}%`);
  const total = (role, label, value, { main = false, loss = false, note = "" } = {}) =>
    html`<div class="rp-total${main ? " is-main" : ""}" data-total="${role}"><span class="rp-label">${label}</span><strong class="rp-value${value === NO_DATA ? " is-empty" : ""}${loss ? " is-loss" : ""}">${value}</strong>${note ? html`<span class="rp-note${loss ? " is-loss" : ""}" data-role="${role}-note">${note}</span>` : ""}</div>`;
  const profitNote = (v) => (v === null || v === undefined ? "" : v > 0 ? "Profitable" : v < 0 ? "Loss" : "Break-even");

  function summary(r) {
    const o = r.overview;
    const series = (r.series || []).filter((s) => s.netProfit !== null && s.netProfit !== undefined);
    const sku = r.skuMargins;
    const profit = o.estimatedOperatingProfit;
    return html`
      <div class="rp-totals" data-role="totals">
        ${total("sales", "Total Sales", money(o.grossSales))}
        ${total("orders", "Total Orders", o.ordersCreated === null || o.ordersCreated === undefined ? NO_DATA : o.ordersCreated.toLocaleString("en-PH"), { note: o.fulfilledOrders ? `${o.fulfilledOrders.toLocaleString("en-PH")} fulfilled` : "" })}
        ${total("net-profit", "Total Net Profit", money(profit), { main: true, loss: profit < 0, note: profitNote(profit) })}
        ${total("sku-margin", "Overall SKU Margin", pct(sku?.overall.marginPct), { loss: sku?.overall.marginPct < 0, note: sku ? "Current prices and costs" : "" })}
      </div>
      <section class="card rp-section" data-chart="net-profit">
        <h2 class="rp-title">Net Profit <span class="hint">${r.range.granularity === "day" ? "by day" : "by month"}</span></h2>
        ${series.length
          ? html`<div class="chart">${profitColumns(series.map((s) => ({ label: shortPeriod(s.period), value: s.netProfit })), { format: (v) => compactMoney(v).replace(/\.0(?=[kM])/, ""), aria: series.map((s) => `${shortPeriod(s.period)} ${formatCentavos(s.netProfit, currency)}`).join(", ") })}</div>`
          : html`<p class="stat-hint">No sales or costs recorded in this period yet.</p>`}
      </section>
      ${sku
        ? html`<section class="card rp-section" data-section="products">
            <h2 class="rp-title">Product margins <span class="hint">current prices and costs</span></h2>
            ${sku.rows.length
              ? html`<div class="table-wrap"><table class="table table-compact rp-products" data-table="products">
                  <thead><tr><th>Product</th><th class="num">Current Price</th><th class="num">Profit / Unit</th><th class="num">Net Margin</th></tr></thead>
                  <tbody>${sku.rows.map(
                    (p) => html`<tr data-product="${p.productId}"><td>${p.name ?? p.sku ?? "Product"}</td><td class="num">${p.price === null ? NO_DATA : formatCentavos(p.price, currency)}</td>${
                      p.unitProfit === null
                        ? html`<td class="num stat-hint" colspan="2">${p.unitCost === null ? "No cost set" : "No price set"}</td>`
                        : html`<td class="num${p.unitProfit < 0 ? " tone-danger" : ""}">${formatCentavos(p.unitProfit, currency)}</td><td class="num${p.marginPct < 0 ? " tone-danger" : ""}">${pct(p.marginPct)}</td>`
                    }</tr>`
                  )}</tbody>
                </table></div>`
              : html`<p class="stat-hint">No active products yet.</p>`}
          </section>`
        : ""}`;
  }

  function draw() {
    if (!alive) return;
    const r = state.report;
    const opt = (v, l) => html`<option value="${v}" ${state.preset === v ? "selected" : ""}>${l}</option>`;
    const custom = state.preset === "custom";
    render(
      container,
      html`
        ${pageHeader({
          title: "Reports",
          actions: html`<form class="dash-head-actions" data-role="range">
              <select class="select" name="preset" aria-label="Period">${Object.entries(presets).map(([k, p]) => opt(k, p.label))}${opt("custom", "Custom dates")}</select>
              <span class="dash-dates" ${custom ? "" : "hidden"}>
                <input class="input" type="date" name="from" value="${state.from}" max="${today}" aria-label="From" />
                <input class="input" type="date" name="to" value="${state.to}" max="${today}" aria-label="To" />
                <button type="submit" class="btn">Apply</button>
              </span>
            </form>`,
        })}
        <p class="stat-hint rp-range" data-role="range-text">${formatDayId(state.from)} – ${formatDayId(state.to)}</p>
        ${state.loading
          ? html`<section class="card">${skeleton(4)}</section>`
          : state.error
            ? card({ body: emptyState({ title: "Couldn't load", body: state.error }) })
            : r.access?.financials
              ? html`<div class="rp" data-role="report">${summary(r)}</div>`
              : card({ body: emptyState({ iconName: "reports", title: "Sales figures are for the Owner", body: "Ask the Owner if you need the sales summary." }) })}`
    );
  }

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
  container.addEventListener("change", onChange);
  container.addEventListener("submit", onSubmit);
  load();
  return () => {
    alive = false;
    container.removeEventListener("change", onChange);
    container.removeEventListener("submit", onSubmit);
  };
}
