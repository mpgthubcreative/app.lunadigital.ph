// GET /api/health
// Public liveness check: proves the functions pipeline (esbuild bundling,
// /api/* redirect, shared/ imports) works end to end. Returns no tenant
// data and no secrets — only whether server config is present.

import { respond, withErrorHandling, requireMethod } from "./_lib/http.js";
import { isFirebaseConfigured } from "./_lib/firebase-admin.js";
import { MODULE_IDS } from "../../shared/modules.js";

export const handler = withErrorHandling("health", async (event) => {
  requireMethod(event, "GET");
  return respond(200, {
    success: true,
    service: "luna",
    firebaseConfigured: isFirebaseConfigured(),
    modules: MODULE_IDS.length,
  });
});
