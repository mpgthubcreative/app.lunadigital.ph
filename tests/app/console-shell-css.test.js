// The console shell has a scrim and a menu button the tenant shell doesn't.
// Phase 18.5 dropped their CSS, the unstyled scrim took the shell's content
// column, and the console looked empty. Keep both hidden by default and the
// phone drawer scoped to .console-shell.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../../src/styles/layout.css", import.meta.url), "utf8");
const main = readFileSync(new URL("../../src/console/main.js", import.meta.url), "utf8");

describe("Luna Console shell CSS", () => {
  it("hides the scrim and menu button outside the phone drawer", () => {
    expect(css).toMatch(/\.scrim,\s*\.menu-btn\s*\{\s*display:\s*none;/);
  });
  it("styles the phone drawer for the console shell, which the console uses", () => {
    expect(css).toContain(".console-shell.nav-open .sidebar");
    expect(css).toContain(".console-shell.nav-open .scrim");
    expect(main).toContain('class="shell console-shell"');
    expect(main).toContain('class="scrim"');
  });
});
