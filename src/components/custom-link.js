// "Your … link": a paid workspace's own public address (custom workspace
// link, 2026-10-26), in Settings and in Wedding Setup. Trial: shown locked,
// nothing typed is kept. Paid: check, save, copy, edit (the Owner;
// settings.manage). The server decides availability and the paid check;
// this only shows it. Plain words only: no DNS / hosting terms.
//   mountCustomLink(host, session, { api, toast, copy })

import { html, render } from "../lib/html.js";
import { normalizeLinkInput, linkLabelProblem } from "@shared/custom-links.js";

const TITLES = { "bridal-expense": "Your wedding link", distributor: "Your store link", "household-payroll": "Your household link" };
const defaultCopy = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

export function mountCustomLink(host, session, { api, toast = () => {}, copy = defaultCopy } = {}) {
  const canManage = session.member?.permissions?.["settings.manage"] === true;
  const title = TITLES[session.workspace?.templateId ?? session.entitlements?.workspaceTemplateId] || "Your workspace link";
  const state = { info: null, editing: false, value: "", check: null, busy: false, error: "" };
  const call = (body) => api("custom-link", { method: "POST", body });

  const field = (d) => html`<form class="cl-form" data-role="cl-form" novalidate>
      <div class="cl-input"><input class="input" name="name" value="${state.value}" maxlength="60" autocapitalize="none" autocomplete="off" spellcheck="false" aria-label="Your link name" placeholder="yourname" data-role="cl-name" /><span class="cl-domain">.${d}</span></div>
      ${state.check ? html`<p class="${state.check.available ? "cl-ok" : "cl-bad"}" data-role="cl-check" aria-live="polite">${state.check.available ? "✓ Available" : state.check.reason}</p>` : ""}
      ${state.error ? html`<p class="cl-bad" data-role="cl-error">${state.error}</p>` : ""}
      ${state.info.link ? html`<p class="stat-hint" data-role="cl-warning">Changing your link updates new links. Links you already shared keep working.${state.info.changesLeft <= 1 ? ` ${state.info.changesLeft} change left.` : ""}</p>` : ""}
      <div class="ws-link-actions">
        <button type="button" class="btn btn-compact" data-act="cl-check" ${state.busy ? "disabled" : ""}>Check</button>
        <button type="submit" class="btn btn-primary btn-compact" data-act="cl-save" ${state.busy ? "disabled" : ""}>Save link</button>
        ${state.info.link ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="cl-cancel">Cancel</button>` : ""}
      </div>
    </form>`;

  function draw() {
    const i = state.info;
    if (!i || !i.available) return render(host, "");
    let body;
    const peso = (c) => `₱${Math.round(c / 100).toLocaleString("en-PH")}`;
    if (!i.allowed && !i.link && i.paidPlan && i.addOn) {
      // A plan that sells the link as an add-on (Bridal: Premium wedding link).
      const a = i.addOn;
      body = html`<p class="ws-link-url cl-muted" data-role="cl-example">yourname.${i.domain}</p>
        <p class="stat-hint" data-role="cl-addon">Your wedding's own address. ${a.label} · +${peso(a.price)} once.</p>
        ${a.status === "billed"
          ? html`<p class="stat-hint" data-role="cl-addon-billed">Pay the ${peso(a.price)} bill to unlock it.</p>${canManage ? html`<a class="btn btn-compact" href="/subscription" data-link data-role="cl-pay">Pay now</a>` : ""}`
          : a.status === "waiting"
            ? html`<p class="stat-hint" data-role="cl-addon-waiting">Payment sent. Luna will confirm it, then you can choose your link.</p>`
            : canManage
              ? html`<button type="button" class="btn btn-compact" data-act="cl-buy" ${state.busy ? "disabled" : ""}>Get ${a.label} (+${peso(a.price)})</button>`
              : ""}
        ${state.error ? html`<p class="cl-bad" data-role="cl-error">${state.error}</p>` : ""}`;
    } else if (!i.allowed && !i.link) {
      body = html`<p class="ws-link-url cl-muted" data-role="cl-example">yourname.${i.domain}</p>
        <p class="stat-hint" data-role="cl-locked">${i.lockedMessage}</p>
        ${canManage ? html`<a class="btn btn-compact" href="/subscription" data-link data-role="cl-upgrade">Upgrade to choose your link</a>` : ""}`;
    } else if (state.editing || !i.link) {
      body = canManage ? html`${!i.link ? html`<p class="stat-hint">Choose an easy name for your public link.</p>` : ""}${field(i.domain)}` : html`<p class="stat-hint">The owner can choose a link here.</p>`;
    } else {
      const ready = i.link.setup === "active";
      body = html`<p class="ws-link-url" data-role="cl-url">${ready ? `https://${i.link.host}` : i.link.host}</p>
        ${ready ? "" : html`<p class="stat-hint" data-role="cl-pending">${i.link.note}</p>`}
        ${i.state === "unavailable" ? html`<p class="stat-hint" data-role="cl-paused">Paused while the account is on hold.</p>` : ""}
        <div class="ws-link-actions">
          ${ready ? html`<button type="button" class="btn btn-compact" data-act="cl-copy">Copy link</button>` : canManage ? html`<button type="button" class="btn btn-compact" data-act="cl-retry" ${state.busy ? "disabled" : ""}>Check again</button>` : ""}
          ${canManage && i.allowed ? html`<button type="button" class="btn btn-compact btn-ghost" data-act="cl-edit">Edit</button>` : ""}
          <span class="ws-link-copied" data-role="cl-copied" aria-live="polite"></span>
        </div>`;
    }
    const heading = i.addOn ? i.addOn.label : title;
    render(host, html`<section class="card" data-role="custom-link"><div class="card-header"><h2 class="card-title">${heading}</h2></div><div class="card-body">${body}</div></section>`);
  }

  async function run(fn) {
    state.busy = true;
    state.error = "";
    draw();
    try {
      await fn();
    } catch (err) {
      state.error = err.message || "Something went wrong. Please try again.";
    } finally {
      state.busy = false;
      draw();
    }
  }
  const typed = () => {
    const input = host.querySelector('[data-role="cl-name"]');
    state.value = input ? input.value : state.value;
    return normalizeLinkInput(state.value, state.info.domain);
  };
  // Read what's typed BEFORE run() redraws the form.
  const check = () => {
    const label = typed();
    return run(async () => {
      const problem = linkLabelProblem(label);
      state.check = problem ? { available: false, reason: problem } : await call({ action: "check", name: label });
      state.value = label;
    });
  };
  const save = () => {
    const label = typed();
    return run(async () => {
      const problem = linkLabelProblem(label);
      if (problem) {
        state.check = { available: false, reason: problem };
        return;
      }
      const r = await call({ action: "claim", name: label });
      state.info = r.customLink;
      state.editing = false;
      state.check = null;
      toast(r.customLink.link?.setup === "active" ? "Your link is ready ✓" : "Saved ✓ Your link will be ready in a few minutes.", "success");
      window.dispatchEvent(new CustomEvent("luna:session-changed"));
    });
  };

  host.onclick = async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "cl-check") return check();
    if (act === "cl-buy")
      return run(async () => {
        state.info = (await call({ action: "buy" })).customLink;
        toast(`Added ✓ Pay the bill in Subscription to unlock your ${state.info.addOn?.label ?? "link"}.`, "success");
      });
    if (act === "cl-edit") {
      state.editing = true;
      state.value = state.info.link.label;
      state.check = null;
      return draw();
    }
    if (act === "cl-cancel") {
      state.editing = false;
      state.error = "";
      return draw();
    }
    if (act === "cl-retry")
      return run(async () => {
        state.info = (await call({ action: "retry" })).customLink;
        if (state.info.link?.setup === "active") window.dispatchEvent(new CustomEvent("luna:session-changed"));
      });
    if (act === "cl-copy") {
      const ok = await copy(`https://${state.info.link.host}`);
      const box = host.querySelector('[data-role="cl-copied"]');
      if (box) box.textContent = ok ? "Copied ✓" : "Couldn't copy: select the link above";
    }
  };
  host.onsubmit = (e) => {
    if (e.target.closest('[data-role="cl-form"]')) {
      e.preventDefault();
      save();
    }
  };
  host.oninput = (e) => {
    if (e.target.dataset.role === "cl-name") state.check = null;
  };

  Promise.resolve()
    .then(() => call({ action: "get" }))
    .then((r) => {
      if (!r?.customLink) return;
      state.info = r.customLink;
      draw();
    })
    .catch(() => render(host, ""));
  return { refresh: () => call({ action: "get" }).then((r) => ((state.info = r.customLink), draw())) };
}
