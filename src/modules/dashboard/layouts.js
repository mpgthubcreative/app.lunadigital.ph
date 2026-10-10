// Phase 18.5 workspace dashboards. Dashboard = Monitor: each answers ONE
// question with a few figures, what needs attention, short summaries and
// links into the module that owns the full records. Nothing here computes
// money: figures come from the widget registry's values (shared/dashboard.js)
// and the small, limited list queries (./data.js).
//
//   Distributor  "What is happening in my store right now?"
//   Household    "What needs my attention with household payroll?"
//   Baby         "Where are we with our budget, and what's coming up?"
//   Bridal       "Are we on track?"

import { html } from "../../lib/html.js";
import { kpiStrip, attentionList, section, countTiles, itemList, barRows, emptyState, skeleton, budgetTone, badge, mobileCell } from "../../components/ui.js";
import { formatCentavos, formatNumber, formatDayId } from "../../lib/format.js";
import { formatQuantity, UNITS, TASK_STATUSES } from "@shared/index.js";
import { paymentCell, fulfillmentCell } from "../orders/inline.js";
import { NO_DATA } from "./view.js";

// ---------- helpers ----------

const dayMs = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const daysUntil = (today, day) => Math.round((dayMs(day) - dayMs(today)) / 86_400_000);
const shortDay = (d) => (d ? formatDayId(d).replace(/, \d{4}$/, "") : "");
const dueText = (today, day) => {
  const n = daysUntil(today, day);
  return n < 0 ? `overdue since ${shortDay(day)}` : n === 0 ? "due today" : n === 1 ? "due tomorrow" : n <= 14 ? `due in ${n} days` : `due ${shortDay(day)}`;
};
const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

function access(view) {
  const cards = new Map(view.cards.map((c) => [c.id, c]));
  const lists = new Map(view.lists.map((l) => [l.id, l]));
  return {
    card: (id) => cards.get(id) || null,
    // A number that is really there (not loading / missing / error).
    num: (id) => (cards.get(id)?.state === "ok" ? cards.get(id).raw : null),
    list: (id) => lists.get(id) || null,
    rows: (id) => (lists.get(id)?.status === "ok" ? lists.get(id).raw : []),
    loading: (id) => cards.get(id)?.state === "loading" || lists.get(id)?.status === "loading",
  };
}

const kpi = (c, label, hint = "") => (c ? { id: c.id, label, value: c.value, empty: c.empty, hint } : null);

// A two-part budget bar: spent (accent) then scheduled-not-spent (muted).
function budgetBar(total, spent, upcoming) {
  if (!(total > 0)) return "";
  const s = Math.min(100, (Math.max(0, spent) / total) * 100);
  const u = Math.min(100 - s, (Math.max(0, upcoming) / total) * 100);
  const over = spent > total;
  return html`<svg class="bar is-thick" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${Math.round((spent / total) * 100)}% of the budget spent${upcoming > 0 ? `, ${Math.round((upcoming / total) * 100)}% scheduled` : ""}">
    <rect class="bar-track" x="0" y="0" width="100" height="8" rx="4"></rect>
    ${u > 0 ? html`<rect class="bar-fill tone-muted" x="${s.toFixed(2)}" y="0" width="${u.toFixed(2)}" height="8"></rect>` : ""}
    ${s > 0 ? html`<rect class="bar-fill${over ? " tone-danger" : ""}" x="0" y="0" width="${s.toFixed(2)}" height="8" rx="4"></rect>` : ""}
  </svg>`;
}

const legendKey = (cls, text) => html`<span class="legend-key"><svg viewBox="0 0 10 10" aria-hidden="true"><rect class="${cls}" width="10" height="10" rx="3"></rect></svg>${text}</span>`;

// Budget hero: Total / Spent / Remaining + spent-vs-scheduled bar.
// Upcoming ≠ Spent: scheduled money is shown apart, never inside "spent".
function budgetHero(a, ids, { currency, periodSpent = null, periodLabel = "", extra = "" }) {
  const total = a.card(ids.total);
  const spent = a.card(ids.spent);
  const remaining = a.card(ids.remaining);
  const upcoming = a.card(ids.upcoming);
  if (!total && !spent) return "";
  const t = a.num(ids.total);
  const s = a.num(ids.spent) ?? 0;
  const u = a.num(ids.upcoming) ?? 0;
  const pct = t > 0 ? Math.round((s / t) * 100) : null;
  const items = [kpi(total, "Total budget"), kpi(spent, "Spent", pct !== null ? `${pct}% of the budget` : ""), kpi(remaining, "Remaining", a.num(ids.remaining) < 0 ? "Over budget" : "")].filter(Boolean);
  if (items[2] && a.num(ids.remaining) < 0) items[2].hintTone = "warn";
  return html`<section class="card" data-section="budget">
    <div class="kpis kpis-flat" data-cols="${items.length}" data-role="budget-kpis">${items.map(
      (k) => html`<div class="kpi" data-widget="${k.id}"><div class="kpi-label">${k.label}</div><div class="kpi-value${k.empty ? " is-empty" : ""}">${k.value}</div>${k.hint ? html`<div class="kpi-hint${k.hintTone ? ` is-${k.hintTone}` : ""}">${k.hint}</div>` : ""}</div>`
    )}</div>
    ${t > 0
      ? html`<div class="hero-bar">${budgetBar(t, s, u)}
          <div class="legend legend-tight">${legendKey("bar-fill", "Spent")}${u > 0 ? legendKey("bar-fill tone-muted", `Scheduled, not paid yet: ${formatCentavos(u, currency)}`) : ""}${periodSpent !== null ? html`<span class="legend-key legend-end">${periodLabel}: <b>${formatCentavos(periodSpent, currency)}</b></span>` : ""}</div>
        </div>`
      : html`<p class="chart-note">Set a total budget to see how much is left.</p>`}
    ${upcoming && !(t > 0) && u > 0 ? html`<p class="chart-note">${formatCentavos(u, currency)} scheduled, not paid yet.</p>` : ""}
    ${extra}
  </section>`;
}

const loadingSection = (title) => section({ title, body: skeleton(3) });

// ---------- Distributor ----------

export function distributorDashboard(ctx) {
  const { view, can, currency, periodLabel, today } = ctx;
  const a = access(view);
  const fulfilled = a.num("fulfilledOrders");
  const unpaidCount = a.num("unpaidOrders");
  const k = [
    kpi(a.card("netSales"), "Total sales", periodLabel),
    kpi(a.card("ordersToday"), "Total orders", fulfilled !== null ? `${formatNumber(fulfilled)} fulfilled · ${periodLabel.toLowerCase()}` : periodLabel),
    a.card("receivablesOutstanding")
      ? kpi(a.card("receivablesOutstanding"), "Unpaid", unpaidCount !== null ? `${plural(unpaidCount, "order")} · as of now` : "As of now")
      : kpi(a.card("unpaidOrders"), "Unpaid orders", "As of now"),
  ].filter(Boolean);

  // Needs attention: only real, non-zero items, each linking to its work.
  const attention = [];
  const verify = a.num("paymentsToVerify");
  if (verify > 0) attention.push({ id: "verify", tone: "warning", text: `${plural(verify, "payment")} need${verify === 1 ? "s" : ""} verification`, detail: "Recorded by staff, waiting for an owner or manager", href: "/payments?state=for_verification" });
  const low = a.num("lowStock");
  if (low > 0) attention.push({ id: "lowStock", tone: "danger", text: `${plural(low, "SKU")} ${low === 1 ? "is" : "are"} low in stock`, detail: a.rows("lowStockItems").slice(0, 3).map((p) => p.name).join(", "), href: "/inventory?low=1" });
  const ready = a.num("ordersReady");
  if (ready > 0) attention.push({ id: "ready", tone: "info", text: `${plural(ready, "order")} ${ready === 1 ? "is" : "are"} ready`, detail: "Waiting for pickup or delivery", href: "/orders?fulfillmentStatus=ready" });
  const pending = a.num("ordersPending");
  if (pending > 0) attention.push({ id: "pending", tone: "info", text: `${plural(pending, "order")} not started yet`, detail: "Pending: start preparing", href: "/orders?fulfillmentStatus=pending" });
  const hasAttention = ["paymentsToVerify", "lowStock", "ordersReady", "ordersPending"].some((id) => a.card(id));
  const attentionLoading = ["paymentsToVerify", "lowStock", "ordersReady", "ordersPending"].some((id) => a.loading(id));

  // Inventory summary (low first).
  const inv = a.list("inventorySummary");
  const invBody = !inv
    ? ""
    : inv.status === "loading"
      ? skeleton(4)
      : inv.status === "error"
        ? emptyState({ title: "Couldn't load", body: "Try again in a moment." })
        : !inv.raw.length
          ? emptyState({ iconName: "inventory", title: "No products yet", body: inv.empty })
          : html`<div class="table-wrap"><table class="table table-compact rows" data-role="inventory-summary">
              <thead><tr><th>SKU</th><th class="num">Stock left</th><th class="num">Set aside</th><th>Status</th></tr></thead>
              <tbody>${inv.raw.map((p) => {
                const unit = UNITS[p.unit]?.label ?? p.unit ?? "";
                const out = (p.available ?? 0) <= 0;
                const status = out ? badge("Out", "danger") : p.isLowStock ? badge("Low", "warning") : badge("OK", "success");
                return html`<tr data-product="${p.id}">${mobileCell({ title: p.name, sub: `${p.sku} · ${formatQuantity(p.reserved ?? 0)} reserved`, end: html`${formatQuantity(p.available ?? 0)} ${unit} ${status}` })}<td><span class="cell-strong">${p.name}</span><span class="cell-sub">${p.sku}</span></td>
                  <td class="num">${formatQuantity(p.available ?? 0)} <span class="cell-sub-inline">${unit}</span></td><td class="num">${formatQuantity(p.reserved ?? 0)}</td>
                  <td>${out ? badge("Out", "danger") : p.isLowStock ? badge("Low", "warning") : badge("OK", "success")}</td></tr>`;
              })}</tbody></table></div>`;

  // Order status: live counts + recent orders with inline controls.
  const statusTiles = [
    a.card("ordersPending") && { id: "pending", label: "Pending", value: a.card("ordersPending").value, href: "/orders?fulfillmentStatus=pending" },
    a.card("ordersPreparing") && { id: "preparing", label: "Preparing", value: a.card("ordersPreparing").value, href: "/orders?fulfillmentStatus=preparing" },
    a.card("ordersReady") && { id: "ready", label: "Ready", value: a.card("ordersReady").value, href: "/orders?fulfillmentStatus=ready", hot: ready > 0 },
    a.card("fulfilledOrders") && { id: "fulfilled", label: "Fulfilled", value: a.card("fulfilledOrders").value },
  ].filter(Boolean);
  const recent = a.list("recentOrders");
  const recentBody = !recent
    ? ""
    : recent.status === "loading"
      ? skeleton(3)
      : !recent.raw.length
        ? emptyState({ iconName: "orders", title: "No orders yet", body: "Orders entered in Luna appear here." })
        : itemList(
            recent.raw.map((o) => ({
              id: o.id,
              title: `${o.orderNumber} · ${o.customer?.name ?? ""}`,
              sub: `${o.itemCount ?? o.items?.length ?? 0} item${(o.itemCount ?? o.items?.length) === 1 ? "" : "s"}`,
              end: formatCentavos(o.total, currency),
              controls: html`${paymentCell(o, can)}${fulfillmentCell(o, can)}`,
            })),
            { role: "recent-orders", scroll: true }
          );

  return html`
    ${k.length ? kpiStrip(k) : ""}
    <div class="split section">
      <div class="stack">
        ${hasAttention ? section({ title: "Needs attention", id: "attention", body: attentionLoading ? skeleton(3) : attentionList(attention, { clear: "All clear. Nothing waiting on you right now." }) }) : ""}
        ${inv ? section({ title: "Inventory", hint: "low stock first", id: "inventory", link: { href: "/inventory", label: "View inventory" }, body: invBody }) : ""}
      </div>
      <div class="stack">
        ${statusTiles.length || recent
          ? section({
              title: "Orders",
              hint: `now · fulfilled ${periodLabel.toLowerCase()}`,
              id: "orders",
              link: recent ? { href: "/orders", label: "View orders" } : null,
              body: html`${statusTiles.length ? countTiles(statusTiles, { role: "order-status" }) : ""}${recentBody}`,
            })
          : ""}
      </div>
    </div>
  `;
}

// ---------- Household ----------

export function householdDashboard(ctx) {
  const { view, currency, today } = ctx;
  const a = access(view);
  const drafts = a.rows("payrollsToRelease");
  const draftList = a.list("payrollsToRelease");
  const awaiting = a.rows("awaitingReceipt");
  const advancesOpen = a.rows("advancesNotPaid");
  const toDeduct = a.rows("advancesToDeduct");
  const active = a.num("activeStaff");
  const markedToday = a.list("attendanceToday") ? a.rows("attendanceToday").length : null;
  // Ready = the period has ended (pay it now); current = still running.
  const ready = drafts.filter((p) => p.periodEnd && p.periodEnd < today);
  const current = drafts.filter((p) => !(p.periodEnd && p.periodEnd < today));
  const sum = (rows) => rows.reduce((t, p) => t + (p.netPay || 0), 0);
  const currentEnd = current.map((p) => p.periodEnd).filter(Boolean).sort()[0] ?? null;
  const nextKpi = !draftList
    ? null
    : ready.length
      ? { id: "nextPayroll", label: "Ready to release", value: formatCentavos(sum(ready), currency), hint: `${plural(ready.length, "salary", "salaries")} · period ended`, hintTone: "warn" }
      : { id: "nextPayroll", label: currentEnd ? `Next payroll · ${shortDay(currentEnd)}` : "Next payroll", value: draftList.status === "ok" ? (current.length ? formatCentavos(sum(current), currency) : "Nothing yet") : "…", empty: draftList.status !== "ok" || !current.length, hint: current.length ? `${plural(current.length, "person", "people")} · so far this period` : "Prepare payroll to see it here" };

  const k = [
    nextKpi,
    a.card("activeStaff") && { id: "activeStaff", label: "Active staff", value: a.card("activeStaff").value, empty: a.card("activeStaff").empty, hint: markedToday !== null && active !== null ? (markedToday >= active ? "All marked today" : `${active - markedToday} not marked today`) : "", hintTone: markedToday !== null && active !== null && markedToday < active ? "warn" : "" },
    a.list("advancesToDeduct") && { id: "advancesToDeduct", label: "Advances to deduct", value: formatCentavos(toDeduct.reduce((s, x) => s + (x.amount || 0), 0), currency), hint: toDeduct.length ? `${plural(toDeduct.length, "advance")} · from the next payroll` : "Nothing to deduct" },
  ].filter(Boolean);

  const attention = [];
  const readyToRelease = ready;
  if (readyToRelease.length) attention.push({ id: "release", tone: "info", text: `${plural(readyToRelease.length, "salary", "salaries")} ready to release`, detail: readyToRelease.map((p) => `${p.staffName} ${formatCentavos(p.netPay, currency)}`).join(" · "), href: "/payroll" });
  if (awaiting.length) attention.push({ id: "receipt", tone: "warning", text: `${plural(awaiting.length, "receipt")} awaiting confirmation`, detail: awaiting.map((p) => `${p.staffName}, paid ${shortDay(p.salary?.paidDate)}`).join(" · "), href: "/payroll" });
  if (markedToday !== null && active !== null && markedToday < active) attention.push({ id: "attendance", tone: "warning", text: `Attendance not marked for ${plural(active - markedToday, "person", "people")} today`, href: "/attendance" });
  if (advancesOpen.length) attention.push({ id: "advances", tone: "danger", text: `${plural(advancesOpen.length, "advance")} not yet paid out`, detail: advancesOpen.map((x) => `${x.staffName} ${formatCentavos(x.amount, currency)}`).join(" · "), href: "/advances" });

  const periodRows = current.map((p) => ({
    id: p.id,
    title: p.staffName,
    sub: `${p.present ?? 0} present · ${p.officialLeave ?? 0} leave · ${p.absent ?? 0} absent${p.notMarked ? ` · ${p.notMarked} not marked` : ""}`,
    end: formatCentavos(p.netPay, currency),
    endSub: `so far · to ${shortDay(p.periodEnd)}`,
    href: "/payroll",
  }));

  return html`
    ${k.length ? kpiStrip(k) : ""}
    <div class="split section">
      ${section({ title: "Needs attention", id: "attention", body: draftList?.status === "loading" ? skeleton(3) : attentionList(attention, { clear: "All clear. Salaries, receipts and attendance are up to date." }) })}
      ${draftList
        ? section({
            title: "Current pay period",
            hint: currentEnd ? `${shortDay(current[0]?.periodStart)} – ${shortDay(currentEnd)}` : "",
            id: "period",
            link: { href: "/payroll", label: "Payroll" },
            body: draftList.status === "loading" ? skeleton(3) : periodRows.length ? itemList(periodRows, { role: "pay-period" }) : emptyState({ iconName: "payroll", title: "No payroll in progress", body: "Prepare payroll for the current period to see each person's pay here." }),
          })
        : ""}
    </div>
  `;
}

// ---------- Baby ----------

export function babyDashboard(ctx) {
  const { view, currency, today, periodLabel } = ctx;
  const a = access(view);
  const lines = a.rows("spendingByCategory");
  const upcoming = a.rows("upcomingPayments");
  const recent = a.rows("recentExpenses");
  const total = a.num("budgetTotal");
  const spent = a.num("budgetSpent");

  const attention = [];
  for (const s of upcoming.filter((x) => x.dueDate && daysUntil(today, x.dueDate) <= 14).slice(0, 3)) attention.push({ id: `due-${s.id}`, tone: daysUntil(today, s.dueDate) < 0 ? "danger" : "warning", text: `${s.description} ${dueText(today, s.dueDate)}`, detail: `${formatCentavos(s.amount, currency)}${s.payee ? ` · ${s.payee}` : ""}`, href: "/payment-schedule" });
  for (const l of lines.filter((x) => x.budget > 0 && x.spent / x.budget >= 0.9).slice(0, 3)) attention.push({ id: `cat-${l.id}`, tone: l.spent > l.budget ? "danger" : "warning", text: l.spent > l.budget ? `${l.name} is over its budget` : `${l.name} is at ${Math.round((l.spent / l.budget) * 100)}% of its budget`, detail: `${formatCentavos(l.spent, currency)} of ${formatCentavos(l.budget, currency)}`, href: "/budget" });
  if (total > 0 && spent / total >= 0.8) attention.unshift({ id: "overall", tone: spent > total ? "danger" : "warning", text: spent > total ? "Spending is over the total budget" : `${Math.round((spent / total) * 100)}% of the total budget is spent`, href: "/budget" });

  const withBudget = lines.filter((l) => l.budget > 0).sort((x, y) => y.budget - x.budget);
  const catRows = withBudget.slice(0, 6).map((l) => ({ id: l.id, label: l.name, value: `${formatCentavos(l.spent, currency)} of ${formatCentavos(l.budget, currency)}`, pct: (l.spent / l.budget) * 100, tone: budgetTone(l.spent, l.budget) }));

  const periodSpent = a.num("babySpent");
  return html`
    ${budgetHero(a, { total: "budgetTotal", spent: "budgetSpent", remaining: "budgetRemaining", upcoming: "budgetUpcoming" }, { currency, periodSpent, periodLabel })}
    <div class="split section">
      <div class="stack">
        ${section({ title: "Needs attention", id: "attention", body: attentionList(attention, { clear: "All clear. Nothing due in the next two weeks." }) })}
        ${a.list("spendingByCategory")
          ? section({
              title: "Spending by category",
              id: "categories",
              link: { href: "/budget", label: "Budget" },
              body: catRows.length ? barRows(catRows, { role: "category-bars" }) : emptyState({ iconName: "budget", title: "No category budgets yet", body: "Give your categories a budget to see how each one is going." }),
            })
          : ""}
      </div>
      <div class="stack">
        ${a.list("upcomingPayments")
          ? section({
              title: "Coming up",
              hint: "scheduled, not spent yet",
              id: "upcoming",
              link: { href: "/payment-schedule", label: "Schedule" },
              body: upcoming.length ? itemList(upcoming.map((s) => ({ id: s.id, title: s.description, sub: `${dueText(today, s.dueDate)}${s.payee ? ` · ${s.payee}` : ""}`, end: formatCentavos(s.amount, currency) })), { role: "upcoming" }) : emptyState({ iconName: "calendar", title: "Nothing scheduled", body: "Add upcoming bills like hospital deposits so they're not forgotten." }),
            })
          : ""}
        ${a.list("recentExpenses")
          ? section({
              title: "Recent expenses",
              id: "recent",
              link: { href: "/expenses", label: "All expenses" },
              body: recent.length ? itemList(recent.map((e) => ({ id: e.id, title: e.payee || e.categoryName || "Expense", sub: `${e.categoryName ?? ""} · ${shortDay(e.date)}`, end: formatCentavos(e.amount, currency) })), { role: "recent-expenses" }) : emptyState({ iconName: "expenses", title: "No expenses yet", body: "What you pay for appears here." }),
            })
          : ""}
      </div>
    </div>
  `;
}

// ---------- Bridal ----------

function rsvpBar(t) {
  const total = t.attendingSeats + t.declinedSeats + t.awaitingSeats;
  if (!total) return "";
  let x = 0;
  const part = (v, cls) => {
    if (!v) return "";
    const w = (v / total) * 100;
    const r = html`<rect class="${cls}" x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="8"></rect>`;
    x += w;
    return r;
  };
  return html`<svg class="bar is-thick" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${t.attendingSeats} attending, ${t.declinedSeats} declined, ${t.awaitingSeats} awaiting">${part(t.attendingSeats, "fill-success")}${part(t.declinedSeats, "fill-danger")}${part(t.awaitingSeats, "fill-neutral")}</svg>`;
}

export function bridalDashboard(ctx) {
  const { view, currency, today, periodLabel } = ctx;
  const a = access(view);
  const pays = a.rows("upcomingSupplierPayments");
  const tasks = a.rows("tasksDueSoon");
  const rsvp = a.rows("rsvpSummary")[0] || null;
  const suppliers = a.rows("supplierSummary");
  const overdue = a.num("weddingOverdueTasks");
  const awaiting = a.num("weddingAwaitingRsvp");

  const attention = [];
  for (const p of pays.filter((x) => x.dueDate && daysUntil(today, x.dueDate) <= 14).slice(0, 3)) attention.push({ id: `pay-${p.id}`, tone: daysUntil(today, p.dueDate) < 0 ? "danger" : "warning", text: `${p.supplierName}: ${p.description.toLowerCase()} ${dueText(today, p.dueDate)}`, detail: formatCentavos(p.amount, currency), href: "/supplier-payments" });
  if (overdue > 0) attention.push({ id: "overdue", tone: "danger", text: `${plural(overdue, "task")} overdue`, detail: tasks.filter((t) => t.dueDate < today).slice(0, 3).map((t) => t.title).join(", "), href: "/wedding-tasks" });
  const soon = tasks.filter((t) => t.dueDate >= today && daysUntil(today, t.dueDate) <= 14);
  if (soon.length) attention.push({ id: "soon", tone: "info", text: `${plural(soon.length, "task")} due in the next two weeks`, detail: soon.slice(0, 3).map((t) => t.title).join(", "), href: "/wedding-tasks" });
  if (awaiting > 0) attention.push({ id: "rsvp", tone: "info", text: `${plural(awaiting, "invitation")} still waiting for an RSVP`, href: "/guests" });

  const taskTiles = [
    a.card("weddingOpenTasks") && { id: "open", label: "Open", value: a.card("weddingOpenTasks").value, href: "/wedding-tasks" },
    a.list("tasksDueSoon") && { id: "soon", label: "Due in 2 weeks", value: formatNumber(soon.length), hot: soon.length > 0, href: "/wedding-tasks" },
    a.card("weddingOverdueTasks") && { id: "overdue", label: "Overdue", value: a.card("weddingOverdueTasks").value, danger: overdue > 0, href: "/wedding-tasks" },
  ].filter(Boolean);
  const topTasks = [...tasks].sort((x, y) => (x.dueDate < y.dueDate ? -1 : 1)).slice(0, 4);

  const supplierTable = suppliers.length
    ? html`<div class="table-wrap"><table class="table table-compact rows" data-role="supplier-summary">
        <thead><tr><th>Supplier</th><th class="num">Agreed</th><th class="num">Paid</th><th class="num">Balance</th><th>Paid so far</th></tr></thead>
        <tbody>${suppliers.slice(0, 6).map((s) => {
          const agreed = Number.isSafeInteger(s.agreedAmount) ? s.agreedAmount : null;
          const paid = s.paid || 0;
          const pct = agreed ? (paid / agreed) * 100 : 0;
          return html`<tr data-supplier="${s.id}">
            <td class="m-only"><div class="m-row"><div class="m-main"><span class="m-title">${s.name}</span><span class="m-sub">${formatCentavos(paid, currency)} paid${agreed ? ` of ${formatCentavos(agreed, currency)}` : ""}</span></div><div class="m-end">${agreed ? formatCentavos(s.balance, currency) : "—"}<small>balance</small></div></div></td>
            <td><span class="cell-strong">${s.name}</span></td>
            <td class="num">${agreed ? formatCentavos(agreed, currency) : "—"}</td>
            <td class="num">${formatCentavos(paid, currency)}</td>
            <td class="num">${agreed ? formatCentavos(s.balance, currency) : "—"}</td>
            <td class="col-bar" data-m="bar">${agreed ? html`<svg class="bar" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${Math.round(pct)}% paid"><rect class="bar-track" width="100" height="8" rx="4"></rect><rect class="bar-fill${pct >= 100 ? " tone-success" : ""}" width="${Math.min(100, pct).toFixed(2)}" height="8" rx="4"></rect></svg>` : html`<span class="cell-sub">No agreement</span>`}</td>
          </tr>`;
        })}</tbody></table></div>`
    : emptyState({ iconName: "provider", title: "No suppliers yet", body: "Add your suppliers to see what you agreed, paid and still owe." });

  const periodSpent = a.num("weddingSpent");
  const supplierBal = a.card("weddingSupplierBalance");
  return html`
    ${budgetHero(a, { total: "weddingBudgetTotal", spent: "weddingSpentNow", remaining: "weddingRemaining", upcoming: "weddingUpcoming" }, { currency, periodSpent, periodLabel, extra: supplierBal && !supplierBal.empty ? html`<p class="chart-note" data-role="supplier-balance">Still owed to suppliers under their agreements: <b>${supplierBal.value}</b></p>` : "" })}
    <div class="split section">
      ${section({ title: "Needs attention", id: "attention", body: attentionList(attention, { clear: "You're on track. Nothing urgent right now." }) })}
      ${a.list("upcomingSupplierPayments")
        ? section({
            title: "Payments coming up",
            hint: "scheduled, not spent yet",
            id: "upcoming",
            link: { href: "/supplier-payments", label: "Payments" },
            body: pays.length ? itemList(pays.slice(0, 4).map((p) => ({ id: p.id, title: p.supplierName, sub: `${p.description} · ${dueText(today, p.dueDate)}`, end: formatCentavos(p.amount, currency) })), { role: "upcoming" }) : emptyState({ iconName: "payments", title: "Nothing scheduled", body: "Supplier deposits and balances you schedule appear here." }),
          })
        : ""}
    </div>
    <div class="grid grid-2 section">
      ${taskTiles.length || a.list("tasksDueSoon")
        ? section({
            title: "Tasks",
            id: "tasks",
            link: { href: "/wedding-tasks", label: "All tasks" },
            body: html`${countTiles(taskTiles, { role: "task-counts" })}${topTasks.length ? itemList(topTasks.map((t) => ({ id: t.id, title: t.title, sub: `${TASK_STATUSES[t.status]?.label ?? t.status}${t.assignee ? ` · ${t.assignee}` : ""}`, end: shortDay(t.dueDate), endSub: daysUntil(today, t.dueDate) < 0 ? "overdue" : "" }))) : ""}`,
          })
        : ""}
      ${a.list("rsvpSummary")
        ? section({
            title: "Guests & RSVP",
            id: "rsvp",
            link: { href: "/guests", label: "Guest list" },
            body: rsvp
              ? html`<div class="hero rsvp" data-role="rsvp">
                  <div class="hero-value">${formatNumber(rsvp.attendingSeats)} <small>of ${formatNumber(rsvp.invitedSeats)} invited seats confirmed</small></div>
                  ${rsvpBar(rsvp)}
                  <div class="legend legend-tight">${legendKey("fill-success", `${formatNumber(rsvp.attendingSeats)} attending`)}${legendKey("fill-danger", `${formatNumber(rsvp.declinedSeats)} declined`)}${legendKey("fill-neutral", `${formatNumber(rsvp.awaitingSeats)} awaiting (${plural(rsvp.awaiting, "invitation")})`)}</div>
                </div>`
              : emptyState({ iconName: "users", title: "No guests yet", body: "Add guests to follow invitations and confirmations." }),
          })
        : ""}
    </div>
    ${a.list("supplierSummary") ? html`<div class="section">${section({ title: "Suppliers", hint: "biggest balance first", id: "suppliers", link: { href: "/wedding-suppliers", label: "All suppliers" }, body: supplierTable })}</div>` : ""}
  `;
}

export const LAYOUTS = { distributor: distributorDashboard, "household-payroll": householdDashboard, "baby-expense": babyDashboard, "bridal-expense": bridalDashboard };
export { NO_DATA };
