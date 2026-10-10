// Phase 18.5 workspace dashboards. Dashboard = Monitor: each answers ONE
// question with a few figures, what needs attention, short summaries and
// links into the module that owns the full records. Nothing here computes
// money: figures come from the widget registry's values (shared/dashboard.js)
// and the small, limited list queries (./data.js).
//
//   Distributor  "What is happening in my store right now?"
//   Household    "What needs my attention with household payroll?"
//   Baby         "How much have we spent, who paid, and what's coming up?"
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

// Phase 18.6: a compact payroll summary from the server: the next cutoff's
// total salary to pay, then one row per person (estimated take-home,
// advance to deduct, this cutoff's payment, last salary received), and what
// staff sent that's waiting for the Owner.
const PAY_STATE = { not_paid: ["Not paid", "warning"], paid: ["Paid", "success"], disputed: ["Disputed", "danger"] };
const LAST_STATE = { received: ["Received", "success"], waiting: ["Not confirmed", "warning"], not_received: ["Not received", "danger"] };

function householdSummaryView(ctx) {
  const { currency, summary } = ctx;
  const s = summary.data;
  const money = (c) => formatCentavos(c, currency);
  const waiting = s.pending.attendance + s.pending.advances;
  const rows = s.staff;
  return html`
    <section class="card hero-pay" data-section="to-pay">
      <div class="hero-pay-main">
        <div class="kpi-label">Total salary to pay${s.nextCutoff ? ` · next cutoff ${shortDay(s.nextCutoff)}` : ""}</div>
        <div class="hero-pay-value" data-role="total-to-pay">${money(s.totalToPay)}</div>
        <div class="kpi-hint">${plural(rows.filter((r) => r.payment === "not_paid").length, "person", "people")} · estimated take-home, grows as days are marked</div>
      </div>
      ${s.overdueTotal ? html`<a class="hero-pay-warn" href="/payroll" data-link data-role="overdue">${money(s.overdueTotal)} from ended pay periods is still not paid ›</a>` : ""}
    </section>
    ${waiting
      ? html`<section class="card section" data-section="waiting"><h2 class="card-title">Waiting for you</h2><div class="waiting-links">
          ${s.pending.attendance ? html`<a class="btn" href="/attendance" data-link data-role="waiting-attendance">${plural(s.pending.attendance, "attendance / leave request")} ›</a>` : ""}
          ${s.pending.advances ? html`<a class="btn" href="/advances" data-link data-role="waiting-advances">${plural(s.pending.advances, "advance request")} ›</a>` : ""}
        </div></section>`
      : ""}
    ${section({
      title: "This cutoff, per person",
      id: "staff-pay",
      link: { href: "/payroll", label: "Payroll" },
      body: rows.length
        ? html`<div class="table-wrap"><table class="table table-compact rows" data-role="staff-pay">
            <thead><tr><th class="m-only"></th><th>Name</th><th>Pay period</th><th class="num">Est. take-home</th><th class="num">Advance to deduct</th><th>Payment</th><th>Last salary</th></tr></thead>
            <tbody>${rows.map(
              (r) => html`<tr data-staff="${r.staffId}">
                ${mobileCell({ title: r.name, sub: `to ${shortDay(r.period.end)}${r.advanceToDeduct ? ` · advance −${money(r.advanceToDeduct)}` : ""} · ${PAY_STATE[r.payment][0]}${r.lastSalary ? ` · last: ${LAST_STATE[r.lastSalary.receipt][0]}` : ""}`, end: money(r.estimatedNet), endSub: r.prepared ? "prepared" : "so far" })}
                <td class="cell-strong">${r.name}</td>
                <td>${shortDay(r.period.start)} – ${shortDay(r.period.end)}</td>
                <td class="num" data-col="net"><strong>${money(r.estimatedNet)}</strong>${r.prepared ? "" : html` <span class="stat-hint">so far</span>`}</td>
                <td class="num" data-col="advance">${r.advanceToDeduct ? money(r.advanceToDeduct) : "—"}</td>
                <td data-col="payment">${badge(...PAY_STATE[r.payment])}${r.overdue.length ? html` ${badge(`${r.overdue.length} earlier unpaid`, "danger")}` : ""}</td>
                <td data-col="last">${r.lastSalary ? badge(...LAST_STATE[r.lastSalary.receipt]) : html`<span class="stat-hint">—</span>`}</td>
              </tr>`
            )}</tbody></table></div>`
        : emptyState({ iconName: "staff", title: "No household staff yet", body: "Add the people you pay on the Household Staff page." }),
    })}
  `;
}

export function householdDashboard(ctx) {
  if (ctx.summary?.status === "ok") return householdSummaryView(ctx);
  if (ctx.summary?.status === "loading") return html`<section class="card">${skeleton(4)}</section>`;
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

// Phase 18.6: "How much have we spent, who paid, and what's coming up?"
// Three money cards (Total spent, Still to pay, Spent this month), one small
// card per payer, and Coming up. No budget card: a budget is optional, and
// the Budget screen owns it. Paid (spent) and scheduled (still to pay) are
// never mixed; a part-paid payment counts only its unpaid part.
export function babyDashboard(ctx) {
  const { view, currency, today } = ctx;
  const a = access(view);
  const upcoming = a.rows("upcomingPayments");
  const payers = a.num("budgetPayers") || [];
  const items = [kpi(a.card("budgetSpent"), "Total spent", "All paid expenses"), kpi(a.card("budgetUpcoming"), "Still to pay", "Scheduled, not paid yet"), kpi(a.card("babySpentThisMonth"), "Spent this month", "Paid this calendar month")].filter(Boolean);
  const leftOf = (s) => Math.max(0, (s.amount ?? 0) - (s.paidAmount ?? 0));
  return html`
    ${items.length
      ? html`<section class="card" data-section="money">
          <div class="kpis kpis-flat" data-cols="${items.length}" data-role="money-kpis">${items.map(
            (k) => html`<div class="kpi" data-widget="${k.id}"><div class="kpi-label">${k.label}</div><div class="kpi-value${k.empty ? " is-empty" : ""}">${k.value}</div>${k.hint ? html`<div class="kpi-hint">${k.hint}</div>` : ""}</div>`
          )}</div>
        </section>`
      : ""}
    ${a.card("budgetPayers")
      ? section({
          title: "Who paid",
          hint: "all paid expenses",
          id: "payers",
          link: { href: "/expenses", label: "Expenses" },
          body: payers.length
            ? html`<div class="payer-cards" data-role="payers">${payers.map(
                (p) => html`<div class="payer-card${p.key ? "" : " is-unset"}" data-payer="${p.key ?? "unset"}"><div class="payer-name">${p.name}</div><div class="payer-amount">${formatCentavos(p.amount, currency)}</div></div>`
              )}</div>`
            : emptyState({ iconName: "expenses", title: "No payments yet", body: 'When you add an expense, write who paid (e.g. "Mom", or "Mom 600, Dad 400").' }),
        })
      : ""}
    ${a.list("upcomingPayments")
      ? section({
          title: "Coming up",
          hint: "scheduled, not spent yet",
          id: "upcoming",
          link: { href: "/payment-schedule", label: "Schedule" },
          body: upcoming.length
            ? itemList(
                upcoming.map((s) => ({ id: s.id, title: s.description, sub: `${dueText(today, s.dueDate)}${s.payee ? ` · ${s.payee}` : ""}${(s.paidAmount ?? 0) > 0 ? ` · ${formatCentavos(s.paidAmount, currency)} already paid` : ""}`, end: formatCentavos(leftOf(s), currency), tone: s.dueDate && daysUntil(today, s.dueDate) < 0 ? "danger" : undefined })),
                { role: "upcoming" }
              )
            : emptyState({ iconName: "calendar", title: "Nothing scheduled", body: "Add upcoming bills like hospital deposits so they're not forgotten." }),
        })
      : ""}
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
  const soon = tasks.filter((t) => t.dueDate >= today && daysUntil(today, t.dueDate) <= 14);
  // Phase 18.6: no Needs attention list; the payments card leads with the
  // total of ALL upcoming payments (budgets/current.upcoming), not just the
  // few listed.
  const upcomingTotal = a.card("weddingUpcoming");

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
    ${a.list("upcomingSupplierPayments")
      ? section({
          title: "Payments coming up",
          hint: "scheduled, not spent yet",
          id: "upcoming",
          link: { href: "/wedding-suppliers", label: "Suppliers" },
          body: html`${upcomingTotal && !upcomingTotal.empty
            ? html`<div class="upcoming-total" data-role="upcoming-total"><span class="kpi-label">Total upcoming payments</span><span class="kpi-value">${upcomingTotal.value}</span><span class="kpi-hint">Every scheduled supplier payment not paid yet</span></div>`
            : ""}${pays.length ? itemList(pays.slice(0, 5).map((p) => ({ id: p.id, title: p.supplierName, sub: `${p.description} · ${dueText(today, p.dueDate)}`, end: formatCentavos(p.amount, currency), tone: daysUntil(today, p.dueDate) < 0 ? "danger" : undefined })), { role: "upcoming" }) : emptyState({ iconName: "payments", title: "Nothing scheduled", body: "Supplier deposits and balances you schedule appear here." })}`,
        })
      : ""}
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
