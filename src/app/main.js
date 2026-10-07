// Tenant app entry point: resolve the session → render the shell from it →
// route to lazily-loaded modules.

import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/layout.css";
import "../styles/components.css";

import { loadSession } from "./session.js";
import { renderShell } from "./shell.js";
import { createRouter } from "./router.js";
import { MODULE_LOADERS } from "../modules/loaders.js";
import { html, render } from "../lib/html.js";
import { pageHeader, card, emptyState } from "../components/ui.js";

const root = document.getElementById("app");

async function boot() {
  const session = await loadSession();
  const shell = renderShell(root, session);

  let cleanup = null;
  let navToken = 0;

  const routes = shell.nav.map((mod) => ({ path: mod.path, label: mod.label, moduleId: mod.id }));

  const router = createRouter({
    routes,
    async onRoute(route) {
      const token = ++navToken;
      if (typeof cleanup === "function") cleanup();
      cleanup = null;
      shell.setActive(route);

      try {
        const mod = await MODULE_LOADERS[route.moduleId]();
        if (token !== navToken) return; // user navigated away while loading
        cleanup = mod.mount(shell.content, session) || null;
      } catch (err) {
        console.error(`Failed to load module ${route.moduleId}:`, err);
        render(shell.content, card({ body: emptyState({ title: "This page couldn't load", body: "Check your connection and refresh the page." }) }));
      }
      shell.content.focus({ preventScroll: true });
    },
    notFound() {
      shell.setActive({ path: null, label: "Not available" });
      render(
        shell.content,
        html`
          ${pageHeader({ title: "Page not available" })}
          ${card({ body: emptyState({ title: "This page isn't available", body: "It doesn't exist, or it isn't enabled for your account." }) })}
        `
      );
    },
  });

  router.start();
}

boot().catch((err) => {
  console.error("Luna failed to start:", err);
  root.textContent = "Luna couldn't start. Please refresh the page.";
});
