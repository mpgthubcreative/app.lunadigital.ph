import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { handler } from "../../netlify/functions/health.js";

const FIREBASE_ENV = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "FIRESTORE_EMULATOR_HOST", "FIREBASE_AUTH_EMULATOR_HOST"];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(FIREBASE_ENV.map((k) => [k, process.env[k]]));
  FIREBASE_ENV.forEach((k) => delete process.env[k]);
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("GET /api/health", () => {
  it("responds ok without Firebase credentials and leaks nothing sensitive", async () => {
    const res = await handler({ httpMethod: "GET" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({ success: true, service: "luna", firebaseConfigured: false });
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("rejects other methods with a clean JSON error", async () => {
    const res = await handler({ httpMethod: "POST" });
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toMatchObject({ success: false, error: "method-not-allowed" });
  });
});
