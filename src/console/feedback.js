// Super Admin → Reviews & Feedback (2026-10-21). Customers' private trial
// feedback, one compact row each; View details shows everything. A status
// is Super Admin's review only (New → Reviewed → Approved → Featured):
// nothing here publishes anything. Only a testimonial whose author ticked
// the marketing permission can be Featured.

import { html, render } from "../lib/html.js";
import { pageHeader, card, emptyState, badge, rowMenu } from "../components/ui.js";
import { FEEDBACK_STATUSES, FEEDBACK_STATUS_IDS, RECOMMEND_OPTIONS } from "@shared/index.js";
import { toggleMenus } from "./actions.js";

const when = (iso) => (iso ? new Date(iso).toLocaleDateString("en-PH", { dateStyle: "medium" }) : "—");
const stars = (n) => `${"★".repeat(n)}${"☆".repeat(5 - n)}`;
const clip = (s, n = 90) => (!s ? "—" : s.length > n ? `${s.slice(0, n - 1)}…` : s);
const statusChip = (s) => badge(FEEDBACK_STATUSES[s]?.label ?? s, FEEDBACK_STATUSES[s]?.tone ?? "neutral");
const permissionChip = (r) => (r.testimonial ? (r.marketingPermission ? badge("Marketing OK", "success") : badge("Private", "neutral")) : "");

export function feedbackMenu(r) {
  return rowMenu(r.id, [
    { act: "f-view", label: "View details" },
    { sep: true },
    ...FEEDBACK_STATUS_IDS.filter((s) => s !== r.status && (s !== "featured" || r.marketingPermission)).map((s) => ({ act: `f-${s}`, label: s === "featured" ? "Feature" : `Mark ${FEEDBACK_STATUSES[s].label.toLowerCase()}` })),
  ], { label: `Actions for ${r.businessName}` });
}

function detailsDialog(r) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  render(
    backdrop,
    html`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="fb-title">
      <div class="modal-header"><h2 class="card-title" id="fb-title">${r.businessName}</h2></div>
      <div class="modal-body"><dl class="dl dl-compact" data-role="feedback-details">
        <dt>Product</dt><dd>${r.productName ?? r.planId ?? "—"}</dd>
        <dt>Rating</dt><dd>${stars(r.rating)} ${r.rating}/5</dd>
        <dt>Most useful</dt><dd class="pre-line">${r.useful ?? "—"}</dd>
        <dt>Could improve</dt><dd class="pre-line">${r.improve ?? "—"}</dd>
        <dt>Would recommend</dt><dd>${r.recommendLabel ?? RECOMMEND_OPTIONS[r.recommend] ?? "—"}</dd>
        <dt>Testimonial</dt><dd class="pre-line">${r.testimonial ?? "—"}</dd>
        <dt>Marketing permission</dt><dd>${r.marketingPermission ? "Yes: may be used on Luna's website, social media and marketing" : "No: private"}</dd>
        <dt>Submitted</dt><dd>${when(r.submittedAt)}${r.submittedBy ? ` · ${r.submittedBy}` : ""}${r.trialDay ? ` · trial day ${r.trialDay}` : ""}</dd>
        <dt>Status</dt><dd>${statusChip(r.status)}</dd>
      </dl></div>
      <div class="modal-footer"><button type="button" class="btn btn-primary" data-action="close">Close</button></div>
    </div>`
  );
  const close = () => {
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
  };
  const onKey = (e) => e.key === "Escape" && close();
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop || e.target.closest('[data-action="close"]')) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
  backdrop.querySelector('[data-action="close"]').focus();
}

export function feedbackView(el, ctx) {
  const state = { filters: {}, data: null };
  async function load() {
    try {
      state.data = await ctx.call("feedbackList", { filters: state.filters });
    } catch (err) {
      render(el, html`${pageHeader({ title: "Reviews & Feedback" })}${card({ body: emptyState({ title: "Couldn't load", body: err?.message || "Try again." }) })}`);
      return;
    }
    draw();
  }
  function draw() {
    const d = state.data;
    const f = state.filters;
    render(
      el,
      html`${pageHeader({ title: "Reviews & Feedback", subtitle: "Private feedback from free trials. Nothing here is published automatically." })}
        <section class="card section">
          <form class="filters" data-role="filters">
            <select class="select" name="status" aria-label="Status"><option value="">All statuses</option>${FEEDBACK_STATUS_IDS.map((s) => html`<option value="${s}" ${f.status === s ? "selected" : ""}>${FEEDBACK_STATUSES[s].label} (${d.counts[s] ?? 0})</option>`)}</select>
            <select class="select" name="permission" aria-label="Marketing permission"><option value="">Any permission</option><option value="yes" ${f.permission === "yes" ? "selected" : ""}>Marketing OK</option><option value="no" ${f.permission === "no" ? "selected" : ""}>Private</option></select>
            <button type="submit" class="btn btn-compact">Filter</button>
            ${d.averageRating ? html`<span class="stat-hint" data-role="average">Average ${d.averageRating}/5</span>` : ""}
          </form>
          ${d.rows.length
            ? html`<div class="table-wrap"><table class="table table-compact rows sa-rows" data-role="feedback">
                <thead><tr><th class="m-only"></th><th>Customer</th><th>Rating</th><th class="col-secondary">Most useful</th><th class="col-secondary">Could improve</th><th>Recommend</th><th>Testimonial</th><th>Submitted</th><th>Status</th><th></th></tr></thead>
                <tbody>${d.rows.map(
                  (r) => html`<tr data-feedback="${r.id}">
                    <td class="m-only"><div class="m-row"><div class="m-main"><span class="m-title">${r.businessName}</span><span class="m-sub">${stars(r.rating)} · ${r.recommendLabel ?? ""} · ${when(r.submittedAt)}</span>${r.testimonial ? html`<span class="m-sub">“${clip(r.testimonial, 70)}”</span>` : ""}</div><div class="m-end">${statusChip(r.status)}${permissionChip(r)}</div></div></td>
                    <td><span class="cell-strong">${r.businessName}</span><span class="cell-sub">${r.productName ?? r.planId ?? ""}</span></td>
                    <td data-role="rating" title="${r.rating}/5">${stars(r.rating)}</td>
                    <td class="col-secondary">${clip(r.useful)}</td>
                    <td class="col-secondary">${clip(r.improve)}</td>
                    <td>${r.recommendLabel ?? "—"}</td>
                    <td>${clip(r.testimonial, 70)} ${permissionChip(r)}</td>
                    <td>${when(r.submittedAt)}</td>
                    <td data-role="status">${statusChip(r.status)}</td>
                    <td class="row-actions" data-m="more">${feedbackMenu(r)}</td>
                  </tr>`
                )}</tbody></table></div>`
            : emptyState({ title: "No feedback yet", body: "Feedback from free trials appears here (Day 21 of a trial)." })}
        </section>`
    );
  }
  el.onsubmit = (e) => {
    if (e.target.dataset.role !== "filters") return;
    e.preventDefault();
    const x = e.target.elements;
    state.filters = Object.fromEntries([["status", x.status.value], ["permission", x.permission.value]].filter(([, v]) => v));
    load();
  };
  el.onclick = async (e) => {
    if (toggleMenus(e, el)) return;
    const t = e.target.closest("[data-act]");
    const act = t?.dataset.act;
    if (!act?.startsWith("f-")) return;
    const r = state.data?.rows.find((x) => x.id === t.dataset.id);
    if (!r) return;
    if (act === "f-view") return detailsDialog(r);
    try {
      await ctx.call("setFeedbackStatus", { feedbackId: r.id, status: act.slice(2) });
      ctx.toast(`Marked ${FEEDBACK_STATUSES[act.slice(2)].label}.`, "success");
      load();
    } catch (err) {
      ctx.toast(err.message || "Couldn't change the status", "danger");
    }
  };
  render(el, html`${pageHeader({ title: "Reviews & Feedback" })}${card({ body: emptyState({ title: "Loading…" }) })}`);
  load();
}
