// Pure dashboard view model: visible widgets (shared/dashboard.js) + the
// fetched metric documents -> what each card shows. No formulas here: money
// figures come from shared/finance.js financialSummary, counts straight
// from the documents. Nothing is invented: a missing document or field is
// "No data yet", never 0.

import { resolveDashboard, dashboardDocuments, financialSummary, businessDate, formatQuantity, UNITS } from "@shared/index.js";
import { formatCentavos, formatNumber } from "../../lib/format.js";

// Row shapes per list widget (only fields everyone allowed to see the list may see).
const LIST_ROWS = {
  lowStockItems: (p) => ({ id: p.id, title: p.name, detail: `${p.sku} · ${formatQuantity(p.available)} ${UNITS[p.unit]?.label ?? p.unit} available · reorder at ${formatQuantity(p.reorderLevel)}` }),
};

export const NO_DATA = "No data yet";

// docs: { [source]: { status: "ok" | "missing" | "error", data } }
function valueFor(widget, docs) {
  const entry = docs[widget.source];
  if (!entry || entry.status === "loading") return { state: "loading" };
  if (entry.status === "error") return { state: "error" };
  if (entry.status !== "ok" || !entry.data) return { state: "empty" };

  let raw;
  if (widget.source.startsWith("financial")) {
    const summary = widget.source === "financial-current" ? financialSummary({}, entry.data) : financialSummary(entry.data);
    raw = summary[widget.value];
  } else {
    raw = Number.isSafeInteger(entry.data[widget.value]) ? entry.data[widget.value] : null;
  }
  return raw === null || raw === undefined ? { state: "empty" } : { state: "ok", raw };
}

function display(widget, result, currency) {
  if (result.state === "loading") return { text: "…", empty: true };
  if (result.state === "error") return { text: "Couldn't load", empty: true };
  if (result.state === "empty") return { text: NO_DATA, empty: true };
  return { text: widget.format === "money" ? formatCentavos(result.raw, currency) : formatNumber(result.raw), empty: false };
}

export function dashboardPlan(session, now = new Date()) {
  const widgets = resolveDashboard({ entitlements: session.entitlements, permissions: session.member.permissions });
  const day = businessDate(session.business.timezone, now);
  return { day, widgets, documents: dashboardDocuments(widgets, day) };
}

export function buildDashboardView({ session, widgets, docs, lists = {} }) {
  const currency = session.business.currency || "PHP";
  const cards = widgets
    .filter((w) => w.kind === "stat")
    .map((w) => {
      const result = valueFor(w, docs);
      const shown = display(w, result, currency);
      return { id: w.id, section: w.section, label: w.label, value: shown.text, empty: shown.empty, state: result.state, hint: w.hint || "", note: w.note || "" };
    });
  const listViews = widgets
    .filter((w) => w.kind === "list")
    .map((w) => {
      const loaded = lists[w.id];
      const rows = loaded && loaded.status === "ok" && LIST_ROWS[w.id] ? loaded.rows.map(LIST_ROWS[w.id]) : [];
      return { id: w.id, label: w.label, empty: w.empty, ready: w.ready === true, status: w.ready ? (loaded ? loaded.status : "loading") : "not-ready", rows };
    });
  return { cards, lists: listViews };
}
