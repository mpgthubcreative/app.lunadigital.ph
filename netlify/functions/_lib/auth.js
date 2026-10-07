// Verifies the caller's Firebase ID token. Every authenticated endpoint
// starts here; nothing the browser says about who it is counts until this
// passes.

import { RequestError } from "./http.js";

function bearerToken(event) {
  const headers = event.headers || {};
  const header = headers.authorization || headers.Authorization || "";
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match ? match[1] : null;
}

// Returns { uid, email, name } or throws 401.
// checkRevoked=true: a disabled Firebase account or revoked session is
// rejected immediately instead of living on until the token expires (≤1h).
export async function authenticate(event, auth) {
  const token = bearerToken(event);
  if (!token) {
    throw new RequestError("unauthenticated", "Please sign in.", 401);
  }
  try {
    const decoded = await auth.verifyIdToken(token, true);
    return { uid: decoded.uid, email: decoded.email || "", name: decoded.name || "" };
  } catch (err) {
    const code = err && err.code;
    if (code === "auth/id-token-expired") {
      throw new RequestError("session-expired", "Your session expired. Please sign in again.", 401);
    }
    if (code === "auth/user-disabled" || code === "auth/id-token-revoked") {
      throw new RequestError("account-disabled", "This account has been disabled.", 401);
    }
    console.error("authenticate: token verification failed:", code || err);
    throw new RequestError("unauthenticated", "Please sign in.", 401);
  }
}
