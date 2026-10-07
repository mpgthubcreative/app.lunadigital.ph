// Users — Phase 2 adds real members and invitations. Phase 1 shows the role
// templates straight from shared/permissions.js to make the model visible:
// a role is only a named bundle of permissions.

import { ROLE_TEMPLATES, PERMISSION_KEYS } from "@shared/index.js";
import { html, render } from "../../lib/html.js";
import { pageHeader, card, badge } from "../../components/ui.js";

export function mount(container) {
  const templates = Object.entries(ROLE_TEMPLATES);
  render(
    container,
    html`
      ${pageHeader({ title: "Users", subtitle: "Team members and what they can access. Invitations arrive in Phase 2." })}
      ${card({
        title: "Role templates",
        body: html`
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Template</th><th>Description</th><th class="num">Permissions</th></tr></thead>
              <tbody>
                ${templates.map(
                  ([id, t]) => html`
                    <tr>
                      <td>${badge(t.label, id === "owner" ? "primary" : "neutral")}</td>
                      <td>${t.description}</td>
                      <td class="num">${t.permissions.length} / ${PERMISSION_KEYS.length}</td>
                    </tr>
                  `
                )}
              </tbody>
            </table>
          </div>
        `,
      })}
    `
  );
}
