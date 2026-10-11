// @vitest-environment jsdom
// Phase 18.6: the workspace Owner's Subscription page.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "../../src/modules/subscription/index.js";
import { buildRoutes, routeAllowed, SUBSCRIPTION_ROUTE } from "../../src/app/routes.js";
import { sessionFixture } from "../helpers/session-fixture.js";

let container;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  container = document.getElementById("app");
});
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const NOW = () => new Date("2026-10-16T04:00:00Z");

const VIEW = {
  plan: { id: "household-plus", name: "Household Plus" },
  status: "past_due",
  monthlyAmount: 29900,
  paidThrough: "2026-09-30",
  nextRenewal: "2026-10-01",
  current: { period: "2026-10", dueDate: "2026-10-07", planName: "Household Plus", amountDue: 29900, amountPaid: 0, balance: 29900, status: "due" },
  openInvoices: [
    { period: "2026-10", dueDate: "2026-10-07", planName: "Household Plus", amountDue: 29900, amountPaid: 0, balance: 29900, status: "due" },
  ],
  payments: [{ id: "sp1", period: "2026-10", amountSubmitted: 29900, paymentDate: "2026-10-10", reference: "BT-1", status: "rejected", statusLabel: "Payment Rejected", rejectionReason: "Reference doesn't match" }],
  instructions: { bankName: "BDO", accountName: "Luna Digital", accountNumber: "0012-3456-78", instructions: "Put your business name in the note." },
};

describe("Subscription page", () => {
  it("shows plan, status, amount due, the bill with Pay, Luna's bank details and the rejection reason", async () => {
    const api = vi.fn(async () => ({ subscription: VIEW }));
    mount(container, sessionFixture(), { api, now: NOW, toast: () => {} });
    await flush();
    expect(api).toHaveBeenCalledWith("subscription");
    expect(container.querySelector('[data-role="plan"]').textContent).toMatch(/Household Plus/);
    expect(container.querySelector('[data-role="plan"]').textContent).toMatch(/Past due/);
    expect(container.querySelector('[data-role="amount-due"] .kpi-value').textContent).toMatch(/299\.00/);
    expect(container.querySelector('[data-period="2026-10"]').textContent).toMatch(/October 2026.*Payment Due/s);
    expect(container.querySelector('[data-role="account-number"]').textContent).toBe("0012-3456-78");
    expect(container.querySelector('[data-role="reason"]').textContent).toBe("Reference doesn't match");
  });

  it("Pay: sends ONE submission (with an idempotency key), the amount, date, reference and proof; never marks it paid itself", async () => {
    const api = vi.fn(async (path, opts) => (opts ? { paymentId: "sp2", status: "for_verification" } : { subscription: VIEW }));
    const toast = vi.fn();
    mount(container, sessionFixture(), { api, now: NOW, toast });
    await flush();
    container.querySelector('[data-act="pay"]').click();
    const form = lastForm();
    expect(form.elements.amount.value).toBe("299.00");
    form.elements.reference.value = "BT-2";
    // jsdom has no canvas: send a PDF receipt (passed through as is).
    const pdf = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2])], "receipt.pdf", { type: "application/pdf" });
    Object.defineProperty(form.elements.proof, "files", { value: [pdf] });
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    const call = api.mock.calls.find((c) => c[1]);
    expect(call[0]).toBe("subscription");
    expect(call[1].body).toMatchObject({ action: "submit", idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{16,64}$/), payment: { period: "2026-10", amount: 29900, paymentDate: "2026-10-16", reference: "BT-2" }, proof: { contentType: "application/pdf" } });
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Luna will confirm/), "success");
  });

  it("a bill already sent waits for Luna (no second Pay); all paid shows a calm empty state", async () => {
    const waiting = { ...VIEW, status: "active", openInvoices: [{ ...VIEW.openInvoices[0], status: "for_verification" }] };
    mount(container, sessionFixture(), { api: vi.fn(async () => ({ subscription: waiting })), now: NOW, toast: () => {} });
    await flush();
    expect(container.querySelector('[data-act="pay"]')).toBeNull();
    expect(container.textContent).toMatch(/Waiting for Luna to confirm/);
    document.body.innerHTML = '<div id="app"></div>';
    container = document.getElementById("app");
    mount(container, sessionFixture(), { api: vi.fn(async () => ({ subscription: { ...VIEW, status: "active", openInvoices: [], paidThrough: "2026-10-31" } })), now: NOW, toast: () => {} });
    await flush();
    expect(container.textContent).toMatch(/You're all paid up/);
  });

  it("the route is the Owner's only (billing.view): not Managers or Staff", () => {
    expect(buildRoutes(sessionFixture()).map((r) => r.path)).toContain("/subscription");
    for (const role of ["manager", "staff"]) {
      const s = sessionFixture({ roleTemplate: role });
      expect(buildRoutes(s).map((r) => r.path), role).not.toContain("/subscription");
      expect(routeAllowed(s, SUBSCRIPTION_ROUTE), role).toBe(false);
    }
  });
});
