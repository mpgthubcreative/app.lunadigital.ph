// Custom workspace links (2026-10-26): a PAID workspace may choose one public
// address, <label>.<domain> (e.g. carloyaniewedding.lunadigitalsystem.com),
// served by the same Luna deployment. The label only LOCATES the workspace:
// guest invitations, payment links and every private page keep their own
// token / sign-in checks.
//
// Records (server-only, rules deny all):
//   publicLinks/{label}   { businessId, workspaceTemplateId, kind, current,
//                           setup, setupError, createdAt, updatedAt }
//     kind "current": the workspace's link; "previous": an old name kept so
//     links already shared still work (they move to `current`). One global
//     namespace for every workspace type; claimed in a transaction.
//     setup: "pending" until the address is ready (Netlify alias + HTTPS),
//     then "active". A pending name stays held (retry), never released.
//   businesses/{bid}.customLink { label, setup, updatedAt, previous: [labels] }
//
// The domain is configuration (VITE_CUSTOM_LINK_DOMAIN), never hard-coded.

import { BILLABLE_STATUSES } from "./billing.js";
import { trialOpen } from "./trial.js";
import { planBilling } from "./plan-billing.js";

export const CUSTOM_LINK_MIN = 3;
export const CUSTOM_LINK_MAX = 40;
// Renames a workspace may make (each old name stays held as a redirect, and
// each name is one domain alias on the site).
export const CUSTOM_LINK_MAX_PREVIOUS = 3;
// A cancelled / deleted workspace's names stay held this long before a
// Luna operator may release them (printed invitations keep pointing here).
export const CUSTOM_LINK_HOLD_DAYS = 90;
// Netlify recommends at most 50 domain aliases on one site: warn first,
// then stop new names (the trigger to move to a wildcard domain).
export const CUSTOM_LINK_ALIAS_WARN = 40;
export const CUSTOM_LINK_ALIAS_LIMIT = 48;

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// Platform and infrastructure names nobody can claim (plus anything already
// in Luna's DNS zone: app, www, send, resend).
export const RESERVED_LINK_NAMES = Object.freeze(
  new Set(
    [
      "app", "www", "admin", "api", "console", "auth", "login", "logout", "signin", "signup", "register", "account", "accounts", "billing", "pay", "payment", "payments", "invoice", "invoices",
      "mail", "email", "smtp", "imap", "pop", "mx", "send", "resend", "ns", "ns1", "ns2", "dns", "ftp", "vpn",
      "support", "help", "status", "static", "assets", "cdn", "img", "images", "media", "files", "docs", "blog", "news",
      "dev", "test", "testing", "demo", "preview", "staging", "stage", "production", "prod", "beta", "sandbox",
      "firebase", "netlify", "google", "luna", "lunadigital", "lunadigitalsystem", "luna-business-os", "store", "shop", "rsvp", "invite", "wedding", "household", "distributor", "reseller",
      "security", "abuse", "postmaster", "hostmaster", "webmaster", "root", "superadmin", "operator", "system", "official",
    ]
  )
);

// What the owner typed -> the label to check: trimmed, lowercase, spaces
// and underscores as hyphens, an accidental ".domain" or "https://" dropped.
export function normalizeLinkInput(input, domain = "") {
  let s = typeof input === "string" ? input.trim().toLowerCase() : "";
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (domain && s.endsWith(`.${domain}`)) s = s.slice(0, -(domain.length + 1));
  return s.replace(/[\s_]+/g, "-");
}

// null when fine, else the reason in plain words.
export function linkLabelProblem(label) {
  if (typeof label !== "string" || !label) return "Type the name for your link.";
  if (label.length < CUSTOM_LINK_MIN) return `Use at least ${CUSTOM_LINK_MIN} characters.`;
  if (label.length > CUSTOM_LINK_MAX) return `Use at most ${CUSTOM_LINK_MAX} characters.`;
  if (!LABEL.test(label)) return "Use only lowercase letters, numbers and hyphens (not at the start or end).";
  // "xn--…" and other double hyphens: look-alike (punycode) names.
  if (label.includes("--")) return "Use single hyphens only.";
  if (RESERVED_LINK_NAMES.has(label)) return "That name is reserved. Try another.";
  return null;
}
export const isLinkLabel = (label) => linkLabelProblem(label) === null;

// Paid workspaces only: active or past_due, and not in a free trial (open,
// or ended without paying). The server checks this inside the claim.
export function customLinkAllowed(subscription) {
  const sub = subscription || {};
  return BILLABLE_STATUSES.includes(sub.status) && !trialOpen(sub);
}
export const CUSTOM_LINK_LOCKED_MESSAGE = "Custom workspace links are available on paid plans.";

// A plan may sell the custom link as an add-on (Bridal 2026-10-26: the
// Premium wedding link, +₱499 once): then the add-on must be PAID too.
// Plans without such an add-on include it with any paid plan.
export const linkAddOnOf = (plan) => planBilling(plan).addOns.find((a) => a.grants === "customLink") ?? null;
export const addOnPaid = (subscription, id) => Array.isArray(subscription?.addOnsPaid) && subscription.addOnsPaid.includes(id);
export function customLinkEntitled(subscription, plan) {
  if (!customLinkAllowed(subscription)) return false;
  const addOn = linkAddOnOf(plan);
  return !addOn || addOnPaid(subscription, addOn.id);
}

// How a workspace's custom address behaves by subscription status:
// "live" (active / past_due), "unavailable" (suspended: held, a neutral
// page), "retired" (cancelled / deleted: held, "no longer active").
export function customLinkState(subscription) {
  const status = subscription?.status;
  if (BILLABLE_STATUSES.includes(status)) return "live";
  if (status === "suspended") return "unavailable";
  return "retired";
}

export const customLinkHost = (label, domain) => `${label}.${domain}`;

// Which workspace label a browser hostname is ("" = the main app / not a
// custom link). Reserved names (app, www…) are never custom links.
export function linkLabelFromHost(hostname, domain) {
  const host = typeof hostname === "string" ? hostname.toLowerCase().replace(/\.$/, "") : "";
  if (!domain || !host.endsWith(`.${domain}`)) return "";
  const label = host.slice(0, -(domain.length + 1));
  return isLinkLabel(label) ? label : "";
}

// The address public links should use for this workspace: its custom link
// when that is ready, else the current page's address (unchanged links).
export function publicOrigin(session, fallback = globalThis.location?.origin || "") {
  const link = session?.publicLink;
  return link && link.setup === "active" && link.host ? `https://${link.host}` : fallback;
}

// A public page's full address for this workspace. With a ready custom
// link: /w/{slug}/invite/{t} -> https://<host>/invite/{t}, /store/{slug} ->
// https://<host> (its home), /pay/{t} -> https://<host>/pay/{t}. Without one:
// the current address plus the path, exactly as before.
export function publicUrl(session, path, fallback = globalThis.location?.origin || "") {
  const link = session?.publicLink;
  if (!(link && link.setup === "active" && link.host)) return `${fallback}${path}`;
  let p = path.replace(/^\/w\/[^/]+(?=\/(?:invite|rsvp)\/)/, "");
  if (/^\/(store|w)\/[^/]+\/?$/.test(p)) p = "";
  return `https://${link.host}${p}`;
}
