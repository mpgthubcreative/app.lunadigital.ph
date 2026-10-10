// @vitest-environment jsdom
// Inventory screen (compact operational table): one row per product, cost
// columns only with inventory.costs, inline price / reorder / status for
// products.manage, Adjust as a signed quantity + reason (stock is never a
// raw editable number), everything else in View details. Inputs are parsed
// by shared/quantity.js; the server does the maths.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, parseAdjustment } from "../../src/modules/inventory/index.js";
import { resolvePermissions } from "../../shared/permissions.js";
import { sessionFixture } from "../helpers/session-fixture.js";

const Q = (n) => n * 1000;
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
};
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
  return deps;
}
const row = (id) => container.querySelector(`[data-product="${id}"]`);
const headers = () => [...container.querySelectorAll("thead th")].map((th) => th.textContent.trim());
// The details opener is an icon button (its accessible name says what it does).
const rowButtons = (id) => [...row(id).querySelectorAll("button")].map((b) => (b.dataset.act === "details" ? (b.getAttribute("aria-label").startsWith("View details") ? "View details" : "?") : b.textContent.trim()));
const lastForm = () => [...document.querySelectorAll(".modal-backdrop form")].at(-1);
const fill = (values) => {
  const form = lastForm();
  for (const [name, value] of Object.entries(values)) form.elements[name].value = value;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
};

describe("compact rows and cost visibility", () => {
  it("one row per product with the standard columns; owner also sees cost columns", async () => {
    const deps = await show(session("owner"));
    expect(headers()).toEqual(["", "SKU", "Product", "Category", "Unit", "On hand", "Reserved", "Available", "Avg cost", "Value (est.)", "Reorder at", "Price", "Status", "Actions", "Details"]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(row("p1").querySelector('[data-col="avgCost"]').textContent).toBe("₱53.33");
    expect(row("p1").querySelector('[data-col="value"]').textContent).toBe("₱7,466.67");
    expect(deps.data.loadCostDocs).toHaveBeenCalled();
  });

  it("staff see quantities but no cost, and cost documents are never requested", async () => {
    const deps = await show(session("staff"));
    expect(headers()).toEqual(["", "SKU", "Product", "Category", "Unit", "On hand", "Reserved", "Available", "Reorder at", "Price", "Status", "Actions", "Details"]);
    expect(container.textContent).not.toMatch(/53\.33|7,466/);
    expect(deps.data.loadCostDocs).not.toHaveBeenCalled();
  });

  it("secondary columns are marked so they collapse on narrow screens", async () => {
    await show(session("owner"));
    const secondary = [...container.querySelectorAll("thead th.col-secondary")].map((th) => th.textContent.trim());
    expect(secondary).toEqual(["Category", "Unit", "Reserved", "Avg cost", "Value (est.)", "Reorder at"]);
  });
});

describe("row actions follow permissions", () => {
  it("staff: View details only; price, reorder and status are read-only text", async () => {
    await show(session("staff"));
    expect(rowButtons("p1")).toEqual(["View details"]);
    expect(row("p1").querySelector(".cell-edit")).toBeNull();
    expect(row("p1").querySelector("select")).toBeNull();
    expect(container.querySelector('[data-act="new"]')).toBeNull();
  });

  it("owner: inline price / reorder / status, Adjust (moved) or Opening (unused), View details", async () => {
    await show(session("owner"));
    // inline reorder + price cells are buttons too, in column order
    expect(rowButtons("p1")).toEqual(["20", "₱1,250.00", "Adjust", "View details"]);
    expect(rowButtons("p2")).toEqual(["0", "₱50.00", "Opening", "View details"]);
    expect(row("p1").querySelector('[data-act="adjust"]')).not.toBeNull();
    expect(row("p2").querySelector('[data-act="opening"]')).not.toBeNull();
    expect(row("p1").querySelector('[data-act="edit-price"]').textContent).toBe("₱1,250.00");
    expect(row("p1").querySelector('[data-act="edit-reorder"]').textContent).toBe("20");
    expect(row("p1").querySelector('select[data-act="status"]').value).toBe("active");
  });

  it("there is no way to type over stock on hand", async () => {
    await show(session("owner"));
    const onHandCell = row("p1").querySelector('[data-col="onHand"]');
    expect(onHandCell.textContent).toBe("140");
    expect(onHandCell.querySelector("input, button, select")).toBeNull();
  });
});

describe("inline edits", () => {
  it("price edit sends only { sellingPrice } in centavos", async () => {
    const deps = await show(session("owner"));
    row("p1").querySelector('[data-act="edit-price"]').click();
    fill({ price: "1,300.50" });
    await flush();
    expect(deps.api).toHaveBeenCalledWith("products", { method: "POST", body: { action: "update", productId: "p1", changes: { sellingPrice: 130050 } } });
  });

  it("reorder edit follows the unit's precision", async () => {
    const deps = await show(session("owner"));
    row("p2").querySelector('[data-act="edit-reorder"]').click();
    fill({ reorder: "2.5" });
    await flush();
    expect(deps.api).toHaveBeenCalledWith("products", { method: "POST", body: { action: "update", productId: "p2", changes: { reorderLevel: 2500 } } });
    row("p1").querySelector('[data-act="edit-reorder"]').click();
    fill({ reorder: "2.5" }); // sacks are whole units
    await flush();
    expect(lastForm().querySelector('[data-role="error"]').textContent).toMatch(/at most 0 decimal/);
  });

  it("status select calls setStatus; a refusal snaps the select back", async () => {
    const deps = fakes();
    deps.api = vi.fn(async () => {
      throw new Error("A product with reserved stock can't be deactivated");
    });
    await show(session("owner"), deps);
    const select = row("p1").querySelector('select[data-act="status"]');
    select.value = "inactive";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
    expect(deps.api).toHaveBeenCalledWith("products", { method: "POST", body: { action: "setStatus", productId: "p1", status: "inactive" } });
    expect(select.value).toBe("active");
    expect(deps.toast).toHaveBeenCalledWith(expect.stringMatching(/reserved stock/), "danger");
  });
});

describe("Adjust: signed quantity + reason", () => {
  it("parses -3 / +2 / 4 into decrease / increase", () => {
    expect(parseAdjustment("-3", "sack")).toEqual({ type: "adjustment_decrease", quantity: Q(3) });
    expect(parseAdjustment("+2.5", "kg")).toEqual({ type: "adjustment_increase", quantity: 2500 });
    expect(parseAdjustment("4", "pcs")).toEqual({ type: "adjustment_increase", quantity: Q(4) });
    expect(() => parseAdjustment("0", "pcs")).toThrow();
    expect(() => parseAdjustment("-1.5", "pcs")).toThrow(/at most 0 decimal/);
    expect(() => parseAdjustment("abc", "pcs")).toThrow();
  });

  it("shows the current stock and sends a decrease with its reason", async () => {
    const deps = await show(session("owner"));
    row("p1").querySelector('[data-act="adjust"]').click();
    expect(lastForm().textContent).toMatch(/Current: 140 sack on hand/);
    fill({ change: "-3", reason: "damaged", note: "Wet" });
    await flush();
    expect(deps.api).toHaveBeenCalledWith("inventory", { method: "POST", body: { action: "adjustment_decrease", productId: "p1", quantity: Q(3), reason: "damaged", note: "Wet" } });
  });

  it("server refusals stay visible in the dialog", async () => {
    const deps = fakes();
    deps.api = vi.fn(async () => {
      throw Object.assign(new Error("Not enough unreserved stock for this adjustment"), { status: 409 });
    });
    await show(session("owner"), deps);
    row("p1").querySelector('[data-act="adjust"]').click();
    fill({ change: "-500", reason: "lost" });
    await flush();
    expect(lastForm().querySelector('[data-role="error"]').textContent).toMatch(/Not enough/);
  });
});

describe("View details", () => {
  const openDetails = async (id) => {
    row(id).querySelector('[data-act="details"]').click();
    await flush();
    return document.querySelector('[data-role="details"]');
  };

  it("full record + readable history; costs only for cost holders", async () => {
    await show(session("owner"));
    const d = await openDetails("p1");
    const text = d.textContent.replace(/\s+/g, " ");
    expect(text).toMatch(/Average cost\s*₱53\.33/);
    expect(text).toMatch(/Adjustment −10 sack/);
    expect(text).toMatch(/Received \+50 sack/);
    expect(text).toMatch(/Opening balance \+100 sack/);
    expect(text).toMatch(/Damaged · Crushed/);
    expect(text).toMatch(/Ref DR-1001/);
    expect(text).toMatch(/avg ₱50\.00 → ₱53\.33/);
  });

  it("staff details: no cost anywhere, no actions beyond Close", async () => {
    const deps = await show(session("staff"));
    const d = await openDetails("p1");
    expect(d.querySelector('[data-col="cost"]')).toBeNull();
    expect(d.textContent).not.toMatch(/Average cost/);
    expect([...d.querySelectorAll(".modal-footer button")].map((b) => b.textContent.trim())).toEqual(["Close"]);
    expect(deps.data.loadCostDocs).not.toHaveBeenCalled();
  });

  it("owner details hold the uncommon actions: receive, adjust, edit; delete only when unused", async () => {
    await show(session("owner"));
    let d = await openDetails("p1");
    expect([...d.querySelectorAll(".modal-footer button")].map((b) => b.textContent.trim())).toEqual(["Receive", "Adjust", "Edit product", "Close"]);
    document.querySelector(".modal-backdrop").remove();
    d = await openDetails("p2");
    expect([...d.querySelectorAll(".modal-footer button")].map((b) => b.textContent.trim())).toEqual(["Receive", "Opening balance", "Edit product", "Delete", "Close"]);
  });

  it("receiving from details sends integer quantity + centavos", async () => {
    const deps = await show(session("owner"));
    const d = await openDetails("p1");
    d.querySelector('[data-act="d-receipt"]').click();
    await flush();
    fill({ quantity: "50", unitCost: "60", reference: "DR-1001" });
    await flush();
    expect(deps.api).toHaveBeenCalledWith("inventory", { method: "POST", body: { action: "receipt", productId: "p1", quantity: Q(50), unitCost: 6000, reference: "DR-1001" } });
  });

  it("a receiver (staff + inventory.receive) can receive but not adjust or edit", async () => {
    await show(session("staff", { grant: ["inventory.receive"] }));
    expect(rowButtons("p1")).toEqual(["View details"]);
    const d = await openDetails("p1");
    expect([...d.querySelectorAll(".modal-footer button")].map((b) => b.textContent.trim())).toEqual(["Receive", "Close"]);
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
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await flush();
    expect(deps.data.listProducts.mock.calls.at(-1)[1]).toMatchObject({ search: "rice", lowOnly: true, status: "active", cursor: null });
  });
});
