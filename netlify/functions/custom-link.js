// POST /api/custom-link   a paid workspace's own public address (2026-10-26)
//   { action: "get" }                      settings.view: the link, its state, paid / locked
//   { action: "check", name }              settings.manage: available? (informational)
//   { action: "claim", name }              settings.manage: claim or change it, then set it up
//   { action: "retry" }                    settings.manage: finish a link still being set up
//   { action: "buy" }                      settings.manage: the plan's link add-on (Bridal's
//                                          Premium wedding link, +₱499): a bill to pay; it
//                                          unlocks only when Luna confirms the payment
// Paid only (active / past_due, not in a trial), checked again inside the
// claim transaction (./_lib/custom-links.js). The browser never sees Netlify.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { readCustomLink, checkCustomLink, claimCustomLink, finishCustomLinks, customLinkDomain, CustomLinkError } from "./_lib/custom-links.js";
import { netlifyDomainsFromEnv } from "./_lib/netlify-domains.js";
import { createAddOnBill } from "./_lib/billing.js";
import { BillingError } from "../../shared/billing.js";

const STATUS = { "not-configured": 409, "paid-only": 403, "add-on-required": 403, "invalid-link": 400, "link-taken": 409, "too-many-changes": 409, capacity: 409, "not-found": 404, "invalid-input": 400 };
const ACTIONS = { get: { permission: "settings.view", fields: [] }, check: { permission: "settings.manage", fields: ["name"] }, claim: { permission: "settings.manage", fields: ["name"], write: true }, retry: { permission: "settings.manage", fields: [], write: true }, buy: { permission: "settings.manage", fields: [], write: true } };

export function createCustomLinkHandler({ getAdmin: loadAdmin, env = process.env, domains = () => netlifyDomainsFromEnv(env), httpsReady } = {}) {
  return withErrorHandling("custom-link", async (event) => {
    requireMethod(event, "POST");
    const body = parseJsonBody(event, 2000);
    const action = body && Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
    const { db, auth, admin } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, permission: action ? action.permission : "settings.view", write: action?.write === true });
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    for (const k of Object.keys(body)) if (!["action", ...action.fields].includes(k)) throw new RequestError("invalid-request", `Unknown field ${k}.`, 400);
    if (action.fields.includes("name") && typeof body.name !== "string") throw new RequestError("invalid-request", "Type the name for your link.", 400);
    const domain = customLinkDomain(env);
    const FieldValue = admin.firestore.FieldValue;
    const finish = () => finishCustomLinks({ db, FieldValue, businessId: ctx.businessId, domain, domains: domains(), ...(httpsReady ? { httpsReady } : {}) });
    try {
      if (body.action === "check") return respond(200, { success: true, ...(await checkCustomLink({ db, businessId: ctx.businessId, input: body.name, domain })) });
      if (body.action === "claim") {
        const claimed = await claimCustomLink({ db, FieldValue, businessId: ctx.businessId, input: body.name, actor: { uid: ctx.user.uid, email: ctx.user.email ?? null }, domain });
        if (claimed.setup !== "active") await finish();
      } else if (body.action === "retry") await finish();
      else if (body.action === "buy") {
        const info = await readCustomLink({ db, businessId: ctx.businessId, domain });
        if (!info.addOn) throw new CustomLinkError("invalid-input", "Your plan already includes your own link.");
        await createAddOnBill({ db, FieldValue, businessId: ctx.businessId, addOnId: info.addOn.id, actor: { uid: ctx.user.uid, email: ctx.user.email ?? null } });
      }
      return respond(200, { success: true, customLink: await readCustomLink({ db, businessId: ctx.businessId, domain }) });
    } catch (err) {
      if (err instanceof CustomLinkError || err instanceof BillingError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createCustomLinkHandler({ getAdmin });
