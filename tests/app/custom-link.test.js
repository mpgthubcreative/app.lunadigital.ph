// @vitest-environment jsdom
// Custom workspace links (2026-10-26) in the browser: the settings section
// (trial locked, Bridal's +₱499 add-on, claim, ready, staff) and a custom
// address's page (only public pages; tokens carry the address; everything
// else goes to the main app; unknown names: "Workspace not found").
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountCustomLink } from "../../src/components/custom-link.js";
import { mountPublicHost, hostFetch } from "../../src/app/public-host.js";

const D = "lunadigitalsystem.com";
const flush = () => new Promise((r) => setTimeout(r, 0));
const session = (perm = true, templateId = "household-payroll") => ({ member: { permissions: { "settings.manage": perm } }, workspace: { templateId } });
const info = (over = {}) => ({ available: true, domain: D, allowed: true, paidPlan: true, addOn: null, lockedMessage: "Custom workspace links are available on paid plans.", state: "live", link: null, changesLeft: 3, ...over });
let host;
beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
});
const text = () => host.textContent.replace(/\s+/g, " ").trim();

describe("settings section", () => {
  it("trial: shown locked with the plain message; no name field; Upgrade for the owner", async () => {
    const api = vi.fn(async () => ({ customLink: info({ allowed: false, paidPlan: false }) }));
    mountCustomLink(host, session(), { api });
    await flush();
    expect(text()).toMatch(/Your household link.*yourname\.lunadigitalsystem\.com.*available on paid plans.*Upgrade to choose your link/);
    expect(host.querySelector('[data-role="cl-name"]')).toBeNull();
  });
  it("paid Bridal without the add-on: offers the Premium wedding link (+₱499); buying shows Pay now", async () => {
    const addOn = { id: "premium-link", label: "Premium wedding link", price: 49900, status: "none" };
    const api = vi.fn(async (_n, { body }) => ({ customLink: info({ allowed: false, addOn: body.action === "buy" ? { ...addOn, status: "billed", invoiceId: "x" } : addOn, lockedMessage: "Get the Premium wedding link (+₱499) to choose your own address." }) }));
    mountCustomLink(host, session(true, "bridal-expense"), { api, toast: vi.fn() });
    await flush();
    expect(text()).toMatch(/Premium wedding link.*Premium wedding link · \+₱499 once.*Get Premium wedding link \(\+₱499\)/);
    host.querySelector('[data-act="cl-buy"]').click();
    await flush();
    expect(api).toHaveBeenLastCalledWith("custom-link", { method: "POST", body: { action: "buy" } });
    expect(host.querySelector('[data-role="cl-pay"]').getAttribute("href")).toBe("/subscription");
  });
  it("payment sent: waiting for Luna; nothing to type yet", async () => {
    const api = vi.fn(async () => ({ customLink: info({ allowed: false, addOn: { id: "premium-link", label: "Premium wedding link", price: 49900, status: "waiting" } }) }));
    mountCustomLink(host, session(true, "bridal-expense"), { api });
    await flush();
    expect(text()).toMatch(/Payment sent\. Luna will confirm it/);
    expect(host.querySelector('[data-role="cl-name"]')).toBeNull();
  });
  it("paid: [ name ] .domain, Check shows ✓ Available, Save claims the normalized name", async () => {
    const api = vi.fn(async (_n, { body }) => {
      if (body.action === "check") return { label: body.name, available: true };
      if (body.action === "claim") return { customLink: info({ link: { label: body.name, host: `${body.name}.${D}`, setup: "pending", note: "Getting your link ready.", previous: [] } }) };
      return { customLink: info() };
    });
    const toast = vi.fn();
    mountCustomLink(host, session(), { api, toast });
    await flush();
    expect(host.querySelector(".cl-domain").textContent).toBe(`.${D}`);
    host.querySelector('[data-role="cl-name"]').value = "Prado Household";
    host.querySelector('[data-act="cl-check"]').click();
    await flush();
    expect(api).toHaveBeenCalledWith("custom-link", { method: "POST", body: { action: "check", name: "prado-household" } });
    expect(host.querySelector('[data-role="cl-check"]').textContent).toBe("✓ Available");
    host.querySelector('[data-role="cl-form"]').dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    expect(api).toHaveBeenCalledWith("custom-link", { method: "POST", body: { action: "claim", name: "prado-household" } });
    expect(text()).toMatch(/prado-household\.lunadigitalsystem\.com.*Getting your link ready.*Check again/);
  });
  it("a reserved or invalid name is explained without asking the server", async () => {
    const api = vi.fn(async () => ({ customLink: info() }));
    mountCustomLink(host, session(), { api });
    await flush();
    host.querySelector('[data-role="cl-name"]').value = "admin";
    host.querySelector('[data-act="cl-check"]').click();
    await flush();
    expect(host.querySelector('[data-role="cl-check"]').textContent).toMatch(/reserved/);
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("ready: Copy link copies the https address; Edit warns that shared links keep working; staff can't edit", async () => {
    const ready = info({ link: { label: "pradohousehold", host: `pradohousehold.${D}`, setup: "active", previous: [] } });
    const copy = vi.fn(async () => true);
    mountCustomLink(host, session(), { api: vi.fn(async () => ({ customLink: ready })), copy });
    await flush();
    host.querySelector('[data-act="cl-copy"]').click();
    await flush();
    expect(copy).toHaveBeenCalledWith(`https://pradohousehold.${D}`);
    host.querySelector('[data-act="cl-edit"]').click();
    expect(host.querySelector('[data-role="cl-warning"]').textContent).toMatch(/Links you already shared keep working/);
    const other = document.createElement("div");
    mountCustomLink(other, session(false), { api: vi.fn(async () => ({ customLink: ready })) });
    await flush();
    expect(other.querySelector('[data-act="cl-edit"]')).toBeNull();
    expect(other.querySelector('[data-act="cl-copy"]')).not.toBeNull();
  });
  it("feature off (no domain configured): nothing shown", async () => {
    mountCustomLink(host, session(), { api: vi.fn(async () => ({ customLink: info({ available: false }) })) });
    await flush();
    expect(host.innerHTML).toBe("");
  });
});

describe("a custom address's page", () => {
  const T = "A".repeat(32);
  const loc = (pathname) => ({ pathname, search: "", hash: "", replace: vi.fn() });
  const fetchFor = (h) => vi.fn(async (url) => new Response(JSON.stringify(url === "/api/host" ? { success: true, host: h } : {}), { status: 200 }));
  it("unknown name: 'Workspace not found' (no other tenant)", async () => {
    await mountPublicHost(host, { label: "nobody", location: loc("/"), fetchImpl: fetchFor({ status: "not-found" }) });
    expect(text()).toMatch(/Workspace not found/);
  });
  it("an old name moves to the current one, keeping the path and the private token", async () => {
    const l = loc(`/rsvp/${T}`);
    await mountPublicHost(host, { label: "carloandyanie", location: l, fetchImpl: fetchFor({ status: "moved", host: `carloyaniewedding.${D}` }) });
    expect(l.replace).toHaveBeenCalledWith(`https://carloyaniewedding.${D}/rsvp/${T}`);
  });
  it("suspended / cancelled: neutral pages, nothing about the workspace", async () => {
    await mountPublicHost(host, { label: "x-a", location: loc("/"), fetchImpl: fetchFor({ status: "unavailable" }) });
    expect(text()).toMatch(/temporarily unavailable/);
    await mountPublicHost(host, { label: "x-a", location: loc("/"), fetchImpl: fetchFor({ status: "retired" }) });
    expect(text()).toMatch(/no longer active/);
  });
  it("Bridal: / is the 'invitations are personal' page; /rsvp/{token} the invitation, asked for with this address", async () => {
    const renderInvitePage = vi.fn();
    const live = { status: "live", workspace: "bridal-expense", name: "Carlo & Yanie", appOrigin: "https://app.lunadigitalsystem.com" };
    await mountPublicHost(host, { label: "carloyaniewedding", location: loc("/"), fetchImpl: fetchFor(live), load: async () => ({ renderInvitePage }) });
    expect(renderInvitePage.mock.calls[0][1].token).toBe("");
    await mountPublicHost(host, { label: "carloyaniewedding", location: loc(`/rsvp/${T}`), fetchImpl: fetchFor(live), load: async () => ({ renderInvitePage }) });
    expect(renderInvitePage.mock.calls[1][1].token).toBe(T);
  });
  it("the token pages' requests carry the address; the invitation stays on this address's short path", async () => {
    const base = vi.fn(async (url, opts) => new Response(JSON.stringify({ success: true, invitation: { path: `/w/carlo-yanie/invite/${T}`, echo: JSON.parse(opts.body) } }), { status: 200 }));
    const f = hostFetch("carloyaniewedding", base);
    const data = await (await f("/api/invite", { method: "POST", body: JSON.stringify({ action: "view", token: T }) })).json();
    expect(data.invitation.echo).toEqual({ action: "view", token: T, host: "carloyaniewedding" });
    expect(data.invitation.path).toBe(`/rsvp/${T}`);
    await f("/api/store", { method: "POST", body: JSON.stringify({ action: "view", slug: "abc" }) });
    expect(JSON.parse(base.mock.calls[1][1].body)).toEqual({ action: "view", slug: "abc" }); // the store has no token: unchanged
  });
  it("Household: / sends people to sign in on the main app; any signed-in page goes to the main app (same path)", async () => {
    const live = { status: "live", workspace: "household-payroll", name: "Prado Household", appOrigin: "https://app.lunadigitalsystem.com" };
    await mountPublicHost(host, { label: "pradohousehold", location: loc("/"), fetchImpl: fetchFor(live) });
    expect(host.querySelector('[data-role="signin"]').getAttribute("href")).toBe("https://app.lunadigitalsystem.com");
    const l = loc("/payroll");
    await mountPublicHost(host, { label: "pradohousehold", location: l, fetchImpl: fetchFor(live) });
    expect(l.replace).toHaveBeenCalledWith("https://app.lunadigitalsystem.com/payroll");
  });
  it("Distributor: / is the store; /orders (internal) goes to the main app's sign-in", async () => {
    const renderStorePage = vi.fn();
    const live = { status: "live", workspace: "distributor", name: "ABC Frozen", storeSlug: "abc-frozen", appOrigin: "https://app.lunadigitalsystem.com" };
    await mountPublicHost(host, { label: "abcfrozenfoods", location: loc("/"), fetchImpl: fetchFor(live), load: async () => ({ renderStorePage }) });
    expect(renderStorePage.mock.calls[0][1].slug).toBe("abc-frozen");
    const l = loc("/orders");
    await mountPublicHost(host, { label: "abcfrozenfoods", location: l, fetchImpl: fetchFor(live) });
    expect(l.replace).toHaveBeenCalledWith("https://app.lunadigitalsystem.com/orders");
  });
});
