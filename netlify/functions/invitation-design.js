// POST /api/invitation-design   (Luna Super Admin only: Bridal+ invitation designs)
//   { action: "get", businessId }                        the design workspace (draft, published, assets, content)
//   { action: "saveDraft", businessId, config }          validated design config (no raw HTML / CSS)
//   { action: "setState", businessId, state }            "draft" | "ready"
//   { action: "publish", businessId }                    draft → live custom design (Luna Bridal+ only)
//   { action: "useStandard", businessId }                guests see the Standard invitation (design kept)
//   { action: "useCustom", businessId }                  the published custom design live again
//   { action: "restore", businessId, version }           a published version back into the draft
//   { action: "uploadAsset", businessId, name, dataUrl } a designer image (PNG / JPG / WebP / SVG)
//   { action: "deleteAsset", businessId, assetId }       refused while a design uses it
//   { action: "preview", businessId, which }             "draft" | "live" with its images
//   { action: "sample", businessId, which }              the whole invitation for a SAMPLE guest
//                                                        (no real guest / token), draft or published
// The browser sends intent; every write is checked against an active
// operator record first (a business Owner gets 403). See ./_lib/invitation-design.js.

import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { requireOperator } from "./_lib/operator.js";
import { tenantDb } from "./_lib/tenant-db.js";
import { isValidBusinessId } from "../../shared/tenancy.js";
import { designWorkspace, saveDraft, setDraftState, publishDesign, useStandard, useCustom, restoreVersion, uploadAsset, deleteAsset, previewDesign, sampleInvitation, InvitationDesignError } from "./_lib/invitation-design.js";

const STATUS = { "invalid-design": 400, "invalid-input": 400, "invalid-asset": 400, "not-found": 404, "not-available": 400, "not-entitled": 409, "asset-in-use": 409 };
const ACTIONS = {
  get: { fields: ["businessId"], run: (c) => designWorkspace(c) },
  saveDraft: { fields: ["businessId", "config"], run: (c, b) => saveDraft({ ...c, config: b.config }) },
  setState: { fields: ["businessId", "state"], run: (c, b) => setDraftState({ ...c, state: b.state }) },
  publish: { fields: ["businessId"], run: (c) => publishDesign(c) },
  useStandard: { fields: ["businessId"], run: (c) => useStandard(c) },
  useCustom: { fields: ["businessId"], run: (c) => useCustom(c) },
  restore: { fields: ["businessId", "version"], run: (c, b) => restoreVersion({ ...c, version: b.version }) },
  uploadAsset: { fields: ["businessId", "name", "dataUrl"], run: (c, b) => uploadAsset({ ...c, name: b.name, dataUrl: b.dataUrl }) },
  deleteAsset: { fields: ["businessId", "assetId"], run: (c, b) => deleteAsset({ ...c, assetId: b.assetId }) },
  preview: {
    fields: ["businessId", "which"],
    run: async (c, b) => {
      const business = (await c.tenant.ref.get()).data();
      return previewDesign({ ...c, business, which: b.which === "draft" ? "draft" : "live" });
    },
  },
  sample: {
    fields: ["businessId", "which"],
    run: async (c, b) => {
      const snap = await c.tenant.ref.get();
      if (!snap.exists || snap.data().workspaceTemplateId !== "bridal-expense") throw new InvitationDesignError("not-available", "Invitations are for wedding (Bridal) workspaces");
      return sampleInvitation({ ...c, business: snap.data(), which: b.which === "live" ? "live" : "draft" });
    },
  },
};

export function createInvitationDesignHandler({ getAdmin: loadAdmin, now = () => new Date() }) {
  return withErrorHandling("invitation-design", async (event) => {
    requireMethod(event, "POST");
    let body = null;
    let bodyError = null;
    try {
      body = parseJsonBody(event, 1_000_000);
    } catch (err) {
      bodyError = err;
    }
    const { db, auth, admin } = await loadAdmin();
    const op = await requireOperator(event, { db, auth });
    if (bodyError) throw bodyError;
    const action = body && Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
    if (!action) throw new RequestError("invalid-request", "Unknown action.", 400);
    for (const k of Object.keys(body)) if (k !== "action" && !action.fields.includes(k)) throw new RequestError("invalid-request", `Unknown field ${k}.`, 400);
    if (!isValidBusinessId(body.businessId)) throw new RequestError("invalid-request", "Invalid business.", 400);
    const tenant = tenantDb(db, body.businessId);
    try {
      return respond(200, { success: true, ...(await action.run({ db, tenant, FieldValue: admin.firestore.FieldValue, actor: { uid: op.uid, name: op.email || op.name }, now: now() }, body)) });
    } catch (err) {
      if (err instanceof InvitationDesignError) throw new RequestError(err.code, err.message, STATUS[err.code] || 400);
      throw err;
    }
  });
}

export const handler = createInvitationDesignHandler({ getAdmin });
