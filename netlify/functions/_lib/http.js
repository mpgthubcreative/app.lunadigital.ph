// Shared HTTP helpers (carried over from Hayst Kopi's lib/http.js) so every
// function returns the same JSON shape and never leaks a raw error or
// stack trace to the client.

export function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

// Thrown deliberately with a safe, user-facing message and HTTP status;
// caught once per handler (see withErrorHandling) and mapped to a response.
export class RequestError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Wraps a handler so a RequestError becomes its own response and anything
// unexpected becomes a generic 500 (logged server-side only).
export function withErrorHandling(name, handler) {
  return async (event, context) => {
    try {
      return await handler(event, context);
    } catch (err) {
      if (err instanceof RequestError) {
        return respond(err.statusCode, { success: false, error: err.code, message: err.message });
      }
      console.error(`${name} failed:`, err);
      return respond(500, { success: false, error: "server-error", message: "Something went wrong. Please try again." });
    }
  };
}

export function requireMethod(event, method) {
  if (event.httpMethod !== method) {
    throw new RequestError("method-not-allowed", "Method not allowed.", 405);
  }
}

export function parseJsonBody(event, maxBytes) {
  if (!event.body || Buffer.byteLength(event.body, "utf8") > maxBytes) {
    throw new RequestError("invalid-request", "Invalid request.", 400);
  }
  try {
    return JSON.parse(event.body);
  } catch {
    throw new RequestError("invalid-json", "Invalid request.", 400);
  }
}
