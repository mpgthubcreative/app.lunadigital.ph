// Bridal free-trial requests (2026-10-28): the public /bridal page's
// "Request free trial" stores a request for Luna Super Admin and grants
// nothing. Fixed fields, a honeypot, a daily limit per network; Super
// Admin lists and closes them.
import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createTrialRequestHandler } from "../../netlify/functions/trial-request.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { ensureAuthUser, setOperator } from "../../netlify/functions/_lib/provisioning.js";

let world;
let opUid;
beforeEach(async () => {
  world = await buildWorld();
  const op = await ensureAuthUser({ auth: world.auth, email: "ops@luna.test", name: "Ops" });
  await setOperator({ ...world, email: op.email, status: "active", reason: "test operator" });
  opUid = op.uid;
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
const send = async (body, ip = "203.0.113.7") => parse(await createTrialRequestHandler({ getAdmin: async () => world })({ httpMethod: "POST", headers: { "x-nf-client-connection-ip": ip }, body: JSON.stringify(body) }));
const op = async (body) => parse(await createOperatorHandler({ getAdmin: async () => world })({ ...request({ uid: opUid }), httpMethod: "POST", body: JSON.stringify(body) }));
const requests = () => [...world.db.docs.entries()].filter(([k]) => /^trialRequests\/[^/]+$/.test(k)).map(([k, v]) => ({ id: k.split("/")[1], ...v }));

describe("Request free trial (public)", () => {
  it("stores the request for Luna (status new, product bridal); nothing else is created", async () => {
    const before = [...world.db.docs.keys()].filter((k) => k.startsWith("businesses/")).length;
    const r = await send({ name: "Yanie", contact: "0917 123 4567", coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14" });
    expect(r).toEqual({ status: 200, body: { success: true, received: true } });
    expect(requests()).toEqual([expect.objectContaining({ product: "bridal", name: "Yanie", contact: "0917 123 4567", coupleNames: "Carlo & Yanie", weddingDate: "2027-02-14", note: null, status: "new" })]);
    expect([...world.db.docs.keys()].filter((k) => k.startsWith("businesses/")).length).toBe(before);
  });

  it("needs a name and a way to reach them; refuses unknown fields and bad dates", async () => {
    expect((await send({ contact: "x@y.z" })).status).toBe(400);
    expect((await send({ name: "Ana" })).body.message).toMatch(/mobile number, email or Messenger/);
    expect((await send({ name: "Ana", contact: "x", status: "done" })).status).toBe(400);
    expect((await send({ name: "Ana", contact: "x", weddingDate: "soon" })).status).toBe(400);
    expect((await send({ name: "A".repeat(81), contact: "x" })).status).toBe(400);
    expect(requests()).toEqual([]);
  });

  it("a bot filling the hidden field gets a polite answer and nothing is stored", async () => {
    expect((await send({ name: "Bot", contact: "bot", website: "http://spam" })).body).toEqual({ success: true, received: true });
    expect(requests()).toEqual([]);
  });

  it("at most 5 a day from one network", async () => {
    for (let i = 0; i < 5; i += 1) expect((await send({ name: `P${i}`, contact: "x" })).status).toBe(200);
    expect((await send({ name: "P6", contact: "x" })).status).toBe(429);
    expect((await send({ name: "Other", contact: "x" }, "198.51.100.2")).status).toBe(200);
    expect(requests()).toHaveLength(6);
  });

  it("Super Admin lists the new requests and marks one done (it leaves the list)", async () => {
    await send({ name: "Ana", contact: "ana@x.test" });
    const list = (await op({ action: "trialRequests" })).body.requests;
    expect(list).toEqual([expect.objectContaining({ name: "Ana", contact: "ana@x.test", product: "bridal" })]);
    expect((await op({ action: "closeTrialRequest", requestId: list[0].id })).body).toMatchObject({ done: true });
    expect((await op({ action: "trialRequests" })).body.requests).toEqual([]);
    expect((await op({ action: "closeTrialRequest", requestId: list[0].id })).body).toMatchObject({ alreadyDone: true });
  });
});
