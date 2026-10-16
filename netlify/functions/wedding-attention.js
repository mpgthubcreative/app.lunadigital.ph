// GET /api/wedding-attention   (Owner-pilot Bridal UX; the bell's "Needs
// attention" in a wedding workspace): supplier payments overdue or due soon
// and overdue tasks, each with this person's read mark. Computed from the
// stored records (./_lib/wedding-attention.js); nothing is stored.

import { respond, withErrorHandling, requireMethod } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireTenant } from "./_lib/tenant.js";
import { weddingAttention } from "./_lib/wedding-attention.js";

export function createWeddingAttentionHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("wedding-attention", async (event) => {
    requireMethod(event, "GET");
    const { db, auth } = await loadAdmin();
    const ctx = await requireTenant(event, { db, auth, module: "vendors" });
    return respond(200, { success: true, summary: await weddingAttention({ tenant: ctx.tenant, business: ctx.business, permissions: ctx.permissions, uid: ctx.uid, now: now() }) });
  });
}

export const handler = createWeddingAttentionHandler({ getAdmin });
