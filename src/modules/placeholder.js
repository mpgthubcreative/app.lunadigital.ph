// Shared "not built yet" screen for modules whose phase hasn't arrived.
import { html, render } from "../lib/html.js";
import { pageHeader, emptyState, card } from "../components/ui.js";

export function mountPlaceholder(container, { title, subtitle, phase, description }) {
  render(
    container,
    html`
      ${pageHeader({ title, subtitle })}
      ${card({
        body: emptyState({
          iconName: "construction",
          title: `Arrives in Phase ${phase}`,
          body: description,
        }),
      })}
    `
  );
}
