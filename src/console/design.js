// Luna Console: one wedding's invitation design (Luna Bridal Custom, legacy
// since 2026-10-25: only weddings already on it publish a customized design).
// Super Admin turns the designer's approved mockup into a design config for
// THIS businessId: template, colours, fonts, layout, hero, section order /
// visibility / colours, designer images, a few wording lines. Draft → Ready →
// Published; guests keep seeing the live (Standard) invitation until Publish.
// Everything goes through /api/invitation-design (operators only).

import { html, render } from "../lib/html.js";
import { pageHeader, card } from "../components/ui.js";
import { confirmDialog } from "../components/feedback.js";
import { api } from "../lib/api.js";
import { designAssetDataUrl, PHOTO_ACCEPT } from "../lib/image.js";
import { TEMPLATES, TEMPLATE_IDS, FONTS, DESIGN_ENUMS, SECTION_IDS, SECTION_LABELS, ASSET_SLOT_LABELS, SAMPLE_GUEST, resolveDesign } from "@shared/invitation-design.js";
import { openInvitePreview } from "../modules/wedding/invitation/preview.js";

const call = (action, body) => api("invitation-design", { method: "POST", body: { action, ...body } });
const COLOR_LABELS = { background: "Page", card: "Card", text: "Text", muted: "Quiet text", accent: "Accent", accentText: "Text on accent", border: "Lines" };
const LAYOUT_LABELS = { cardWidth: "Card width", spacing: "Spacing", align: "Alignment", corners: "Corners", buttonStyle: "Buttons", frame: "Frame", namesCase: "Names" };
const when = (v) => (v ? new Date(typeof v === "string" ? v : v._seconds ? v._seconds * 1000 : v).toLocaleString("en-PH") : "—");

export async function invitationDesignView(el, ctx, businessId) {
  render(el, html`${pageHeader({ title: "Invitation design" })}<p class="stat-hint">Loading…</p>`);
  let w;
  try {
    w = await call("get", { businessId });
  } catch (err) {
    render(el, html`${pageHeader({ title: "Invitation design" })}<p class="form-error">${err.message}</p>`);
    return;
  }
  // Working copy: the resolved draft (every value explicit).
  let d = resolveDesign(w.draft.config);
  const assetOpts = () => [{ id: "", name: "— None —" }, ...w.assets];
  const st = w.status;

  function draw() {
    const sel = (name, value, options) => html`<select class="select select-compact" name="${name}" aria-label="${name}">${options.map(([v, l]) => html`<option value="${v}" ${v === value ? "selected" : ""}>${l}</option>`)}</select>`;
    const imgSel = (name, value) => sel(name, value || "", assetOpts().map((a) => [a.id, a.name]));
    render(
      el,
      html`${pageHeader({ title: `Invitation design · ${w.business.name}`, subtitle: `${w.business.id} · plan ${w.business.planId ?? "—"}`, actions: html`<a class="btn" href="${ctx.base}/businesses?b=${businessId}" data-link>Back to business</a>` })}
        ${st.level !== "custom" ? html`<div class="banner" role="status" data-role="not-entitled">This wedding is on Luna Bridal: the couple chooses and personalizes one of the invitation designs in Wedding Setup. Customized designs are legacy (Luna Bridal Custom is no longer sold): only weddings already on it can publish one.</div>` : ""}
        <p data-role="design-status"><strong>Guests see: ${st.live === "custom" ? `Custom design v${st.publishedVersion}` : "Standard invitation"}</strong> · Draft: ${w.draft.state === "ready" ? "Ready" : "Draft"}${w.draft.updatedAt ? ` · saved ${when(w.draft.updatedAt)}` : " · not saved yet (starts from Standard)"}</p>
        <form data-role="design-form" class="section grid grid-2">
          ${card({
            title: "Template & colours",
            body: html`<div class="field"><label>Template</label>${sel("templateId", d.templateId, TEMPLATE_IDS.map((id) => [id, `${TEMPLATES[id].label} · ${TEMPLATES[id].category === "customized" ? "Customized" : "Standard"}`]))} <button type="button" class="btn btn-compact" data-act="template-defaults">Use this template's defaults</button></div>
              <div class="grid grid-2">${Object.entries(COLOR_LABELS).map(([k, l]) => html`<div class="field"><label for="c-${k}">${l}</label><input class="input" type="color" id="c-${k}" name="color-${k}" value="${d.theme[k]}"></div>`)}</div>
              ${["headingFont", "bodyFont", "scriptFont"].map((k) => html`<div class="field"><label>${{ headingFont: "Heading font", bodyFont: "Body font", scriptFont: "Script line font" }[k]}</label>${sel(k, d.theme[k], FONTS.map((f) => [f, f]))}</div>`)}`,
          })}
          ${card({
            title: "Layout & hero",
            body: html`${Object.entries(LAYOUT_LABELS).map(([k, l]) => html`<div class="field"><label>${l}</label>${sel(`layout-${k}`, d.layout[k], DESIGN_ENUMS[k].map((v) => [v, v]))}</div>`)}
              <div class="field"><label>Hero</label>${sel("heroStyle", d.hero.style, DESIGN_ENUMS.heroStyle.map((v) => [v, v]))}</div>
              <div class="field"><label>Gallery</label>${sel("galleryStyle", d.gallery.style, DESIGN_ENUMS.galleryStyle.map((v) => [v, v]))}</div>
              <div class="field"><label for="t-script">Line under the names</label><input class="input" id="t-script" name="text-scriptLine" maxlength="60" value="${d.texts.scriptLine ?? ""}" placeholder="are getting married"></div>
              <div class="field"><label for="t-rsvp">RSVP title</label><input class="input" id="t-rsvp" name="text-rsvpTitle" maxlength="30" value="${d.texts.rsvpTitle ?? ""}" placeholder="RSVP"></div>
              <div class="field"><label for="t-footer">Footer line</label><input class="input" id="t-footer" name="text-footerLine" maxlength="120" value="${d.texts.footerLine ?? ""}"></div>`,
          })}
          ${card({
            title: "Sections (order, shown, colours)",
            body: html`<ul class="list" data-role="sections">${d.sections.order.map((id, i) => {
              const s = d.sections.styles[id] || {};
              return html`<li class="design-section" data-sec="${id}"><span class="design-sec-name">${SECTION_LABELS[id]}</span>
                <label class="wl-check"><input type="checkbox" name="show-${id}" ${d.sections.visible[id] ? "checked" : ""} ${id === "rsvp" ? "disabled" : ""}> shown</label>
                <button type="button" class="btn btn-compact btn-ghost" data-act="up" data-id="${id}" ${i === 0 ? "disabled" : ""} aria-label="Move ${SECTION_LABELS[id]} up">↑</button><button type="button" class="btn btn-compact btn-ghost" data-act="down" data-id="${id}" ${i === d.sections.order.length - 1 ? "disabled" : ""} aria-label="Move ${SECTION_LABELS[id]} down">↓</button>
                <input class="input input-compact" name="sbg-${id}" placeholder="bg #hex" value="${s.background ?? ""}" aria-label="${SECTION_LABELS[id]} background colour" size="8">
                <input class="input input-compact" name="stx-${id}" placeholder="text #hex" value="${s.text ?? ""}" aria-label="${SECTION_LABELS[id]} text colour" size="8">
                ${imgSel(`simg-${id}`, s.backgroundAsset)}</li>`;
            })}</ul>`,
          })}
          ${card({
            title: "Designer images",
            body: html`${Object.entries(ASSET_SLOT_LABELS).map(([k, l]) => html`<div class="field"><label>${l}</label>${imgSel(`asset-${k}`, d.assets[k])}</div>`)}
              <p class="stat-hint">PNG / JPG / WebP / SVG from the designer, up to about 500 KB each.</p>
              <label class="btn btn-compact">Upload image<input class="visually-hidden" type="file" accept="${PHOTO_ACCEPT},image/svg+xml,.svg" data-role="asset-upload" aria-label="Upload a design image"></label>
              <ul class="list" data-role="assets">${w.assets.map((a) => html`<li class="design-asset"><img src="${a.dataUrl}" alt="${a.name}"><span>${a.name} · ${Math.round(a.bytes / 1024)} KB</span><button type="button" class="btn btn-compact btn-ghost" data-act="asset-delete" data-id="${a.id}">Delete</button></li>`)}</ul>`,
          })}
        </form>
        <div class="page-actions" data-role="design-actions">
          <button type="button" class="btn" data-act="preview">Preview draft</button>
          <button type="button" class="btn btn-primary" data-act="save">Save draft</button>
          <button type="button" class="btn" data-act="ready">${w.draft.state === "ready" ? "Back to draft" : "Mark ready"}</button>
          <button type="button" class="btn btn-primary" data-act="publish" ${st.level === "custom" ? "" : "disabled"}>Publish</button>
          ${st.live === "custom" ? html`<button type="button" class="btn" data-act="standard">Show Standard to guests</button>` : w.published ? html`<button type="button" class="btn" data-act="custom" ${st.level === "custom" ? "" : "disabled"}>Show custom v${w.published.version} to guests</button>` : ""}
        </div>
        ${w.history.length ? card({ title: "Published versions", body: html`<ul class="list" data-role="history">${w.history.map((h) => html`<li>v${h.version} · ${when(h.publishedAt)} · ${h.publishedBy?.name ?? ""} <button type="button" class="btn btn-compact btn-ghost" data-act="restore" data-id="${h.version}">Restore into draft</button></li>`)}</ul>` }) : ""}`
    );
  }

  // Form → a full, explicit design config (validated again by the server).
  function readForm() {
    const f = el.querySelector('[data-role="design-form"]').elements;
    const v = (n) => f[n]?.value ?? "";
    const hex = (x) => (/^#[0-9a-fA-F]{6}$/.test(x.trim()) ? x.trim().toLowerCase() : null);
    const styles = {};
    for (const id of SECTION_IDS) {
      const s = { background: hex(v(`sbg-${id}`)), text: hex(v(`stx-${id}`)), backgroundAsset: v(`simg-${id}`) || null };
      if (s.background || s.text || s.backgroundAsset) styles[id] = Object.fromEntries(Object.entries(s).filter(([, x]) => x));
    }
    return {
      templateId: v("templateId"),
      theme: { ...Object.fromEntries(Object.keys(COLOR_LABELS).map((k) => [k, v(`color-${k}`)])), headingFont: v("headingFont"), bodyFont: v("bodyFont"), scriptFont: v("scriptFont") },
      layout: Object.fromEntries(Object.keys(LAYOUT_LABELS).map((k) => [k, v(`layout-${k}`)])),
      hero: { style: v("heroStyle") },
      sections: { order: [...d.sections.order], visible: Object.fromEntries(SECTION_IDS.map((id) => [id, id === "rsvp" ? true : Boolean(f[`show-${id}`]?.checked)])), styles },
      assets: Object.fromEntries(Object.keys(ASSET_SLOT_LABELS).map((k) => [k, v(`asset-${k}`) || null]).filter(([, x]) => x)),
      texts: Object.fromEntries(["scriptLine", "rsvpTitle", "footerLine"].map((k) => [k, v(`text-${k}`).trim()]).filter(([, x]) => x)),
      gallery: { style: v("galleryStyle") },
    };
  }
  const reload = () => invitationDesignView(el, ctx, businessId);
  const run = async (fn, ok) => {
    try {
      await fn();
      if (ok) ctx.toast(ok, "success");
      reload();
    } catch (err) {
      ctx.toast(err.message || "Something went wrong", "danger");
    }
  };

  el.onclick = async (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const a = b.dataset.act;
    if (a === "up" || a === "down") {
      d = resolveDesign({ ...readForm() });
      const o = d.sections.order;
      const i = o.indexOf(b.dataset.id);
      const j = a === "up" ? i - 1 : i + 1;
      if (j >= 0 && j < o.length) [o[i], o[j]] = [o[j], o[i]];
      draw();
    } else if (a === "template-defaults") {
      d = resolveDesign({ templateId: el.querySelector('[name="templateId"]').value });
      draw();
    } else if (a === "save") run(() => call("saveDraft", { businessId, config: readForm() }), "Draft saved. Guests still see the live invitation.");
    else if (a === "ready") run(() => call("setState", { businessId, state: w.draft.state === "ready" ? "draft" : "ready" }), "Updated.");
    else if (a === "publish") {
      if (!(await confirmDialog({ title: "Publish this design?", body: "Every guest link for this wedding shows it at once. Guests, links and RSVPs don't change. Save the draft first if you changed anything.", confirmLabel: "Publish" }))) return;
      run(() => call("publish", { businessId }), "Published. Guest links now show the custom design.");
    } else if (a === "standard") run(() => call("useStandard", { businessId }), "Guests see the Standard invitation (the custom design is kept).");
    else if (a === "custom") run(() => call("useCustom", { businessId }), "The custom design is live again.");
    else if (a === "restore") run(() => call("restore", { businessId, version: Number(b.dataset.id) }), "Version copied into the draft.");
    else if (a === "asset-delete") run(() => call("deleteAsset", { businessId, assetId: b.dataset.id }), "Image deleted.");
    else if (a === "preview") {
      // The draft on screen (even unsaved), with the couple's real content and a sample guest.
      const cfg = resolveDesign(readForm());
      const assets = Object.fromEntries(w.assets.map((x) => [x.id, x.dataUrl]));
      const s = w.content.setup || {};
      // The sample guest (never a real guest or link); the wedding = invitation fields only.
      const invitation = { wedding: s, hero: w.content.hero, guest: { ...SAMPLE_GUEST }, rsvpOpen: true, sample: true, design: { config: cfg, assets }, gallery: [], entourage: [] };
      try {
        const extra = await call("preview", { businessId, which: "draft" });
        invitation.gallery = extra.gallery || [];
        invitation.entourage = extra.entourage || [];
      } catch {
        /* preview without gallery / entourage */
      }
      await openInvitePreview({ token: "P".repeat(32), fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ success: true, invitation }) }), note: `Draft design for ${w.business.name} (sample guest)` });
    }
  };
  el.onchange = async (e) => {
    if (e.target.dataset?.role !== "asset-upload") return;
    const file = e.target.files[0];
    if (!file) return;
    d = resolveDesign(readForm());
    run(async () => call("uploadAsset", { businessId, name: file.name, dataUrl: await designAssetDataUrl(file) }), "Image uploaded.");
  };
  draw();
}
