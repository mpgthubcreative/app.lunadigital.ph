// A workspace's own address (custom workspace link, 2026-10-26), e.g.
// carloyaniewedding.lunadigitalsystem.com. Same deployment as the main app,
// but it only ever shows PUBLIC pages:
//   Bridal       /  the wedding's "invitations are personal" page;
//                /invite/{token} (or /rsvp/{token}) a guest's invitation
//   Distributor  /  the store;  /pay/{token} an order's payment link
//   Household    /  a page that sends people to sign in on the main app
// Anything else (signed-in pages) goes to the main app, same path. The
// address only locates the workspace: every token is checked by the server,
// which also refuses a token from another workspace on this address
// (`host` in the request). Nobody signs in here.

import { html, render } from "../lib/html.js";
import { lunaMark } from "../components/icons.js";

async function lookUp(label, fetchImpl) {
  const res = await fetchImpl("/api/host", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ name: label }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "Something went wrong.");
  return data.host;
}

// The public pages' requests carry this address; an invitation keeps this
// address's short path (/rsvp/{token}) instead of the main app's.
export function hostFetch(label, fetchImpl) {
  return async (url, opts = {}) => {
    const tokenPage = ["/api/invite", "/api/pay"].includes(String(url));
    const body = tokenPage && typeof opts.body === "string" ? JSON.stringify({ ...JSON.parse(opts.body), host: label }) : opts.body;
    const res = await fetchImpl(url, { ...opts, body });
    if (String(url) !== "/api/invite") return res;
    const data = await res.clone().json().catch(() => null);
    if (!data?.invitation?.path) return res;
    const token = /\/(?:invite|rsvp)\/([A-Za-z0-9_-]{32})$/.exec(data.invitation.path)?.[1];
    if (token) data.invitation.path = `/rsvp/${token}`;
    return new Response(JSON.stringify(data), { status: res.status, headers: { "Content-Type": "application/json" } });
  };
}

const page = (root, title, message, extra = "") =>
  render(
    root,
    html`<main class="receipt-page" data-role="public-host"><div class="card receipt-card"><div class="brand">${lunaMark()}<span class="brand-text">Luna</span></div><h1 class="card-title">${title}</h1><p data-role="message">${message}</p>${extra}</div></main>`
  );

const TOKEN_PATH = /^\/(?:invite|rsvp)\/([A-Za-z0-9_-]{32})\/?$/;

const PAGES = { invite: () => import("./invite.js"), pay: () => import("./pay.js"), store: () => import("./store.js") };

export async function mountPublicHost(root, { label, location = window.location, fetchImpl = (...a) => window.fetch(...a), load = (m) => PAGES[m]() } = {}) {
  render(root, html`<main class="receipt-page"><div class="card receipt-card"><p>Loading…</p></div></main>`);
  let r;
  try {
    r = await lookUp(label, fetchImpl);
  } catch {
    return page(root, "Something went wrong", "Please refresh the page.");
  }
  const path = location.pathname;
  if (r.status === "moved") return location.replace(`https://${r.host}${path}${location.search}${location.hash}`);
  if (r.status === "not-found") {
    document.title = "Workspace not found";
    return page(root, "Workspace not found", "This address isn't a Luna workspace. Check the link you were sent.");
  }
  if (r.status === "unavailable") return page(root, "Temporarily unavailable", "This page is temporarily unavailable. Please try again later.");
  if (r.status !== "live") return page(root, "Link no longer active", "This link is no longer active.");
  const fetchHere = hostFetch(label, fetchImpl);
  const token = TOKEN_PATH.exec(path)?.[1] || /^\/w\/[a-z0-9-]{1,60}\/(?:invite|rsvp)\/([A-Za-z0-9_-]{32})\/?$/.exec(path)?.[1];
  if (r.workspace === "bridal-expense" && (token || path === "/" || path === "")) {
    // Without a token: the "invitations are personal" page (nothing about the wedding).
    if (token && TOKEN_PATH.exec(path) === null) window.history.replaceState(null, "", `/rsvp/${token}`);
    return (await load("invite")).renderInvitePage(root, { token: token || "", fetchImpl: fetchHere });
  }
  if ((r.workspace === "distributor" || r.workspace === "reseller") && path.startsWith("/pay/")) return (await load("pay")).renderPayPage(root, { fetchImpl: fetchHere });
  if ((r.workspace === "distributor" || r.workspace === "reseller") && (path === "/" || path === "")) {
    if (!r.storeSlug) return page(root, r.name, "This store isn't taking orders online yet.");
    return (await load("store")).renderStorePage(root, { slug: r.storeSlug, fetchImpl: fetchHere });
  }
  if (path === "/" || path === "") {
    document.title = r.name || "Luna";
    return page(root, r.name || "Luna", "Sign in to Luna to open this workspace.", html`<a class="btn btn-primary btn-block" href="${r.appOrigin || "/"}" data-role="signin">Sign in to Luna</a>`);
  }
  // A signed-in page (or anything else): the main app, same path.
  if (r.appOrigin) return location.replace(`${r.appOrigin}${path}${location.search}${location.hash}`);
  return page(root, "Workspace not found", "This address isn't a Luna workspace. Check the link you were sent.");
}
