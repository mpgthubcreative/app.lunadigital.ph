// @vitest-environment jsdom
// Final polish (2026-10-20): proof of a payment is the screenshot OR the
// reference number. A screenshot is read for its reference (filled in,
// editable); if it can't be read, the screenshot alone is enough. And an
// order's source is optional.

import { describe, it, expect, vi } from "vitest";
import { extractReference, detectReference, bindReferenceDetection } from "../../src/lib/payment-reference.js";
import { validatePaymentInput } from "../../shared/payments.js";
import { validateOrderInput } from "../../shared/orders.js";

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("reading the reference off a screenshot", () => {
  it("GCash, Maya and bank wordings; the label's value, not dates or amounts", () => {
    expect(extractReference("GCash\nSent via GCash\nAmount ₱1,498.00\nRef No. 1012 345 678901 Oct 20, 2026 3:14 PM")).toBe("1012345678901");
    expect(extractReference("Maya\nPayment successful\nReference ID\nA1B2C3D4E5F6\nOct 20, 2026")).toBe("A1B2C3D4E5F6");
    expect(extractReference("BDO Online\nTransfer complete\nReference Number: 2026-1020-77881\nAmount: PHP 1,190.00")).toBe("2026102077881");
    expect(extractReference("Transaction ID TX99881234")).toBe("TX99881234");
    // GCash's 13-digit reference without its label.
    expect(extractReference("You have sent PHP 499.00\n1012 345 678901")).toBe("1012345678901");
    expect(extractReference("Thank you!\nAmount 499.00\nOct 20, 2026")).toBeNull();
    expect(extractReference("")).toBeNull();
  });

  it("detectReference: images only, never throws, gives up on a timeout", async () => {
    const png = new File([new Uint8Array([1])], "shot.png", { type: "image/png" });
    expect(await detectReference(png, { recognize: async () => "Ref No. 1012 345 678901" })).toBe("1012345678901");
    expect(await detectReference(png, { recognize: async () => { throw new Error("no wasm"); } })).toBeNull();
    expect(await detectReference(png, { recognize: () => new Promise(() => {}), timeoutMs: 10 })).toBeNull();
    expect(await detectReference(new File(["%PDF"], "r.pdf", { type: "application/pdf" }), { recognize: async () => "Ref No. 1012 345 678901" })).toBeNull();
  });

  it("a picked screenshot fills an EMPTY Reference field (editable); a typed one is never replaced", async () => {
    document.body.innerHTML = `<form><input type="file" name="proof" /><div class="field"><input name="reference" /><div class="stat-hint"></div></div></form>`;
    const form = document.querySelector("form");
    const detect = vi.fn(async () => "1012345678901");
    bindReferenceDetection(form, { detect });
    bindReferenceDetection(form, { detect }); // binds once
    const pick = () => {
      Object.defineProperty(form.elements.proof, "files", { value: [new File([new Uint8Array([1])], "s.png", { type: "image/png" })], configurable: true });
      form.elements.proof.dispatchEvent(new Event("change"));
    };
    pick();
    await flush();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(form.elements.reference.value).toBe("1012345678901");
    expect(form.querySelector(".stat-hint").textContent).toMatch(/check it/);
    form.elements.reference.value = "MY-OWN-REF";
    pick();
    await flush();
    expect(form.elements.reference.value).toBe("MY-OWN-REF");
  });

  it("nothing readable: the hint says the screenshot alone is enough", async () => {
    document.body.innerHTML = `<form><input type="file" name="proof" /><div class="field"><input name="reference" /><div class="stat-hint"></div></div></form>`;
    const form = document.querySelector("form");
    bindReferenceDetection(form, { detect: async () => null });
    Object.defineProperty(form.elements.proof, "files", { value: [new File([new Uint8Array([1])], "s.png", { type: "image/png" })] });
    form.elements.proof.dispatchEvent(new Event("change"));
    await flush();
    expect(form.elements.reference.value).toBe("");
    expect(form.querySelector(".stat-hint").textContent).toMatch(/screenshot alone is enough/);
  });
});

describe("order payments: the reference OR a screenshot", () => {
  it("GCash with only a screenshot, only a reference, or neither", () => {
    expect(validatePaymentInput({ amount: 49900, method: "gcash" }, { hasProof: true })).toMatchObject({ method: "gcash", reference: "" });
    expect(validatePaymentInput({ amount: 49900, method: "gcash", reference: "1012 345 678901" })).toMatchObject({ reference: "1012345678901" });
    expect(() => validatePaymentInput({ amount: 49900, method: "gcash" })).toThrow(/reference number or a screenshot/);
    expect(validatePaymentInput({ amount: 49900, method: "cash" })).toMatchObject({ method: "cash" });
  });
});

describe("order source is optional", () => {
  const item = { productId: "prodABCDEFGH12345678", quantity: 1000 };
  it("blank / missing source → null; a chosen source still validates", () => {
    expect(validateOrderInput({ customer: { name: "Yanie" }, items: [item] }).source).toBeNull();
    expect(validateOrderInput({ customer: { name: "Yanie" }, source: "", items: [item] })).toMatchObject({ source: null, sourceNote: null });
    expect(validateOrderInput({ customer: { name: "Yanie" }, source: "viber", items: [item] }).source).toBe("viber");
    expect(() => validateOrderInput({ customer: { name: "Yanie" }, source: "pigeon", items: [item] })).toThrow(/Source must be one of/);
  });
});

describe("extractPayment (2026-10-26): amount, reference, method, date", () => {
  it("GCash, Maya and bank confirmations; fees and balances are never the amount; nothing readable → null", async () => {
    const { extractPayment } = await import("../../src/lib/payment-reference.js");
    expect(extractPayment("GCash\nSent via GCash\nAmount\n145.00\nTotal Amount Sent\n₱145.00\nRef No. 1012 345 678901\nOct 26, 2026 3:45 PM")).toEqual({ amount: 14500, reference: "1012345678901", method: "gcash", date: "2026-10-26" });
    expect(extractPayment("Maya\nYou sent P5.00\nReference ID 4F2A99K12B\n10/26/2026")).toEqual({ amount: 500, reference: "4F2A99K12B", method: "maya", date: "2026-10-26" });
    expect(extractPayment("BDO Fund Transfer\nTransfer fee PHP 25.00\nAmount: PHP 1,250.50\nAvailable balance PHP 9,999.00\nReference Number: 99887766")).toEqual({ amount: 125050, reference: "99887766", method: "bank_transfer", date: null });
    expect(extractPayment("a photo of a cat")).toBeNull();
  });
});
