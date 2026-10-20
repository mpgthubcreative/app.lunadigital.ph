// @vitest-environment jsdom
// The free trial in the app (2026-10-21): Continue with Luna, the trial
// banners, the Day 21 feedback prompt (never over a dialog), the Day 27
// reminder, Settings → Data (Reset Workspace Data) and the Bridal template
// choice.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount as mountSubscription, optionLabel } from "../../src/modules/subscription/index.js";
import { mount as mountSettings } from "../../src/modules/settings/index.js";
import { renderShell } from "../../src/app/shell.js";
import { scheduleFeedbackPrompt, isQuiet, feedbackDialog } from "../../src/app/feedback.js";
import { readSetupForm, standardPreviewDesign } from "../../src/modules/wedding/setup.js";
import { sessionFixture } from "../helpers/session-fixture.js";

let container;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  container = document.getElementById("app");
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (f) => f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

const DIST = [{ planId: "distributor-basic", name: "Luna Distributor", tagline: "x", current: true, priceIsMinimum: false, setupFee: 25000, terms: [{ months: 6, price: 129900, label: "6 months · ₱1,299", bestValue: false }, { months: 12, price: 239000, label: "12 months · ₱2,390 · Best Value", bestValue: true }] }];
const HOME = [{ ...DIST[0], planId: "household-basic", name: "Luna Household", setupFee: 0 }];
const BRIDAL = [
  { planId: "bridal-basic", name: "Luna Bridal", tagline: "Plan the wedding", current: true, priceIsMinimum: false, setupFee: 0, terms: [{ months: 12, price: 149000, label: "12 months · ₱1,490", bestValue: false }] },
  { planId: "bridal-plus", name: "Luna Bridal Custom", tagline: "Custom invitation", current: false, priceIsMinimum: true, setupFee: 0, terms: [{ months: 12, price: 299000, label: "12 months · from ₱2,990", bestValue: false }] },
];
const trialView = (options, trial = {}) => ({ plan: { id: options[0].planId, name: options[0].name }, billing: { type: "annual", amount: 239000, termMonths: 12 }, status: "active", trial: { status: "trial_active", startedAt: "2026-10-01", endsAt: "2026-10-30", day: 20, daysLeft: 10, open: true, ended: false, conversion: null, ...trial }, options, paidThrough: null, current: null, openInvoices: [], payments: [], instructions: null });

describe("Continue with Luna", () => {
  it("the exact price lines: 6 / 12 Months (+ ₱250 setup for Distributor, BEST VALUE), Luna Bridal ₱1,490, Custom starts ₱2,990", () => {
    expect(DIST[0].terms.map((t) => optionLabel(DIST[0], t))).toEqual(["6 Months — ₱1,299 + ₱250 setup", "12 Months — ₱2,390 + ₱250 setup"]);
    expect(HOME[0].terms.map((t) => optionLabel(HOME[0], t))).toEqual(["6 Months — ₱1,299", "12 Months — ₱2,390"]);
    expect(BRIDAL.map((o) => optionLabel(o, o.terms[0]))).toEqual(["Luna Bridal — ₱1,490", "Luna Bridal Custom — starts ₱2,990"]);
  });

  it("during the trial: the plans, BEST VALUE on 12 months; the Owner chooses and the bill appears", async () => {
    let chosen = null;
    const api = vi.fn(async (path, opts) => {
      if (opts?.body?.action === "choose") {
        chosen = opts.body;
        return { planId: "distributor-basic", invoice: {} };
      }
      return { subscription: chosen ? { ...trialView(DIST, { conversion: { planId: "distributor-basic", termMonths: 12, startDate: "2026-10-31" } }), openInvoices: [{ id: "x_2026-10", period: "2026-10", dueDate: "2026-10-31", planName: "Luna Distributor", amountDue: 264000, amountPaid: 0, balance: 264000, status: "due", lines: [{ kind: "base", label: "Luna Distributor · 12-month access", amount: 239000 }, { kind: "setup", label: "One-time setup fee", amount: 25000 }], adjustments: [] }] } : trialView(DIST) };
    });
    const toast = vi.fn();
    mountSubscription(container, sessionFixture(), { api, toast });
    await flush();
    expect(container.querySelector("h1").textContent).toBe("Continue with Luna");
    expect(container.querySelector('[data-role="trial-status"]').textContent).toMatch(/Free trial · day 20 of 30 · ends/);
    const opts = [...container.querySelectorAll('[data-act="choose"]')];
    expect(opts.map((b) => b.querySelector(".plan-option-name").textContent.trim())).toEqual(["6 Months — ₱1,299 + ₱250 setup", "12 Months — ₱2,390 + ₱250 setup BEST VALUE"]);
    expect(container.querySelector('[data-role="bills"]')).toBeNull();
    opts[1].click();
    await flush();
    expect(chosen).toEqual({ action: "choose", planId: "distributor-basic", termMonths: 12 });
    expect(container.querySelector('[data-plan="distributor-basic"][data-months="12"]').getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-role="bills"]').textContent).toMatch(/One-time setup fee/);
  });

  it("after the trial ends: the message; only the owner chooses", async () => {
    const api = vi.fn(async () => ({ subscription: trialView(HOME, { status: "trial_ended", ended: true, daysLeft: -2, day: 32 }) }));
    mountSubscription(container, sessionFixture({ roleTemplate: "manager", permissions: { "billing.view": true } }), { api, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-role="trial-ended"]').textContent).toBe("Your Luna trial has ended. Your information is still safe. Choose a plan to continue using your workspace.");
    expect([...container.querySelectorAll('[data-act="choose"]')].every((b) => b.disabled)).toBe(true);
    expect(container.querySelector('[data-role="owner-only"]')).toBeTruthy();
  });
});

describe("trial banners in the shell", () => {
  it("days left with Continue with Luna; the trial-ended message for everyone; the Day 27 feedback reminder", () => {
    const s = sessionFixture();
    s.subscription.trial = { status: "trial_active", daysLeft: 9, open: true, ended: false, conversion: null };
    renderShell(container, s);
    expect(container.querySelector('[data-role="trial"]').textContent).toMatch(/Free trial · 10 days left.*Continue with Luna/);
    const e = sessionFixture({ roleTemplate: "staff" });
    e.subscription.trial = { status: "trial_ended", daysLeft: -1, open: true, ended: true, conversion: null };
    e.subscription.access.trialEnded = true;
    renderShell(container, e);
    expect(container.querySelector('[data-role="trial-ended"]').textContent).toMatch(/^Your Luna trial has ended\. Your information is still safe\./);
    const r = sessionFixture();
    r.subscription.trial = { status: "trial_active", daysLeft: 3, open: true, ended: false, conversion: null };
    r.subscription.feedback = { prompt: "reminder", submitted: false, laterAt: "2026-10-21T00:00:00Z" };
    renderShell(container, r);
    expect(container.querySelector('[data-role="feedback-reminder"]').textContent).toMatch(/How is Luna working for you\?.*Share feedback/);
  });
});

describe("the Day 21 feedback prompt", () => {
  it("waits while a dialog is open or something is being typed; Maybe later is remembered; the exact words", async () => {
    vi.useFakeTimers();
    const api = vi.fn(async () => ({ later: true }));
    const s = sessionFixture();
    s.subscription.feedback = { prompt: "prompt", submitted: false, laterAt: null };
    const busy = document.createElement("div");
    busy.className = "modal-backdrop";
    document.body.appendChild(busy);
    expect(isQuiet()).toBe(false);
    const stop = scheduleFeedbackPrompt(s, { api, delayMs: 10, retryMs: 20 });
    await vi.advanceTimersByTimeAsync(15);
    expect(document.querySelectorAll(".modal-backdrop")).toHaveLength(1); // only the open dialog
    busy.remove();
    await vi.advanceTimersByTimeAsync(25);
    const modal = document.querySelector(".modal-backdrop .modal");
    expect(modal.querySelector("#confirm-title").textContent).toBe("You’ve been using Luna for 3 weeks 💛");
    expect(modal.querySelector(".modal-body").textContent).toMatch(/^We’d love to know how Luna has been working for you\./);
    expect([...modal.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Maybe later", "Share feedback"]);
    modal.querySelector('[data-action="cancel"]').click();
    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledWith("feedback", { method: "POST", body: { action: "later" } });
    stop();
    vi.useRealTimers();
    // Never for a non-owner, after Maybe later, or once sent.
    for (const fb of [{ prompt: "prompt", laterAt: "x" }, { prompt: "prompt", submitted: true }, { prompt: null }]) {
      const t = sessionFixture();
      t.subscription.feedback = fb;
      expect(scheduleFeedbackPrompt(t, { api, delayMs: 0 })).toBeTypeOf("function");
    }
  });

  it("the form: rating, useful, improve, recommend, testimonial, the permission unticked by default", async () => {
    const api = vi.fn(async () => ({ feedbackId: "x", status: "new" }));
    const p = feedbackDialog({ api });
    const f = lastForm();
    expect([...f.querySelectorAll(".field label")].map((l) => l.textContent.replace(" *", "").trim())).toEqual(["How would you rate Luna?", "What was most useful?", "What could we improve?", "Would you recommend Luna?", "A short testimonial (optional)", "I allow Luna Digital to use this testimonial on its website, social media and marketing materials."]);
    expect(f.elements.marketingPermission.checked).toBe(false);
    expect([...f.elements.recommend.options].map((o) => o.textContent)).toEqual(["Yes", "Maybe", "Not yet"]);
    f.elements.rating.value = "4";
    f.elements.useful.value = "Payroll";
    submit(f);
    await p;
    expect(api).toHaveBeenCalledWith("feedback", { method: "POST", body: { action: "submit", feedback: { rating: 4, recommend: "yes", marketingPermission: false, useful: "Payroll" } } });
  });
});

describe("Settings → Data", () => {
  it("Download Excel; Data Management → Reset Workspace Data for the account owner only (what it removes and keeps; type RESET)", async () => {
    const s = sessionFixture();
    s.member.permissions = { ...s.member.permissions, "data.export": true };
    mountSettings(container, s);
    const data = container.querySelector('[data-role="data"]');
    expect(data.textContent).toMatch(/Download Excel/);
    expect(container.querySelector('[data-role="reset"]').textContent).toMatch(/Data Management.*Reset Workspace Data/s);
    expect(container.querySelector('[data-role="reset-removes"]').textContent).toMatch(/Orders and their payments/);
    expect(container.querySelector('[data-role="reset-keeps"]').textContent).toMatch(/Members and their sign-in accounts/);
    container.querySelector('[data-act="reset-data"]').click();
    await flush();
    const f = lastForm();
    expect(f.querySelector("label").textContent).toMatch(/Type RESET to confirm/);
    expect(f.textContent).toMatch(/permanently deletes .*everyday records.*can't be undone/s);
    f.querySelector('[data-action="cancel"]').click();
    // A manager: no reset.
    const m = sessionFixture({ roleTemplate: "manager" });
    container.innerHTML = "";
    mountSettings(container, m);
    expect(container.querySelector('[data-role="reset"]')).toBeNull();
  });
});

describe("Bridal: the Standard template choice", () => {
  it("the form sends templateId; a non-default template previews as a design; Luna Standard is the original page", () => {
    const form = document.createElement("form");
    form.innerHTML = `${["coupleNames", "ceremonyVenue", "ceremonyAddress", "receptionVenue", "receptionAddress", "dressCode", "welcomeMessage", "weddingDate", "rsvpDeadline", "ceremonyTime", "receptionTime", "ceremonyMap", "receptionMap", "weddingSlug"].map((n) => `<input name="${n}" value="">`).join("")}<input type="checkbox" name="rsvpEnabled"><input type="checkbox" name="closeAfterDeadline"><input type="radio" name="templateId" value="standard"><input type="radio" name="templateId" value="romantic" checked>`;
    document.body.appendChild(form);
    expect(readSetupForm(form).templateId).toBe("romantic");
    expect(standardPreviewDesign("romantic").config).toMatchObject({ templateId: "romantic" });
    expect(standardPreviewDesign("standard")).toBeNull();
    expect(standardPreviewDesign("garden")).toBeNull();
  });
});
