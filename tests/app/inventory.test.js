// @vitest-environment jsdom
// Inventory screen: cost columns only with inventory.costs, actions only
// with their permissions, inputs parsed by shared/quantity.js before the
// API call, readable history labels, pagination by cursor.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "../../src/modules/inventory/index.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const Q = (n) => n * 1000;
const flush = () => new Promise((r) => setTimeout(r, 0));
let container;

beforeEach(() => {
  document.body.innerHTML = '<main id="content"></main>';
  container = document.getElementById("content");
});

const rice = { id: "p1", sku: "RICE-25", name: "Rice 25kg", category: "Grains", unit: "sack", onHand: Q(140), reserved: Q(5), available: Q(135), reorderLevel: Q(20), sellingPrice: 125000, status: "active", isLowStock: false, movementCount: 3, nameLower: "rice 25kg" };
const flour = { id: "p2", sku: "FLOUR-1", name: "Flour", category: "", unit: "kg", onHand: 0, reserved: 0, available: 0, reorderLevel: 0, sellingPrice: 5000, status: "active", isLowStock: true, movementCount: 0, nameLower: "flour" };
const history = [
  { id: "t3", seq: 3, type: "adjustment_decrease", unit: "sack", onHandDelta: -Q(10), reservedDelta: 0, onHandBefore: Q(150), onHandAfter: Q(140), reservedBefore: 0, reservedAfter: 0, reason: "damaged", note: "Crushed", actor: { name: "Owner A" } },
  { id: "t2", seq: 2, type: "receipt", unit: "sack", onHandDelta: Q(50), reservedDelta: 0, onHandBefore: Q(100), onHandAfter: Q(150), reservedBefore: 0, reservedAfter: 0, referenceId: "DR-1001", actor: { name: "Manager A" } },
  { id: "t1", seq: 1, type: "opening", unit: "sack", onHandDelta: Q(100), reservedDelta: 0, onHandBefore: 0, onHandAfter: Q(100), reservedBefore: 0, reservedAfter: 0, note: "Count", actor: { name: "Owner A" } },
];
const costs = { p1: { avgCostUnits: 53333333 }, t2: { unitCost: 6000, avgCostBefore: 50000000, avgCostAfter: 53333333 }, t1: { unitCost: 5000, avgCostBefore: null, avgCostAfter: 50000000 }, t3: { unitCost: null, avgCostBefore: 53333333, avgCostAfter: 53333333, costConsumed: 53333 } };

function fakes({ rows = [rice, flour], hasMore = false } = {}) {
  return {
    data: {
      listProducts: vi.fn(async () => ({ rows, hasMore })),
      loadCostDocs: vi.fn(async (_b, _c, ids) => Object.fromEntries(ids.filter((id) => costs[id]).map((id) => [id, costs[id]]))),
      listHistory: vi.fn(async () => ({ rows: history, hasMore: false })),
    },
    api: vi.fn(async () => ({ success: true })),
    toast: vi.fn(),
  };
}

const session = (roleTemplate, overrides) => sessionFixture({ roleTemplate, permissions: overrides ? resolvePermissions(roleTemplate, overrides) : undefined });
async function show(s, deps = fakes()) {
  mount(container, s, deps);
  await flush();
  await flush();
  return deps;
}
const headers = () => [...container.querySelectorAll("thead th")].map((th) => th.textContent.trim());
const buttons = () => [...container.querySelectorAll("tbody button")].map((b) => b.textContent.trim());

describe("cost visibility", () => {
  it("owner sees average cost (₱53.33) and estimated value", async () => {
    const deps = await show(session("owner"));
    expect(headers()).toEqual(expect.arrayContaining(["Avg cost", "Value (est.)"]));
    expect(container.querySelector('[data-product="p1"] [data-col="avgCost"]').textContent).toBe("₱53.33");
    expect(container.querySelector('[data-product="p1"] [data-col="value"]').textContent).toBe("₱7,466.67");
    expect(deps.data.loadCostDocs).toHaveBeenCalled();
  });

  it("staff see quantities but no cost, and cost documents are never requested", async () => {
    const deps = await show(session("staff"));
    expect(headers()).not.toContain("Avg cost");
    expect(headers()).toEqual(expect.arrayContaining(["On hand", "Reserved", "Available", "Reorder at"]));
    expect(container.textContent).not.toMatch(/53\.33|7,466/);
    expect(deps.data.loadCostDocs).not.toHaveBeenCalled();
  });
});

describe("actions follow permissions", () => {
  it("staff: history only", async () => {
    await show(session("staff"));
    expect(new Set(buttons())).toEqual(new Set(["History"]));
    expect(container.querySelector('[data-act="new"]')).toBeNull();
  });

  it("owner: receive, adjust (moved product), opening (unused product), edit, deactivate", async () => {
    await show(session("owner"));
    const p1 = [...container.querySelectorAll('[data-product="p1"] button')].map((b) => b.textContent.trim());
    const p2 = [...container.querySelectorAll('[data-product="p2"] button')].map((b) => b.textContent.trim());
    expect(p1).toEqual(["History", "Receive", "Adjust", "Edit", "Deactivate"]);
    expect(p2).toEqual(["History", "Receive", "Opening", "Edit", "Deactivate"]);
  });

  it("a receiver (staff + inventory.receive) can receive but not adjust or edit", async () => {
    await show(session("staff", { grant: ["inventory.receive"] }));
    const p1 = [...container.querySelectorAll('[data-product="p1"] button')].map((b) => b.textContent.trim());
    expect(p1).toEqual(["History", "Receive"]);
  });
});

describe("forms send exact integers; the server does the maths", () => {
  const fill = (values) => {
    const form = document.querySelector(".modal-backdrop form");
    for (const [name, value] of Object.entries(values)) form.elements[name].value = value;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
  };

  it("receive 50 sacks @ ₱60 -> { quantity: 50000, unitCost: 6000 }", async () => {
    const deps = await show(session("owner"));
    container.querySelector('[data-product="p1"] [data-act="receipt"]').click();
    fill({ quantity: "50", unitCost: "60", reference: "DR-1001" });
    await flush();
    expect(deps.api).toHaveBeenCalledWith("inventory", { method: "POST", body: { action: "receipt", productId: "p1", quantity: 50000, unitCost: 6000, reference: "DR-1001" } });
  });

  it("decimals for kg; adjustment carries direction and reason", async () => {
    const deps = await show(session("owner"));
    container.querySelector('[data-product="p2"] [data-act="opening"]').click();
    fill({ quantity: "12.5", unitCost: "48.25", note: "Count sheet 1" });
    await flush();
    expect(deps.api.mock.calls[0][1].body).toMatchObject({ action: "opening", quantity: 12500, unitCost: 4825, note: "Count sheet 1" });
  });

  it("invalid input stays in the dialog with a message and calls nothing", async () => {
    const deps = await show(session("owner"));
    container.querySelector('[data-product="p1"] [data-act="receipt"]').click();
    fill({ quantity: "1.5", unitCost: "60" }); // sacks are whole units
    await flush();
    expect(deps.api).not.toHaveBeenCalled();
    expect(document.querySelector('.modal-backdrop [data-role="error"]').textContent).toMatch(/at most 0 decimal/);
    fill({ quantity: "NaN", unitCost: "60" });
    await flush();
    expect(deps.api).not.toHaveBeenCalled();
  });

  it("server errors are shown, not swallowed", async () => {
    const deps = fakes();
    deps.api = vi.fn(async () => {
      throw Object.assign(new Error("Not enough unreserved stock for this adjustment"), { status: 409 });
    });
    await show(session("owner"), deps);
    container.querySelector('[data-product="p1"] [data-act="adjust"]').click();
    fill({ direction: "adjustment_decrease", quantity: "500", reason: "lost" });
    await flush();
    expect(document.querySelector('.modal-backdrop [data-role="error"]').textContent).toMatch(/Not enough/);
  });
});

describe("history", () => {
  it("shows readable movements with actor, reason and reference; costs only for cost holders", async () => {
    await show(session("owner"));
    container.querySelector('[data-product="p1"] [data-act="history"]').click();
    await flush();
    await flush();
    const text = document.querySelector('[data-role="history"]').textContent.replace(/\s+/g, " ");
    expect(text).toMatch(/Adjustment −10 sack/);
    expect(text).toMatch(/Received \+50 sack/);
    expect(text).toMatch(/Opening balance \+100 sack/);
    expect(text).toMatch(/Damaged · Crushed/);
    expect(text).toMatch(/Ref DR-1001/);
    expect(text).toMatch(/avg ₱50\.00 → ₱53\.33/);
  });

  it("staff history has no cost lines", async () => {
    const deps = await show(session("staff"));
    container.querySelector('[data-product="p1"] [data-act="history"]').click();
    await flush();
    await flush();
    expect(document.querySelector('[data-role="history"] [data-col="cost"]')).toBeNull();
    expect(deps.data.loadCostDocs).not.toHaveBeenCalled();
  });
});

describe("pagination and filters", () => {
  it("next page uses the last row as the cursor", async () => {
    const deps = await show(session("owner"), fakes({ hasMore: true }));
    container.querySelector('[data-act="next"]').click();
    await flush();
    expect(deps.data.listProducts.mock.calls[1][1].cursor).toMatchObject({ id: "p2" });
  });

  it("filters are passed through", async () => {
    const deps = await show(session("owner"));
    const form = container.querySelector('[data-role="filters"]');
    form.elements.search.value = "rice";
    form.elements.low.value = "low";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); // real submits bubble
    await flush();
    expect(deps.data.listProducts.mock.calls.at(-1)[1]).toMatchObject({ search: "rice", lowOnly: true, status: "active", cursor: null });
  });
});
