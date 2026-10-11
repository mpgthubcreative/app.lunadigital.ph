// @vitest-environment jsdom
// Phase 18.6 Super Luna screens: Payments (review -> explicit confirm /
// reject with reason, bank settings), Subscriptions, Usage (cost, platform
// costs, rates). Everything through ctx.call (the operator API).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { subscriptionsView, paymentsView, usageCostView } from "../../src/console/money.js";
import { creatableWorkspaces } from "../../shared/operators.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";

let el;
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  el = document.getElementById("content");
});
const plans = Object.values(PLAN_SEED);
const ctxWith = (call, extra = {}) => ({ base: "/console", call, toast: vi.fn(), workspaces: creatableWorkspaces(), plans, workspaceName: (id) => id, planName: (id) => plans.find((p) => p.id === id)?.name ?? id, moduleLabel: (id) => id, navigate: vi.fn(), search: "", ...extra });
const lastBackdrop = () => [...document.querySelectorAll(".modal-backdrop")].at(-1);
const PAY = { id: "sp1", businessId: "abc", businessName: "ABC Trading", workspaceTemplateId: "distributor", planId: "growth", planName: "Growth", period: "2026-10", amountDue: 199000, amountSubmitted: 199000, paymentDate: "2026-10-15", reference: "BT-9", status: "for_verification", submittedAt: null };

describe("Payments", () => {
  it("lists For Verification first; Review shows expected vs submitted, proof and history; Confirm needs the explicit step", async () => {
    const call = vi.fn(async (action) => {
      if (action === "payments") return { rows: [PAY], next: null };
      if (action === "payment") return { payment: { ...PAY, method: "bank_transfer", hasProof: true, proofType: "image/png", submittedBy: "owner@abc.test" }, invoice: { period: "2026-10", amountDue: 199000, amountPaid: 0, status: "for_verification", dueDate: "2026-10-07" }, history: [{ ...PAY, id: "sp0", period: "2026-09", status: "paid" }] };
      if (action === "paymentProof") return { proof: { contentType: "image/png", dataBase64: "iVBORw0KGgo=" } };
      if (action === "confirmPayment") return { paymentId: "sp1", status: "paid", invoiceStatus: "paid", paidThrough: "2026-10-31" };
      return {};
    });
    const ctx = ctxWith(call);
    paymentsView(el, ctx);
    await flush();
    expect(call).toHaveBeenCalledWith("payments", { filters: { status: "for_verification" }, after: null });
    el.querySelector('[data-act="review"]').click();
    await flush();
    const review = lastBackdrop().querySelector('[data-role="payment-review"]');
    expect(review.textContent).toMatch(/Expected amount.*₱1,990\.00/s);
    expect(review.querySelector('[data-role="submitted"]').textContent).toMatch(/₱1,990\.00/);
    expect(review.querySelector(".proof-img").getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    expect(review.querySelector('[data-role="history"]').textContent).toMatch(/September 2026/);
    // Cancel on the confirmation: nothing is confirmed.
    review.querySelector('[data-act="confirm"]').click();
    await flush();
    expect(call).not.toHaveBeenCalledWith("confirmPayment", expect.anything()); // waits for the explicit confirmation
    [...lastBackdrop().querySelectorAll("button")].find((b) => /^Cancel$/.test(b.textContent.trim())).click();
    await flush();
    expect(call).not.toHaveBeenCalledWith("confirmPayment", expect.anything());
    review.querySelector('[data-act="confirm"]').click();
    await flush();
    const confirmBtn = [...lastBackdrop().querySelectorAll("button")].find((b) => /Confirm payment/.test(b.textContent));
    confirmBtn.click();
    await flush();
    expect(call).toHaveBeenCalledWith("confirmPayment", { paymentId: "sp1" });
    expect(ctx.toast).toHaveBeenCalledWith(expect.stringMatching(/Paid through/), "success");
  });

  it("Reject asks for the reason the business will see; Payment settings saves one bank account for every workspace", async () => {
    const call = vi.fn(async (action) => {
      if (action === "payments") return { rows: [PAY], next: null };
      if (action === "payment") return { payment: { ...PAY, hasProof: false }, invoice: null, history: [] };
      if (action === "billingSettings") return { settings: null };
      return { status: "rejected" };
    });
    paymentsView(el, ctxWith(call));
    await flush();
    el.querySelector('[data-act="review"]').click();
    await flush();
    lastBackdrop().querySelector('[data-act="reject"]').click();
    await flush();
    const form = [...document.querySelectorAll(".modal-backdrop form")].at(-1);
    form.elements.reason.value = "Wrong account";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(call).toHaveBeenCalledWith("rejectPayment", { paymentId: "sp1", reason: "Wrong account" });
    document.querySelectorAll(".modal-backdrop").forEach((b) => b.remove());
    el.querySelector('[data-act="settings"]').click();
    await flush();
    const s = [...document.querySelectorAll(".modal-backdrop form")].at(-1);
    s.elements.bankName.value = "BDO";
    s.elements.accountName.value = "Luna Digital";
    s.elements.accountNumber.value = "0012";
    s.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(call).toHaveBeenCalledWith("saveBillingSettings", { settings: { bankName: "BDO", accountName: "Luna Digital", accountNumber: "0012" } });
  });
});

describe("Subscriptions", () => {
  it("one row per subscription: plan, monthly price, status, paid through, next renewal, this month's bill", async () => {
    const call = vi.fn(async () => ({ period: "2026-10", rows: [{ id: "abc", name: "ABC Trading", workspaceTemplateId: "distributor", planId: "growth", planName: "Growth", status: "past_due", monthlyAmount: 199000, paidThrough: "2026-09-30", nextRenewal: "2026-10-01", bill: { amountDue: 199000, amountPaid: 0, status: "due", dueDate: "2026-10-07" } }], next: null }));
    subscriptionsView(el, ctxWith(call));
    await flush();
    const row = el.querySelector('[data-business="abc"]').textContent.replace(/\s+/g, " ");
    expect(row).toMatch(/Growth/);
    expect(row).toMatch(/₱1,990\.00/);
    expect(row).toMatch(/Past due/);
    expect(row).toMatch(/Payment Due/);
  });
});

describe("Usage", () => {
  it("estimate vs actual infrastructure bill, economics by workspace / plan (direct cost), businesses with Unavailable when not metered", async () => {
    const call = vi.fn(async (action) => {
      if (action === "economics") return { period: "2026-10", estimatedTotal: 128000, byWorkspace: [{ key: "distributor", tenants: 2, subscribers: 2, revenue: 1800000, estimatedCost: 150000, estimatedGrossProfit: 1650000, margin: 91.7 }], byPlan: [{ key: "growth", tenants: 1, subscribers: 1, revenue: 199000, estimatedCost: 8240, estimatedGrossProfit: 190760, margin: 95.9 }], topConsumers: [] };
      if (action === "usageCost") return { period: "2026-10", ratesConfigured: true, next: null, rows: [{ id: "abc", name: "ABC Frozen Foods", workspaceTemplateId: "distributor", planId: "growth", status: "active", limits: { ordersPerMonth: 1000, storageBytes: 250 * 1024 ** 2 }, commercial: { orders: 428, imports: 1, exports: 18, rowsExported: 14250, storageBytes: 86 * 1024 ** 2 }, infrastructure: { storageBytes: 86 * 1024 ** 2, exportBytes: null }, estimate: { total: 8240, lines: [] }, revenue: 199000, directMargin: 190760 }] };
      if (action === "expenses") return { month: "2026-10", rows: [], total: 377000, infra: 142000 };
      return {};
    });
    usageCostView(el, ctxWith(call));
    await flush();
    const k = (id) => el.querySelector(`[data-widget="${id}"] .kpi-value`).textContent.trim();
    expect([k("estimate"), k("actual"), k("difference")]).toEqual(["₱1,280.00", "₱1,420.00", "₱140.00"]);
    expect(el.querySelector('[data-role="cost-summary"]').textContent).toMatch(/Unavailable/);
    const row = el.querySelector('[data-business="abc"]').textContent.replace(/\s+/g, " ");
    expect(row).toMatch(/428 \/ 1,000/);
    expect(row).toMatch(/Unavailable/);
    expect(row).toMatch(/₱82\.40/);
    expect(el.querySelector('[data-role="economics-workspace"]').textContent).toMatch(/91\.7%/);
  });

  it("Platform costs: list, total, add (Luna's own costs), copy recurring; Cost rates: versioned list + add", async () => {
    const call = vi.fn(async (action, body) => {
      if (action === "expenses") return { month: body.month, rows: [{ id: "e1", month: body.month, category: "firebase_gcp", description: "Firebase", amount: 142000, kind: "recurring", notes: null, reference: null }], total: 142000, infra: 142000 };
      if (action === "costRates") return { rates: [{ id: "r1", resource: "storage_gb_month", provider: "firebase_gcp", unit: "GB-month", ratePerUnit: 150, freeAllowance: 0, effectiveFrom: "2026-01-01" }] };
      if (action === "copyRecurring") return { copied: 1 };
      return { expenseId: "e2", rateId: "r2" };
    });
    usageCostView(el, ctxWith(call, { search: "?tab=costs" }));
    await flush();
    expect(el.querySelector('[data-role="total"]').textContent).toBe("₱1,420.00");
    el.querySelector('[data-act="add"]').click();
    const f = [...document.querySelectorAll(".modal-backdrop form")].at(-1);
    f.elements.category.value = "netlify";
    f.elements.description.value = "Netlify Pro";
    f.elements.amount.value = "1100";
    f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(call).toHaveBeenCalledWith("addExpense", { expense: expect.objectContaining({ category: "netlify", description: "Netlify Pro", amount: 110000, kind: "recurring" }) });
    el.querySelector('[data-act="copy"]').click();
    await flush();
    expect(call).toHaveBeenCalledWith("copyRecurring", { month: expect.stringMatching(/^\d{4}-\d{2}$/) });
    el.querySelector('[data-tab="rates"]').click();
    await flush();
    expect(el.querySelector('[data-rate="r1"]').textContent).toMatch(/Storage retained.*1\.5/s);
    el.querySelector('[data-act="add-rate"]').click();
    const r = [...document.querySelectorAll(".modal-backdrop form")].at(-1);
    r.elements.rate.value = "3";
    r.elements.effectiveFrom.value = "2026-11-01";
    r.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(call).toHaveBeenCalledWith("addCostRate", { rate: { resource: "storage_gb_month", ratePerUnit: 300, effectiveFrom: "2026-11-01", freeAllowance: 0 } });
  });
});
