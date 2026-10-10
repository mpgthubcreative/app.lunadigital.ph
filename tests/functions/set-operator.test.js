// scripts/set-operator.js (bootstrapOperator): --create-account and
// --send-password-email. The first Super Admin is bootstrapped from the CLI:
// a passwordless account with no business, an operator record, one audit
// record, and Firebase's own password-setup email.

import { describe, it, expect, beforeEach } from "vitest";
import { bootstrapOperator, sendPasswordSetupEmail, ProvisioningError } from "../../netlify/functions/_lib/provisioning.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { buildWorld, request } from "../helpers/tenants.js";

let world;
let sent;
const fakeFetch =
  (status = 200, body = {}) =>
  async (url, init) => {
    sent.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status < 300, status, json: async () => body };
  };
beforeEach(async () => {
  world = await buildWorld();
  sent = [];
});
const audits = () => [...world.db.docs.entries()].filter(([p]) => p.startsWith("platformAudit/")).map(([, d]) => d);
const memberships = (uid) => [...world.db.docs.keys()].filter((p) => p.includes("/members/") && p.endsWith(`/${uid}`));
const run = (opts) => bootstrapOperator({ ...world, reason: "Bootstrap first Super Admin", apiKey: "web-key", siteUrl: "https://luna.example/", fetchImpl: fakeFetch(), ...opts });

describe("set-operator --create-account", () => {
  it("creates a passwordless account with no business, a superadmin operator, and exactly one audit", async () => {
    const r = await run({ email: " Admin@Luna.Test ", createAccount: true });
    expect(r.account).toMatchObject({ email: "admin@luna.test", created: true });
    const user = await world.auth.getUserByEmail("admin@luna.test");
    expect(user.hasPassword).toBe(false);
    expect(memberships(user.uid)).toEqual([]);
    expect(world.db.docs.get(`operators/${user.uid}`)).toMatchObject({ email: "admin@luna.test", role: "superadmin", status: "active" });
    const a = audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ type: "operator.updated", operator: { uid: user.uid, email: "admin@luna.test" }, actor: "cli", reason: "Bootstrap first Super Admin", before: null, after: { role: "superadmin", status: "active" } });
    expect(sent).toEqual([]);
  });

  it("reuses an existing account (an Owner stays an Owner; password untouched)", async () => {
    const r = await run({ email: "ownera@t.test", createAccount: true });
    expect(r.account).toMatchObject({ uid: world.uids.ownera, created: false });
    expect(r.operator.uid).toBe(world.uids.ownera);
  });

  it("without --create-account a missing account is refused and nothing is written", async () => {
    await expect(run({ email: "ghost@luna.test" })).rejects.toMatchObject({ code: "not-found" });
    expect(audits()).toEqual([]);
    expect([...world.db.docs.keys()].some((p) => p.startsWith("operators/"))).toBe(false);
  });

  it("a re-run that changes nothing writes nothing and is not audited again; a real change is", async () => {
    await run({ email: "admin@luna.test", createAccount: true });
    const r = await run({ email: "admin@luna.test", createAccount: true, sendPasswordEmail: true });
    expect(r.operator.changed).toBe(false);
    expect(audits()).toHaveLength(1);
    await run({ email: "admin@luna.test", status: "disabled", reason: "Left Luna" });
    expect(audits()).toHaveLength(2);
    expect(audits()[1]).toMatchObject({ before: { status: "active" }, after: { status: "disabled" } });
  });

  it("the bootstrapped operator can use the console; owning a business alone cannot", async () => {
    await run({ email: "admin@luna.test", createAccount: true });
    const uid = (await world.auth.getUserByEmail("admin@luna.test")).uid;
    const call = (u) => createOperatorHandler({ getAdmin: async () => world })({ ...request({ uid: u }), httpMethod: "POST", body: JSON.stringify({ action: "session" }) });
    expect((await call(uid)).statusCode).toBe(200);
    expect((await call(world.uids.ownera)).statusCode).toBe(403);
  });
});

describe("set-operator --send-password-email", () => {
  it("asks Firebase Auth for its PASSWORD_RESET email with a /console/ continue URL", async () => {
    const r = await run({ email: "Admin@Luna.Test", createAccount: true, sendPasswordEmail: true });
    expect(r.passwordEmailSent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=web-key");
    expect(sent[0].init.method).toBe("POST");
    expect(sent[0].body).toEqual({ requestType: "PASSWORD_RESET", email: "admin@luna.test", continueUrl: "https://luna.example/console/" });
  });

  it("no SITE_URL: no continue URL; no API key or a Firebase error is reported, not swallowed", async () => {
    await sendPasswordSetupEmail({ email: "a@luna.test", apiKey: "k", fetchImpl: fakeFetch() });
    expect(sent[0].body).toEqual({ requestType: "PASSWORD_RESET", email: "a@luna.test" });
    await expect(sendPasswordSetupEmail({ email: "a@luna.test", apiKey: "", fetchImpl: fakeFetch() })).rejects.toBeInstanceOf(ProvisioningError);
    await expect(sendPasswordSetupEmail({ email: "a@luna.test", apiKey: "k", fetchImpl: fakeFetch(400, { error: { message: "EMAIL_NOT_FOUND" } }) })).rejects.toMatchObject({ code: "email-failed", message: expect.stringContaining("EMAIL_NOT_FOUND") });
  });

  it("the operator record is written before the email, so a failed email can simply be re-sent", async () => {
    await expect(run({ email: "admin@luna.test", createAccount: true, sendPasswordEmail: true, fetchImpl: fakeFetch(500) })).rejects.toMatchObject({ code: "email-failed" });
    expect(audits()).toHaveLength(1);
    await run({ email: "admin@luna.test", sendPasswordEmail: true });
    expect(audits()).toHaveLength(1);
    expect(sent).toHaveLength(2);
  });
});
