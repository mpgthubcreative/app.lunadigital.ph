// @vitest-environment jsdom
// Guard: unit tests run with no Firebase web config, so nothing in them can
// talk to a real project (CI has none; a developer's .env.local must not leak in).
// Module code that tries anyway must fail safely, not throw unhandled.

import { describe, it, expect, vi } from "vitest";
import { isFirebaseConfigured } from "../../src/lib/firebase.js";
import { mount } from "../../src/modules/dashboard/index.js";
import { sessionFixture } from "../helpers/session-fixture.js";

describe("unit tests never reach a real Firebase project", () => {
  it("the Firebase web config is blank under Vitest", () => {
    expect(import.meta.env.VITE_FIREBASE_API_KEY).toBeFalsy();
    expect(import.meta.env.VITE_FIREBASE_PROJECT_ID).toBeFalsy();
    expect(isFirebaseConfigured()).toBe(false);
  });

  it("the dashboard's real data loader fails safely to 'Couldn't load'", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const el = document.createElement("div");
    mount(el, sessionFixture(), { now: new Date("2026-10-08T02:00:00Z") });
    await new Promise((r) => setTimeout(r, 20));
    expect(el.querySelector('[data-widget="ordersToday"] .stat-value').textContent.trim()).toBe("Couldn't load");
    errors.mockRestore();
  });
});
