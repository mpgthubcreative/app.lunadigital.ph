// Luna Console: a business's Bridal Invitation card and SUPPORT access
// (2026-10-20 privacy model).
//
// Invitation work is normal Super Admin work: the card shows only what it
// needs (couple, date, Standard / Custom, Draft / Ready / Published, last
// updated) and previews use a SAMPLE guest built by the server, never a
// real guest or link.
//
// The customer's records (guests, RSVPs, money, tasks, orders, payroll…)
// are support access only: "Open workspace as support" asks for a reason,
// opens a read-only, 30-minute session, and every area viewed (and the
// Master Backup) is audited for Luna and for the business. Exit ends it.

import { html, render } from "../lib/html.js";
import { pageHeader, card, emptyState, badge } from "../components/ui.js";
import { formDialog } from "../components/form-dialog.js";
import { confirmDialog } from "../components/feedback.js";
import { api, apiDownload } from "../lib/api.js";
import { saveBlob } from "../lib/export.js";
import { formatDayId } from "../lib/format.js";
import { openInvitePreview } from "../modules/wedding/invitation/preview.js";

const STATUS = { draft: ["Draft", "warning"], ready: ["Ready", "info"], published: ["Published", "success"] };
const at = (iso) => (iso ? new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "—");
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : "");

// ---------- Invitation (Bridal) ----------

export function invitationCard(inv, b, ctx) {
  if (!inv) return "";
  const [label, tone] = STATUS[inv.status] ?? [inv.status, "neutral"];
  const custom = inv.type === "custom";
  return html`<section class="section card" data-role="invitation">
    <div class="card-header"><h2 class="card-title">Invitation</h2>${badge(label, tone)}</div>
    <div class="card-body">
      <dl class="dl dl-compact">
        <dt>Wedding</dt><dd data-role="inv-couple">${inv.coupleNames || b.name}${inv.weddingDate ? html`<span class="cell-sub">${formatDayId(inv.weddingDate)}</span>` : ""}</dd>
        <dt>Invitation</dt><dd data-role="inv-type">${custom ? "Custom" : "Standard"}${inv.productName ? html`<span class="cell-sub">${inv.productName}</span>` : ""}</dd>
        <dt>Template</dt><dd data-role="inv-template">${inv.templateLabel ?? "Luna Standard"}${inv.draftTemplateId && inv.draftTemplateId !== inv.templateId ? html`<span class="cell-sub">Draft: ${inv.draftTemplateId}</span>` : ""}</dd>
        <dt>Guests see</dt><dd data-role="inv-live">${inv.live === "custom" ? `Custom design v${inv.publishedVersion}` : "Standard invitation"}${inv.unpublishedChanges ? html`<span class="cell-sub tone-warning">Draft changes not published yet</span>` : ""}</dd>
        <dt>Last updated</dt><dd>${at(inv.lastUpdated)}</dd>
        ${inv.trialPreviewOnly ? html`<dt>Free trial</dt><dd data-role="inv-trial">Preview only: guest links open once Luna Bridal is paid</dd>` : ""}
      </dl>
      <div class="page-actions" data-role="inv-actions">
        <button type="button" class="btn btn-compact" data-act="inv-preview" data-which="draft">Preview draft</button>
        ${custom ? html`<a class="btn btn-compact" href="${ctx.base}/businesses?b=${b.id}&design=1" data-link data-role="design-link">Edit design</a>` : ""}
        ${custom ? html`<button type="button" class="btn btn-compact btn-primary" data-act="inv-publish">Publish</button>` : ""}
        <button type="button" class="btn btn-compact" data-act="inv-preview" data-which="live">View published invitation</button>
      </div>
      <p class="stat-hint">Previews use a sample guest, never a real guest's link.${custom ? "" : " A custom design comes with Luna Bridal Custom."}</p>
    </div>
  </section>`;
}

// The invitation exactly as a guest sees it, for a sample guest.
export async function previewInvitation(businessId, which, name) {
  const r = await api("invitation-design", { method: "POST", body: { action: "sample", businessId, which } });
  await openInvitePreview({ token: "S".repeat(32), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation: r.invitation }) }), note: `${which === "draft" ? "Draft" : "Published"} invitation for ${name} · sample guest` });
}

export async function publishInvitation(businessId) {
  const ok = await confirmDialog({ title: "Publish the draft design?", body: "Every guest link shows it at once. Guests, their links and RSVPs don't change. Later draft edits stay hidden until you publish again.", confirmLabel: "Publish" });
  if (!ok) return null;
  return api("invitation-design", { method: "POST", body: { action: "publish", businessId } });
}

// ---------- Support access ----------

export function supportCard(session, b, ctx) {
  return html`<section class="section card" data-role="support">
    <div class="card-header"><h2 class="card-title">Customer data</h2>${session ? badge("Support open · read-only", "warning") : ""}</div>
    <div class="card-body">
      ${session
        ? html`<p data-role="support-open">Support session open until ${time(session.expiresAt)} · ${session.reason}</p>
            <div class="page-actions"><a class="btn btn-compact btn-primary" href="${ctx.base}/businesses?b=${b.id}&support=1" data-link>Open support view</a><button type="button" class="btn btn-compact" data-act="support-end" data-id="${session.sessionId}">End support</button></div>`
        : html`<p class="stat-hint">Managing this business doesn't show its records. To look at them for troubleshooting, open a read-only support session with a reason; it's recorded for Luna and for the business.</p>
            <div class="page-actions"><button type="button" class="btn btn-compact" data-act="support-start">Open workspace as support</button></div>`}
    </div>
  </section>`;
}

export function startSupportDialog(ctx, b) {
  return formDialog({
    title: `Open ${b.name} as support?`,
    intro: "Read-only, for 30 minutes. Your reason, what you look at and when you leave are recorded, and the business can see it.",
    fields: [{ name: "reason", label: "Support reason", type: "textarea", required: true, placeholder: "e.g. Owner reports RSVP totals look wrong (ticket #123)" }],
    submitLabel: "Open read-only",
    onSubmit: (v) => ctx.call("supportStart", { businessId: b.id, reason: v.reason }),
  });
}

// Field values as short text for the read-only table.
const cellText = (v) => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }
  const s = String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

export async function supportView(el, ctx, businessId) {
  render(el, html`${pageHeader({ title: "Support view" })}${card({ body: emptyState({ title: "Loading…" }) })}`);
  let d, areas;
  try {
    d = await ctx.call("business", { businessId });
    areas = (await ctx.call("supportAreas", { businessId })).areas;
  } catch (err) {
    render(el, html`${pageHeader({ title: "Support view" })}${card({ body: emptyState({ title: "Couldn't load", body: err.message }) })}`);
    return;
  }
  const b = d.business;
  const back = `${ctx.base}/businesses?b=${businessId}`;
  if (!d.support) {
    render(el, html`${pageHeader({ title: `Support · ${b.name}`, actions: html`<a class="btn" href="${back}" data-link>Back to business</a>` })}
      ${card({ body: emptyState({ title: "No support session open", body: "Open the workspace as support from the business page, with a reason." }) })}`);
    return;
  }
  const s = d.support;
  const state = { area: null, data: null, error: null };
  const draw = () =>
    render(
      el,
      html`${pageHeader({ title: `Support · ${b.name}`, subtitle: "Read-only. Everything you open here is recorded.", actions: html`<button type="button" class="btn" data-act="support-backup">Master Backup</button><button type="button" class="btn btn-primary" data-act="support-exit">Exit support</button>` })}
        <div class="banner banner-warning" role="status" data-role="support-banner">Support access · read-only · until ${time(s.expiresAt)} · ${s.reason}</div>
        <div class="seg sa-support-areas" role="tablist" aria-label="Workspace areas" data-role="support-areas">${areas.map((a) => html`<button type="button" class="seg-btn${state.area === a.id ? " is-on" : ""}" role="tab" aria-pressed="${state.area === a.id}" data-act="support-area" data-id="${a.id}">${a.label}</button>`)}</div>
        ${card({
          body: state.error
            ? emptyState({ title: "Couldn't open", body: state.error })
            : !state.area
              ? emptyState({ title: "Choose an area", body: "Only the area you open is read, and each one is recorded." })
              : !state.data
                ? emptyState({ title: "Loading…" })
                : !state.data.rows.length
                  ? emptyState({ title: "Nothing here" })
                  : (() => {
                      const cols = [...new Set(state.data.rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== "id").slice(0, 8);
                      return html`<div class="table-wrap"><table class="table table-compact" data-role="support-rows"><thead><tr>${cols.map((c) => html`<th>${c}</th>`)}</tr></thead><tbody>${state.data.rows.map((r) => html`<tr>${cols.map((c) => html`<td class="col-wrap">${cellText(r[c])}</td>`)}</tr>`)}</tbody></table></div>${state.data.more ? html`<p class="stat-hint">Showing the first 100.</p>` : ""}`;
                    })(),
        })}`
    );
  draw();
  el.onclick = async (e) => {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act;
    if (act === "support-area") {
      state.area = t.dataset.id;
      state.data = null;
      state.error = null;
      draw();
      try {
        state.data = await ctx.call("supportRead", { sessionId: s.sessionId, businessId, area: state.area });
      } catch (err) {
        state.error = err.message;
      }
      draw();
    } else if (act === "support-exit") {
      try {
        await ctx.call("supportEnd", { sessionId: s.sessionId });
        ctx.toast("Support session ended. It's recorded.", "success");
      } catch (err) {
        ctx.toast(err.message, "danger");
      }
      ctx.navigate(`/businesses?b=${businessId}`);
    } else if (act === "support-backup") {
      const label = t.textContent;
      t.disabled = true;
      t.textContent = "Preparing…";
      try {
        const { blob, fileName } = await (ctx.download || apiDownload)("backup", { businessId, supportSessionId: s.sessionId });
        (ctx.save || saveBlob)(fileName, blob);
        ctx.toast("Master Backup downloaded. It's recorded with your support reason.", "success");
      } catch (err) {
        ctx.toast(err.message || "Couldn't prepare the backup.", "danger");
      }
      t.disabled = false;
      t.textContent = label;
    }
  };
}
