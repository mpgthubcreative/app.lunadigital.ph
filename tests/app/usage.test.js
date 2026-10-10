// @vitest-environment jsdom
// Phase 18 screens: the tenant Settings usage (plan limits with bars and %,
// informational counters as plain numbers, storage as a current total, the
// 12-month history on request) and the console's limit overrides (intent
// only, storage typed in MB, a warning + second confirmation before going
// at / below current usage) and the cross-business Usage page.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../src/lib/api.js", () => ({ api: vi.fn(), apiDownload: vi.fn(), setTokenProvider: vi.fn(), setBusinessSelector: vi.fn() }));
import { api } from "../../src/lib/api.js";
import { mount as mountSettings } from "../../src/modules/settings/index.js";
import { businessDetailView, usageView, limitOverrideDialog } from "../../src/console/views.js";
import { sessionFixture } from "../helpers/session-fixture.js";
import { PLAN_SEED } from "../../shared/plans.seed.js";
import { creatableWorkspaces, moduleTable } from "../../shared/operators.js";
import { resolveTenantConfig } from "../../shared/tenant-config.js";
import { limitRows, historyRows, previousPeriods } from "../../shared/metering.js";

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
let el;
beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div><main id="content"></main>';
  el = document.getElementById("content");
  api.mockReset();
});
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const submit = (f) => f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
const MB = 1024 * 1024;

describe("Settings usage (owner)", () => {
  const owner = () => {
    const s = sessionFixture({ planId: "starter" });
    s.usage = { ...s.usage, values: { ...s.usage.values, ordersCreated: 420, activeUsers: 2, storageBytes: 86 * MB, excelImports: 0, exportsGenerated: 14, paymentsRecorded: 31 } };
    s.entitlements.limits = { ...s.entitlements.limits, storageBytes: 100 * MB };
    return s;
  };

  it("plan limits: used / limit and %, storage in bytes units; informational counters are numbers without bars", () => {
    mountSettings(el, owner());
    const orders = el.querySelector('[data-limit="ordersPerMonth"]');
    expect(orders.textContent).toMatch(/Orders per month \(this month\)/);
    expect(orders.querySelector(".meter-value").textContent.replace(/\s+/g, " ")).toMatch(/420 \/ 500 84%/);
    expect(orders.querySelector("progress").getAttribute("value")).toBe("84");
    const storage = el.querySelector('[data-limit="storageBytes"]');
    expect(storage.textContent).toMatch(/File storage/);
    expect(storage.textContent).not.toMatch(/this month/);
    expect(storage.querySelector('[data-role="percent"]').textContent).toBe("86%");
    expect(el.querySelector('[data-limit="users"] [data-role="percent"]').textContent).toBe("100%");
    const activity = el.querySelector('[data-role="activity"]');
    expect(activity.textContent).toMatch(/Excel exports\s*14/);
    expect(activity.textContent).toMatch(/Customer payments recorded\s*31/);
    expect(activity.querySelector("progress")).toBeNull();
    expect(activity.textContent).not.toMatch(/Payroll|Guests/); // not this workspace's meters
  });

  it("history loads on request; a month with no recorded usage says so (never zeros)", async () => {
    const periods = previousPeriods("2026-10", 12);
    api.mockResolvedValue({ history: historyRows(periods, periods.map((p) => (p === "2026-10" ? { ordersCreated: 420, timezone: "Asia/Manila" } : null))) });
    mountSettings(el, owner());
    el.querySelector('[data-act="history"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("/api/usage");
    const table = el.querySelector('[data-role="usage-history"]');
    expect(table.querySelector('[data-period="2026-10"]').textContent).toMatch(/420/);
    expect(table.querySelector('[data-period="2026-09"]').textContent).toMatch(/No recorded usage/);
  });

  it("a manager sees no usage at all", () => {
    mountSettings(el, sessionFixture({ roleTemplate: "manager" }));
    expect(el.querySelector('[data-role="limits"]')).toBeNull();
    expect(el.querySelector('[data-role="activity"]')).toBeNull();
  });
});

describe("console: limits, overrides and usage", () => {
  const ctxWith = (call) => ({ base: "/console", call, toast: vi.fn(), workspaces: creatableWorkspaces(), plans: Object.values(PLAN_SEED), workspaceName: (id) => id, planName: (id) => id, moduleLabel: (id) => id, navigate: vi.fn(), search: "" });
  const values = { activeUsers: 2, ordersCreated: 284, excelImports: 0, storageBytes: 86 * MB };
  const ents = { limits: { ...PLAN_SEED.starter.limits, ordersPerMonth: 1000, storageBytes: 250 * MB } };
  const DETAIL = {
    business: { id: "abc", name: "ABC", timezone: "Asia/Manila", workspaceTemplateId: "distributor", workspaceName: "Distributor", workspaceTemplateVersion: 5, planId: "starter", planName: "Starter", status: "active", adminRevision: 4, entitlementsValid: true, entitlementProblems: [] },
    modules: moduleTable({ templateId: "distributor", plan: PLAN_SEED.starter }).map((m) => ({ ...m, effective: m.computed })),
    members: [],
    usage: { period: "2026-10" },
    meters: [{ id: "exportsGenerated", label: "Excel exports", definition: "d", value: 3 }],
    limitRows: limitRows({ plan: PLAN_SEED.starter, overrides: { ordersPerMonth: 1000, storageBytes: 250 * MB }, entitlements: ents, usage: values }),
    storage: { bytes: 86 * MB, reservedBytes: 0 },
    history: historyRows(previousPeriods("2026-10", 12), [{ ordersCreated: 284 }, ...Array(11).fill(null)]),
    historyMeters: ["ordersCreated", "excelImports", "exportsGenerated", "rowsExported", "paymentsRecorded", "expensesCreated"],
    config: resolveTenantConfig(null, "distributor"),
    terms: [],
    audit: [],
  };

  it("the Limits table shows Plan | Override | Effective | Current (Storage 100 MB plan, 250 MB override, 86 MB used)", async () => {
    businessDetailView(el, ctxWith(vi.fn(async () => DETAIL)), "abc");
    await flush();
    const row = (k) => [...el.querySelector(`[data-limit="${k}"]`).querySelectorAll("td")].map((td) => td.textContent.replace(/\s+/g, " ").trim());
    expect(row("ordersPerMonth").slice(0, 5)).toEqual(["Orders per month / month", "500", "1,000", "1,000", "284 28%"]);
    expect(row("storageBytes").slice(0, 5)).toEqual(["File storage", "1.0 GB", "250 MB", "250 MB", "86 MB 34%"]);
    expect(row("users")[4]).toMatch(/2 100% At limit/);
    expect(el.querySelector('[data-role="history"] [data-period="2026-09"]').textContent).toMatch(/No recorded usage/);
    expect(el.querySelector('[data-role="usage"]').textContent).toMatch(/Excel exports\s*3/);
  });

  it("set override sends intent only: { limitKey, value, reason, expectedRevision }; storage typed in MB, sent in bytes", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const row = DETAIL.limitRows.find((l) => l.limitKey === "storageBytes");
    const p = limitOverrideDialog({ call }, { businessId: "abc", row, expectedRevision: 4 });
    const f = lastForm();
    f.elements.value.value = "300";
    f.elements.reason.value = "Client stores more screenshots";
    submit(f);
    await p;
    expect(call).toHaveBeenCalledWith("setLimitOverride", { businessId: "abc", limitKey: "storageBytes", value: 300 * MB, reason: "Client stores more screenshots", expectedRevision: 4 });
  });

  it("lowering to or below current usage warns and needs a second confirmation; cancelling sends nothing", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const row = DETAIL.limitRows.find((l) => l.limitKey === "ordersPerMonth");
    const p = limitOverrideDialog({ call }, { businessId: "abc", row, expectedRevision: 4 });
    let f = lastForm();
    f.elements.value.value = "200";
    f.elements.reason.value = "test";
    submit(f);
    await flush();
    f = lastForm();
    expect(f.textContent).toMatch(/284 already used, at or above the new limit of 200/);
    f.querySelector('[data-action="cancel"]').click();
    await p;
    expect(call).not.toHaveBeenCalled();
  });

  it("Default removes the override (value null)", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const row = DETAIL.limitRows.find((l) => l.limitKey === "storageBytes");
    const p = limitOverrideDialog({ call }, { businessId: "abc", row, clear: true, expectedRevision: 4 });
    const f = lastForm();
    f.elements.reason.value = "Back to plan";
    submit(f);
    await p;
    expect(call).toHaveBeenCalledWith("setLimitOverride", { businessId: "abc", limitKey: "storageBytes", value: null, reason: "Back to plan", expectedRevision: 4 });
  });

  it("the Usage page lists businesses with usage vs effective limits and pages with a cursor", async () => {
    const rows = [{ id: "abc", name: "ABC", workspaceTemplateId: "distributor", planId: "starter", status: "active", period: "2026-10", limits: DETAIL.limitRows.map((l) => ({ limitKey: l.limitKey, unit: l.unit, current: l.current, effective: l.effective, percent: l.percent, atOrOver: l.atOrOver })), exports: 3, recordsCreated: 300 }];
    const call = vi.fn(async () => ({ rows, next: "abc" }));
    usageView(el, ctxWith(call));
    await flush();
    expect(call).toHaveBeenCalledWith("usageOverview", { after: null });
    expect(el.querySelector('[data-business="abc"]').textContent.replace(/\s+/g, " ")).toMatch(/284 \/ 1,000 28%/);
    el.querySelector('[data-act="next"]').click();
    await flush();
    expect(call).toHaveBeenLastCalledWith("usageOverview", { after: "abc" });
  });
});
