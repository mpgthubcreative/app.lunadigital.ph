// Client for Luna's server API (Netlify Functions behind /api/*).
//
// Attaches the signed-in user's Firebase ID token and the selected
// business id. The business id is a SELECTOR only: the server re-derives
// tenant access, permissions and subscription from the verified token and
// membership records on every request and never trusts this client.

import { BUSINESS_SELECTOR_HEADER } from "@shared/tenancy.js";

let tokenProvider = null;
let businessSelector = () => null;

export function setTokenProvider(fn) {
  tokenProvider = fn;
}

export function setBusinessSelector(fn) {
  businessSelector = fn;
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
  const businessId = businessSelector();
  if (businessId) headers[BUSINESS_SELECTOR_HEADER] = businessId;

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

// POST that answers with a file (Phase 12.5 exports): { blob, fileName,
// rows }. Errors come back as the usual JSON and become an ApiError.
export async function apiDownload(path, body) {
  const headers = { Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/json", "Content-Type": "application/json" };
  if (tokenProvider) {
    const token = await tokenProvider();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const businessId = businessSelector();
  if (businessId) headers[BUSINESS_SELECTOR_HEADER] = businessId;
  let response;
  try {
    response = await fetch(`/api/${path.replace(/^\//, "")}`, { method: "POST", headers, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "network-error", "Can't reach Luna. Check your connection and try again.");
  }
  const type = response.headers.get("Content-Type") || "";
  if (!response.ok || type.includes("application/json")) {
    let data = null;
    try {
      data = await response.json();
    } catch {
      // handled below
    }
    throw new ApiError(response.status, (data && data.error) || "server-error", (data && data.message) || "Something went wrong. Please try again.");
  }
  const disposition = response.headers.get("Content-Disposition") || "";
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await response.blob(), fileName: match ? match[1] : "Luna_Export.xlsx", rows: Number(response.headers.get("X-Luna-Export-Rows")) || 0 };
}
