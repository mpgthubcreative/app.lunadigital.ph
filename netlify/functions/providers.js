// POST /api/providers   (Phase 15: Baby Providers / Vendors; providers.manage)
//   { action: "create", provider: { name, type, phone?, email?, location?, notes? } }
//   { action: "update", providerId, expectedRevision?, changes: { ...any of the above } }
//   { action: "setStatus", providerId, status: "active" | "inactive" }
// A Baby-only directory: not Distributor Customers, not Bridal suppliers.
// Reads go straight to Firestore (providers.view).

import { getAdmin } from "./_lib/firebase-admin.js";
import { babyActionHandler } from "./_lib/baby-http.js";
import { createProvider, updateProvider, setProviderStatus } from "./_lib/baby.js";

const M = "providers.manage";
export const createProvidersHandler = (deps) =>
  babyActionHandler("providers", {
    ...deps,
    actions: {
      create: { permission: M, created: true, fields: ["action", "provider"], run: (c, b) => createProvider({ ...c, input: b.provider }) },
      update: { permission: M, fields: ["action", "providerId", "expectedRevision", "changes"], run: (c, b) => updateProvider({ ...c, providerId: b.providerId, changes: b.changes, expectedRevision: b.expectedRevision ?? null }) },
      setStatus: { permission: M, fields: ["action", "providerId", "status"], run: (c, b) => setProviderStatus({ ...c, providerId: b.providerId, status: b.status }) },
    },
  });

export const handler = createProvidersHandler({ getAdmin });
