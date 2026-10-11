// Phase 18.6: the single "Where did the order come from?" box keeps the
// structured source id that filters and reports group by.
import { describe, it, expect } from "vitest";
import { parseSourceText, sourceText, validateOrderInput, ORDER_SOURCE_IDS } from "../../shared/orders.js";

describe("parseSourceText", () => {
  it.each([
    ["Viber", { source: "viber", sourceNote: "" }],
    ["  walk-in ", { source: "walk_in", sourceNote: "" }],
    ["Walk in", { source: "walk_in", sourceNote: "" }],
    ["Facebook Messenger", { source: "messenger", sourceNote: "" }],
    ["Phone call", { source: "phone", sourceNote: "" }],
    ["viber - returning customer", { source: "viber", sourceNote: "returning customer" }],
    ["Messenger · referred by Ana", { source: "messenger", sourceNote: "referred by Ana" }],
    ["Facebook (page ad)", { source: "facebook", sourceNote: "page ad" }],
    ["Returning customer", { source: "other", sourceNote: "Returning customer" }],
    ["Lazada", { source: "other", sourceNote: "Lazada" }],
    ["", { source: "other", sourceNote: "" }],
  ])("%j", (text, expected) => expect(parseSourceText(text)).toEqual(expected));

  it("round-trips every source with and without a note", () => {
    for (const id of ORDER_SOURCE_IDS) {
      if (id === "other") continue;
      expect(parseSourceText(sourceText(id, ""))).toEqual({ source: id, sourceNote: "" });
      expect(parseSourceText(sourceText(id, "returning customer"))).toEqual({ source: id, sourceNote: "returning customer" });
    }
    expect(parseSourceText(sourceText("other", "Lazada"))).toEqual({ source: "other", sourceNote: "Lazada" });
  });

  it("an empty box is refused by order validation (not silently saved)", () => {
    const order = { customer: { name: "Ana" }, items: [{ productId: "abcdefgh12", quantity: 1000 }], ...parseSourceText("") };
    expect(() => validateOrderInput(order)).toThrow(/where the order came from/i);
  });
});

describe("delivery address (Phase 18.6)", () => {
  const order = (extra) => ({ customer: { name: "Ana" }, source: "messenger", items: [{ productId: "prodAAAAAAAA", quantity: 1000 }], ...extra });
  it("is optional, trimmed, and capped at 300 characters", async () => {
    const { validateOrderInput } = await import("../../shared/orders.js");
    expect(validateOrderInput(order()).deliveryAddress).toBe("");
    expect(validateOrderInput(order({ deliveryAddress: "  12 Mabini St, QC  " })).deliveryAddress).toBe("12 Mabini St, QC");
    expect(() => validateOrderInput(order({ deliveryAddress: "x".repeat(301) }))).toThrow(/Delivery address/);
  });
});

describe("one line per product (server)", () => {
  it("the same product twice is refused: combine the quantities", async () => {
    const { validateOrderInput } = await import("../../shared/orders.js");
    const line = { productId: "prodAAAAAAAA", quantity: 1000 };
    expect(() => validateOrderInput({ customer: { name: "Ana" }, source: "viber", items: [line, { ...line, quantity: 2000 }] })).toThrow(/combine the quantities/);
    expect(validateOrderInput({ customer: { name: "Ana" }, source: "viber", items: [line] }).items).toHaveLength(1);
  });
});
