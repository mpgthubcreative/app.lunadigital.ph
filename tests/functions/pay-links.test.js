// Order payment links (2026-10-22): the Owner's View / Copy link
// (POST /api/payments payLink), the public page's view and submit
// (POST /api/pay), and what the customer can and can't see. A submitted
// payment is always "for verification"; verification, receipts, partial
// payments, customer balances and tenant isolation follow Luna's payments.

import { describe, it, expect, beforeEach } from "vitest";
import { createOrder } from "../../netlify/functions/_lib/orders.js";
import { createProduct, recordMovement } from "../../netlify/functions/_lib/inventory.js";
import { createCustomer, updateCustomer } from "../../netlify/functions/_lib/customers.js";
import { saveStoreSettings } from "../../netlify/functions/_lib/storefront.js";
import { hashPayToken } from "../../netlify/functions/_lib/pay-links.js";
import { createPaymentsHandler } from "../../netlify/functions/payments.js";
import { createOrdersHandler } from "../../netlify/functions/orders.js";
import { createPayHandler } from "../../netlify/functions/pay.js";
import { tenantDb } from "../../netlify/functions/_lib/tenant-db.js";
import { FieldValue } from "../helpers/fake-firebase.js";
import { buildWorld, request } from "../helpers/tenants.js";
import { QTY_SCALE } from "../../shared/quantity.js";
import { payTokenFrom, validatePublicPayment, cleanInstructions } from "../../shared/pay-links.js";

const Q = (n) => n * QTY_SCALE;
const actor = { uid: "u-carlo", name: "Carlo", email: "c@t.test" };
const BIZ = { id: "biz-a", timezone: "Asia/Manila", orderPrefix: "BA", name: "Biz A" };
const NOW = new Date("2026-10-22T05:00:00Z");
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let world;
let A;
let k = 0;
beforeEach(async () => {
  world = await buildWorld();
  A = tenantDb(world.db, "biz-a");
});
const docAt = (p) => world.db.docs.get(p);
const order = (id) => docAt(`businesses/biz-a/orders/${id}`);
const paymentsOf = (orderId) => [...world.db.docs.entries()].filter(([p, d]) => p.startsWith("businesses/biz-a/payments/") && d.orderId === orderId).map(([, d]) => d);

async function orderOf(pesos = 5000, { customerId = null, name = "Walk-in" } = {}) {
  const { productId } = await createProduct({ db: world.db, tenant: A, FieldValue, actor, input: { sku: `PL-${++k}`, name: "Frozen fries", unit: "pcs", sellingPrice: pesos * 100, reorderLevel: 0 } });
  await recordMovement({ db: world.db, tenant: A, FieldValue, productId, actor, movement: { type: "opening", quantity: Q(10), unitCost: pesos * 40, note: "count" } });
  const { orderId } = await createOrder({ db: world.db, tenant: A, FieldValue, business: BIZ, entitlements: docAt("businesses/biz-a").entitlements, input: { customer: { name }, ...(customerId ? { customerId } : {}), source: "viber", deliveryAddress: "12 Mabini St", notes: "INTERNAL: give 5% next time", items: [{ productId, quantity: Q(1) }] }, idempotencyKey: `pl-key-${String(++k).padStart(10, "0")}`, actor, canDiscount: false, canLinkCustomers: true, now: NOW });
  return orderId;
}
const payments = createPaymentsHandler({ getAdmin: async () => world, now: () => NOW });
const owner = async (body, uid = world.uids.ownera, bid = "biz-a") => {
  const res = await payments({ ...request({ uid, businessId: bid, method: "POST" }), body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const pay = createPayHandler({ getAdmin: async () => world, now: () => NOW });
let ip = 0;
const pub = async (body, client = `10.0.0.${++ip}`) => {
  const res = await pay({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": client }, body: JSON.stringify(body) });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const linkFor = async (orderId) => (await owner({ action: "payLink", orderId })).body.token;
let key = 0;
const submit = (token, payment, extra = {}) => pub({ action: "submit", token, idempotencyKey: `submit-key-${String(++key).padStart(8, "0")}`, payment, ...extra });
const proof = { contentType: "image/png", dataBase64: PNG.toString("base64") };

describe("the Owner's payment link", () => {
  it("one link per order: View / Copy returns the same link; Replace link (payments.verify) stops the old one", async () => {
    const orderId = await orderOf();
    const first = await owner({ action: "payLink", orderId });
    expect(first.status).toBe(200);
    expect(first.body.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first.body.path).toBe(`/pay/${first.body.token}`);
    expect((await owner({ action: "payLink", orderId })).body.token).toBe(first.body.token);
    // The token itself is stored only inside the business; the public pointer is its hash.
    expect(docAt(`orderPayLinks/${hashPayToken(first.body.token)}`)).toMatchObject({ businessId: "biz-a", orderId });
    expect(JSON.stringify(docAt(`orderPayLinks/${hashPayToken(first.body.token)}`))).not.toContain(first.body.token);
    // Staff (payments.record, no payments.verify) can share it but not replace it.
    expect((await owner({ action: "payLink", orderId }, world.uids.staffa)).body.token).toBe(first.body.token);
    expect((await owner({ action: "payLink", orderId, rotate: true }, world.uids.staffa)).status).toBe(403);
    const next = await owner({ action: "payLink", orderId, rotate: true });
    expect(next.body.token).not.toBe(first.body.token);
    expect((await pub({ action: "view", token: first.body.token })).status).toBe(404);
    expect((await pub({ action: "view", token: next.body.token })).status).toBe(200);
    expect(docAt(`orderPayLinks/${hashPayToken(first.body.token)}`)).toBeUndefined();
  });

  it("another business can't make or read a link for this order; a deleted order's link goes", async () => {
    const orderId = await orderOf();
    expect((await owner({ action: "payLink", orderId }, world.uids.ownerb, "biz-b")).status).toBe(404);
    const token = await linkFor(orderId);
    const orders = createOrdersHandler({ getAdmin: async () => world, now: () => NOW });
    const del = await orders({ ...request({ uid: world.uids.ownera, businessId: "biz-a", method: "POST" }), body: JSON.stringify({ action: "delete", orderId, reason: "Encoded twice" }) });
    expect(del.statusCode).toBe(200);
    expect((await pub({ action: "view", token })).status).toBe(404);
    expect(docAt(`orderPayLinks/${hashPayToken(token)}`)).toBeUndefined();
  });
});

describe("the customer's payment page (no login)", () => {
  it("shows only what the customer needs: business, order no., name, total / paid / due, instructions, GCash / Maya / bank", async () => {
    const orderId = await orderOf(5000);
    await saveStoreSettings({ db: world.db, tenant: A, FieldValue, business: BIZ, input: { paymentInstructions: "GCash 0917 123 4567 (Ana R.)\nBDO 0012-3456-7890" }, actor, now: NOW });
    const r = await pub({ action: "view", token: await linkFor(orderId) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      business: { name: "Biz A" },
      order: { orderNumber: order(orderId).orderNumber, customer: "", total: 500000, paid: 0, pending: 0, due: 500000, payable: true, cancelled: false },
      instructions: "GCash 0917 123 4567 (Ana R.)\nBDO 0012-3456-7890",
      methods: [{ id: "gcash", label: "GCash" }, { id: "maya", label: "Maya" }, { id: "bank_transfer", label: "Bank transfer" }],
      payments: [],
    });
    const text = JSON.stringify(r.body);
    for (const secret of ["INTERNAL", "Mabini", "Frozen fries", "Carlo", orderId, "biz-a", "cost", "cogs"]) expect(text).not.toContain(secret);
  });

  it("bad, unknown, foreign or suspended links all get one answer", async () => {
    const orderId = await orderOf();
    const token = await linkFor(orderId);
    const answers = [];
    for (const t of ["", "short", "x".repeat(32), `${token.slice(0, -1)}A`]) answers.push(await pub({ action: "view", token: t }));
    // A forged pointer to another business's order with the same id.
    const forged = "F".repeat(32);
    world.db.docs.set(`orderPayLinks/${hashPayToken(forged)}`, { businessId: "biz-b", orderId });
    answers.push(await pub({ action: "view", token: forged }));
    answers.push(await submit(forged, { amount: 1000, method: "gcash", reference: "1234567890123" }));
    expect(answers.map((a) => [a.status, a.body.error])).toEqual(Array(6).fill([404, "link-not-found"]));
    expect(paymentsOf(orderId)).toHaveLength(0);
    // A suspended business's links stop answering.
    world.db.docs.set("businesses/biz-a", { ...docAt("businesses/biz-a"), subscription: { ...docAt("businesses/biz-a").subscription, status: "suspended" } });
    expect((await pub({ action: "view", token })).status).toBe(404);
  });
});

describe("submitting a payment", () => {
  it("screenshot only, reference only, or both; neither is refused; every submit waits for verification", async () => {
    const orderId = await orderOf(5000);
    const token = await linkFor(orderId);
    const shot = await submit(token, { amount: 100000, method: "gcash" }, { proof });
    expect(shot.status).toBe(201);
    expect(shot.body).toMatchObject({ state: "for_verification", alreadyRecorded: false });
    const ref = await submit(token, { amount: 100000, method: "maya", reference: "MY-778899" });
    expect(ref.status).toBe(201);
    const none = await submit(token, { amount: 100000, method: "bank_transfer" });
    expect([none.status, none.body.error]).toEqual([400, "reference-required"]);
    const list = paymentsOf(orderId);
    expect(list.map((p) => [p.state, p.via, p.method, p.reference, Boolean(p.proof)]).sort()).toEqual([["for_verification", "payment_link", "gcash", null, true], ["for_verification", "payment_link", "maya", "MY778899", false]]);
    expect(list[0].createdBy).toMatchObject({ uid: "payment-link" });
    expect(order(orderId)).toMatchObject({ verifiedPaid: 0, pendingPaid: 200000, balance: 300000, paymentStatus: "for_verification" });
    // Waiting for verification: shown as such, still due is what's left.
    const v = (await pub({ action: "view", token })).body;
    expect(v.order).toMatchObject({ paid: 0, pending: 200000, due: 300000 });
    expect(v.payments.map((p) => [p.method, p.state, p.receipt])).toEqual([["GCash", "for_verification", undefined], ["Maya", "for_verification", undefined]]);
    // The business is told.
    expect([...world.db.docs.keys()].some((p) => p.includes("/inbox/") && JSON.stringify(docAt(p)).includes("awaiting verification"))).toBe(true);
  });

  it("a double tap / retry with the same key records ONE payment; overpaying and other methods are refused", async () => {
    const orderId = await orderOf(5000);
    const token = await linkFor(orderId);
    const body = { action: "submit", token, idempotencyKey: "same-key-0000000001", payment: { amount: 200000, method: "gcash", reference: "1111222233334" } };
    expect((await pub(body)).status).toBe(201);
    const again = await pub(body);
    expect([again.status, again.body.alreadyRecorded]).toEqual([200, true]);
    expect(paymentsOf(orderId)).toHaveLength(1);
    const over = await submit(token, { amount: 300001, method: "gcash", reference: "9999888877776" });
    expect([over.status, over.body.error]).toEqual([409, "overpayment"]);
    expect(over.body.message).toMatch(/more than the amount due \(₱3,000\.00\)/);
    expect((await submit(token, { amount: 1000, method: "cash" })).status).toBe(400);
    expect((await submit(token, { amount: 1000, method: "gcash", reference: "1111222233334" })).body.error).toBe("duplicate-reference");
    expect((await submit(token, { amount: 1000, method: "gcash", reference: "5555666677778" }, { website: "x" })).status).toBe(400);
    expect(paymentsOf(orderId)).toHaveLength(1);
  });

  it("too many tries from one place are slowed down", async () => {
    const orderId = await orderOf(5000);
    const token = await linkFor(orderId);
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await pub({ action: "submit", token, idempotencyKey: `throttle-key-${String(i).padStart(6, "0")}`, payment: { amount: 1000, method: "gcash", reference: `77700011${i}` } }, "10.9.9.9")).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 429]);
  });
});

describe("verification, receipts, partial payments and the customer's balance", () => {
  it("₱5,000 for a saved customer: ₱2,000 verified, then ₱3,000; receipts show method + reference; the customer's outstanding balance follows", async () => {
    const { customerId } = await createCustomer({ db: world.db, tenant: A, FieldValue, input: { name: "ABC Store", phone: "0917 555 0100", address: "5 Rizal Ave" }, actor });
    const orderId = await orderOf(5000, { customerId });
    const cust = () => docAt(`businesses/biz-a/customers/${customerId}`).stats;
    expect(cust()).toMatchObject({ orderCount: 1, totalOrdered: 500000, outstandingBalance: 500000 });
    const token = await linkFor(orderId);
    await submit(token, { amount: 200000, method: "gcash", reference: "1234 567 891234" }, { proof });
    const p1 = Object.entries(Object.fromEntries(world.db.docs)).find(([p, d]) => p.startsWith("businesses/biz-a/payments/") && d.orderId === orderId)[0].split("/").pop();
    expect(docAt(`businesses/biz-a/payments/${p1}`)).toMatchObject({ customerId, state: "for_verification" });
    // Uploading never verifies; the Owner does.
    expect((await owner({ action: "verify", paymentId: p1 })).status).toBe(200);
    expect(order(orderId)).toMatchObject({ verifiedPaid: 200000, pendingPaid: 0, balance: 300000, paymentStatus: "partial" });
    expect(cust().outstandingBalance).toBe(300000);
    let v = (await pub({ action: "view", token })).body;
    expect(v.order).toMatchObject({ total: 500000, paid: 200000, pending: 0, due: 300000, payable: true });
    expect(v.payments[0].receipt).toEqual({ business: "Biz A", orderNumber: order(orderId).orderNumber, customer: "ABC Store", amount: 200000, method: "GCash", reference: "1234567891234", date: "2026-10-22", status: "Verified" });
    // Second payment on the same link: bank transfer, then verified -> paid.
    await submit(token, { amount: 300000, method: "bank_transfer", reference: "BDO-REF-445566" });
    const p2 = paymentsOf(orderId).find((p) => p.method === "bank_transfer");
    const p2id = [...world.db.docs.entries()].find(([, d]) => d === p2)[0].split("/").pop();
    await owner({ action: "verify", paymentId: p2id });
    expect(order(orderId)).toMatchObject({ verifiedPaid: 500000, balance: 0, paymentStatus: "paid" });
    expect(cust()).toMatchObject({ orderCount: 1, outstandingBalance: 0 });
    v = (await pub({ action: "view", token })).body;
    expect(v.order).toMatchObject({ paid: 500000, due: 0, payable: false });
    expect(v.payments.map((p) => [p.receipt.method, p.receipt.reference])).toEqual([["GCash", "1234567891234"], ["Bank transfer", "BDOREF445566"]]);
    const done = await submit(token, { amount: 100, method: "gcash", reference: "1212121212121" });
    expect([done.status, done.body.error]).toEqual([409, "nothing-due"]);
    // Editing the customer later never rewrites the order.
    await updateCustomer({ db: world.db, tenant: A, FieldValue, customerId, changes: { name: "ABC Store (Main)", phone: "0999 000 0000" }, actor });
    expect(order(orderId).customer).toMatchObject({ name: "ABC Store", phone: "0917 555 0100" });
    expect((await pub({ action: "view", token })).body.order.customer).toBe("ABC Store");
  });

  it("Reject / needs correction: the customer sees it wasn't accepted and why; the amount is due again; a business's own removal stays private", async () => {
    const orderId = await orderOf(5000);
    const token = await linkFor(orderId);
    await submit(token, { amount: 100000, method: "gcash", reference: "3333444455556" });
    const id = [...world.db.docs.entries()].find(([p, d]) => p.startsWith("businesses/biz-a/payments/") && d.orderId === orderId)[0].split("/").pop();
    expect((await owner({ action: "void", paymentId: id, reason: "Amount on the screenshot is ₱900, not ₱1,000" })).status).toBe(200);
    // A payment the business recorded and removed itself.
    const own = await owner({ action: "record", orderId, payment: { amount: 50000, method: "cash" } });
    await owner({ action: "void", paymentId: own.body.paymentId, reason: "Wrong order" });
    const v = (await pub({ action: "view", token })).body;
    expect(v.order).toMatchObject({ pending: 0, paid: 0, due: 500000 });
    expect(v.payments).toEqual([{ amount: 100000, method: "GCash", reference: "3333444455556", date: "2026-10-22", state: "not_accepted", reason: "Amount on the screenshot is ₱900, not ₱1,000" }]);
    // The freed reference can be sent again, corrected.
    expect((await submit(token, { amount: 90000, method: "gcash", reference: "3333444455556" })).status).toBe(201);
  });
});

describe("the order row's latest payment (2026-10-22)", () => {
  it("record → verify → reject keep order.lastPayment in step (method, reference, proof, state, who sent it)", async () => {
    const orderId = await orderOf(5000);
    const token = await linkFor(orderId);
    await submit(token, { amount: 100000, method: "gcash", reference: "4444555566667" }, { proof });
    const lp = () => order(orderId).lastPayment;
    expect(lp()).toMatchObject({ amount: 100000, method: "gcash", reference: "4444555566667", hasProof: true, state: "for_verification", via: "payment_link", day: "2026-10-22" });
    const id = lp().id;
    await owner({ action: "verify", paymentId: id });
    expect(lp()).toMatchObject({ id, state: "verified" });
    await owner({ action: "update", paymentId: id, changes: { reference: "4444555566668" } });
    expect(lp()).toMatchObject({ id, reference: "4444555566668", state: "verified" });
    const staff = await owner({ action: "record", orderId, payment: { amount: 50000, method: "cash" } });
    expect(lp()).toMatchObject({ id: staff.body.paymentId, method: "cash", reference: null, hasProof: false, state: "verified", via: null });
    await owner({ action: "void", paymentId: staff.body.paymentId, reason: "Wrong order" });
    expect(lp()).toMatchObject({ id: staff.body.paymentId, state: "voided" });
  });
});

describe("shared rules", () => {
  it("token from the path; public payment input; instructions keep their lines", () => {
    expect(payTokenFrom(`/pay/${"a".repeat(32)}`)).toBe("a".repeat(32));
    expect(payTokenFrom("/pay/short")).toBe("");
    expect(validatePublicPayment({ amount: 100, method: "gcash" }, { hasProof: true })).toEqual({ amount: 100, method: "gcash", reference: "" });
    expect(() => validatePublicPayment({ amount: 100, method: "gcash", note: "x" })).toThrow();
    expect(cleanInstructions("  GCash  0917 \r\n\r\n\r\n BDO 1 ")).toBe("GCash 0917\n\nBDO 1");
  });
});
