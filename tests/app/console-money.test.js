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
  it("compact rows: name / plan, billing + price, the date that matters, one status chip, ⋯", async () => {
    const rows = [
      { id: "abc", name: "ABC Trading", workspaceTemplateId: "distributor", planId: "distributor-plus", planName: "Distributor+", status: "active", state: "active", billingType: "monthly", amount: 89900, dueDate: "2026-10-12", attention: { kind: "overdue", date: "2026-10-12", days: 7, label: "7 days overdue", what: "Due", tone: "danger" } },
      { id: "home", name: "Prado Home", workspaceTemplateId: "household-payroll", planId: "household-basic", planName: "Luna Household", status: "active", state: "active", billingType: "annual", amount: 119000, termMonths: 12, dueDate: "2027-10-19", renewal: true, paidThrough: "2027-10-18", accessUntil: "2027-10-18", attention: null },
      { id: "trial", name: "Cruz Home", workspaceTemplateId: "household-payroll", planId: "household-basic", planName: "Luna Household", status: "active", state: "active", billingType: "annual", amount: 14900, termMonths: 1, dueDate: "2026-10-25", renewal: true, paidThrough: "2026-10-24", accessUntil: "2026-10-24", attention: { kind: "due", date: "2026-10-25", days: 5, label: "Due soon", what: "Renewal due", tone: "warning" } },
      { id: "wed", name: "Carlo & Yanie", workspaceTemplateId: "bridal-expense", planId: "bridal-plus", planName: "Luna Bridal Custom", status: "active", state: "active", billingType: "term", amount: 299000, termMonths: 12, dueDate: null, accessUntil: "2027-10-18", paidThrough: "2027-10-18", attention: null },
    ];
    const call = vi.fn(async () => ({ period: "2026-10", rows, next: null }));
    subscriptionsView(el, ctxWith(call));
    await flush();
    const text = (id) => el.querySelector(`[data-business="${id}"]`).textContent.replace(/\s+/g, " ");
    // The date by product: Distributor "Due …", Household "Access until …" / "Renewal due …", Bridal "Access ends …".
    expect(text("abc")).toMatch(/Monthly subscription ?₱899.*Due Oct 12, 2026.*7 days overdue/);
    expect(text("home")).toMatch(/12-month access ?₱1,190.*Access until Oct 18, 2027.*Active/);
    expect(text("trial")).toMatch(/1-month access ?₱149.*Renewal due Oct 25, 2026.*Due soon/);
    expect(text("wed")).toMatch(/12-month access ?₱2,990.*Access ends Oct 18, 2027.*Active/);
    expect(text("wed")).not.toMatch(/Past due/);
    expect(el.querySelector('[data-business="abc"] [data-act="row-menu"]')).not.toBeNull();
  });
});

describe("Usage", () => {
  it("workspace usage per business in plain words (2 of 4 users, 184 MB of 1 GB, downloads + transfer, orders); provider usage stays with the provider", async () => {
    const MB = 1024 ** 2;
    const call = vi.fn(async (action) =>
      action === "usageOverview"
        ? { next: null, rows: [{ id: "abc", name: "ABC Frozen Foods", workspaceTemplateId: "distributor", planId: "distributor-plus", status: "active", usage: { users: 2, userLimit: 4, storageBytes: 184 * MB, storageLimit: 1024 * MB, downloads: 9, transferBytes: 24.8 * MB, orders: 532 } }, { id: "home", name: "Prado Home", workspaceTemplateId: "household-payroll", planId: "household-plus", status: "active", usage: { users: 1, userLimit: 3, storageBytes: 3 * MB, storageLimit: 1024 * MB, downloads: 1, transferBytes: 0.2 * MB, orders: null } }] }
        : {}
    );
    usageCostView(el, ctxWith(call));
    await flush();
    const k = (id) => el.querySelector(`[data-widget="${id}"] .kpi-value`).textContent.trim();
    expect([k("transfer"), k("downloads")]).toEqual(["25 MB", "10"]);
    const cells = (id) => Object.fromEntries([...el.querySelectorAll(`[data-business="${id}"] [data-usage]`)].map((c) => [c.dataset.usage, c.textContent.replace(/\s+/g, " ").trim()]));
    expect(cells("abc")).toEqual({ users: "2 of 4", storage: "184 MB of 1.0 GB", excel: "9 · 25 MB", orders: "532" });
    expect(cells("home").orders).toBe("—");
    expect(el.textContent).not.toMatch(/CURRENT|OVERRIDE|EFFECTIVE|Spreadsheet imports|Est\. cost|margin/i);
    expect(el.querySelector('[data-role="provider-note"]').textContent).toMatch(/Firebase and Netlify bill the whole project/);
    expect(el.querySelector('[data-tab="rates"]')).toBeNull();
  });

  it("Provider bills: list, total, add, copy recurring (Luna's own bills)", async () => {
    const call = vi.fn(async (action, body) => {
      if (action === "expenses") return { month: body.month, rows: [{ id: "e1", month: body.month, category: "firebase_gcp", description: "Firebase", amount: 142000, kind: "recurring", notes: null, reference: null }], total: 142000, infra: 142000 };
      if (action === "copyRecurring") return { copied: 1 };
      return { expenseId: "e2" };
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
  });
});
