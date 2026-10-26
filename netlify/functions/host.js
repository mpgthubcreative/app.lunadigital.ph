// POST /api/host   PUBLIC: what a custom workspace address shows.
//   { name: "<label>" } -> { status: "live", workspace, name, storeSlug?, appOrigin }
//                        | { status: "moved", host }        an older name: go to the current one
//                        | { status: "unavailable" | "retired" | "not-found" }
// The address only locates a workspace; it opens nothing private.
import { respond, withErrorHandling, requireMethod, parseJsonBody, RequestError } from "./_lib/http.js";
import { getAdmin } from "./_lib/firebase-admin.js";
import { resolveCustomHost, customLinkDomain } from "./_lib/custom-links.js";
import { siteOrigin } from "../../shared/environment.js";

export function createHostHandler({ getAdmin: loadAdmin, env = process.env }) {
  return withErrorHandling("host", async (event) => {
    requireMethod(event, "POST");
    const body = parseJsonBody(event, 500);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "name") || typeof body.name !== "string") throw new RequestError("invalid-request", "Invalid request.", 400);
    const { db } = await loadAdmin();
    return respond(200, { success: true, host: await resolveCustomHost({ db, label: body.name.toLowerCase(), domain: customLinkDomain(env), appOrigin: siteOrigin(env.SITE_URL) }) });
  });
}

export const handler = createHostHandler({ getAdmin });
