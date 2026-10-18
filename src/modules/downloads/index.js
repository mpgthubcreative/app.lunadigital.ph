// Download Excel (Owner pilot, 2026-10-18): the ONE customer-facing
// download, under More in every workspace. One button, one clean workbook
// with a sheet per list (shared/workbook.js; /api/workbook):
//   Household / Business   This month (default) · Custom range · All records
//   Bridal                 the whole wedding (no range)
// The technical Master Backup is not here: it is Luna Super Admin only
// (the Luna console).

import { html, render } from "../../lib/html.js";
import { pageHeader, segmented } from "../../components/ui.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { saveBlob } from "../../lib/export.js";
import { apiDownload } from "../../lib/api.js";
import { WORKBOOK_RANGES, workbookKind, workbookHasRange } from "@shared/workbook.js";
import { businessDate } from "@shared/index.js";

const CONTENTS = {
  household: "Expenses, Payroll, Payroll Breakdown, Attendance, Advances and Grocery List",
  bridal: "Money, Payments, Tasks, Guests, Party Members, Seating, Roles, Crew Meals, Music & Program and Wedding Setup",
  business: "Orders, Payments, Users, Inventory and Customers",
  baby: "your expenses, budget, providers and payment schedule",
};

export function mount(container, session, { toast = defaultToast, download = apiDownload, save = saveBlob, now = () => new Date() } = {}) {
  const kind = workbookKind(session.entitlements);
  const ranged = workbookHasRange(kind);
  const today = businessDate(session.business.timezone || "Asia/Manila", now());
  const state = { range: "month", from: `${today.slice(0, 7)}-01`, to: today, busy: false, error: "" };

  function draw() {
    render(
      container,
      html`
        ${pageHeader({ title: "Download Excel" })}
        <section class="wl-section dl-excel" data-section="download">
          <p class="stat-hint" data-role="contents">One Excel file for ${session.business.name}: ${CONTENTS[kind]}, one sheet each. Opens in Excel and Google Sheets.</p>
          ${ranged
            ? html`<div class="field"><label>Records</label>${segmented("range", Object.entries(WORKBOOK_RANGES).map(([k, r]) => [k, r.label]), state.range, { label: "Records" })}</div>
                ${state.range === "custom"
                  ? html`<div class="dl-dates" data-role="custom">
                      <div class="field"><label for="dl-from">From</label><input class="input" type="date" id="dl-from" data-role="from" value="${state.from}" max="${today}" /></div>
                      <div class="field"><label for="dl-to">To</label><input class="input" type="date" id="dl-to" data-role="to" value="${state.to}" /></div>
                    </div>`
                  : ""}`
            : ""}
          <p class="form-error" data-role="error" role="alert" ${state.error ? "" : "hidden"}>${state.error}</p>
          <button type="button" class="btn btn-primary" data-act="download" ${state.busy ? "disabled" : ""}>${state.busy ? "Preparing…" : "Download Excel"}</button>
        </section>`
    );
  }

  const onClick = async (event) => {
    const seg = event.target.closest('[data-act="seg"][data-seg="range"]');
    if (seg) {
      state.range = seg.dataset.value;
      state.error = "";
      draw();
      return;
    }
    const btn = event.target.closest('[data-act="download"]');
    if (!btn || state.busy) return;
    const body = ranged ? (state.range === "custom" ? { range: "custom", from: state.from, to: state.to } : { range: state.range }) : {};
    if (ranged && state.range === "custom" && (!state.from || !state.to)) {
      state.error = "Choose a start and end date.";
      return draw();
    }
    state.busy = true;
    state.error = "";
    draw();
    try {
      const { blob, fileName } = await download("workbook", body);
      save(fileName, blob);
      toast("Excel file downloaded.", "success");
    } catch (err) {
      state.error = err.message || "Couldn't prepare the file.";
    }
    state.busy = false;
    draw();
  };
  const onInput = (event) => {
    const role = event.target.dataset?.role;
    if (role === "from" || role === "to") state[role] = event.target.value;
  };
  container.addEventListener("click", onClick);
  container.addEventListener("input", onInput);
  container.addEventListener("change", onInput);
  draw();
  return () => {
    container.removeEventListener("click", onClick);
    container.removeEventListener("input", onInput);
    container.removeEventListener("change", onInput);
  };
}
