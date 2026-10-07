// Client for Luna's server API (Netlify Functions behind /api/*).
//
// Phase 2 will attach the signed-in user's Firebase ID token via
// setTokenProvider(). The server never trusts anything this client claims
// about tenant, role or permissions — it re-derives all of that from the
// verified token on every request.

let tokenProvider = null;

export function setTokenProvider(fn) {
  tokenProvider = fn;
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (tokenProvider) {
    const token = await tokenProvider();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(`/api/${path.replace(/^\//, "")}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network-error", "Can't reach Luna. Check your connection and try again.");
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON response (e.g. a proxy error page) — handled below.
  }

  if (!response.ok || !data || data.success === false) {
    throw new ApiError(
      response.status,
      (data && data.error) || "server-error",
      (data && data.message) || "Something went wrong. Please try again.",
      data && data.fieldErrors
    );
  }
  return data;
}
