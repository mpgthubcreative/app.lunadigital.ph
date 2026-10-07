// Users — shows the permission templates from shared/permissions.js (a
// role is only a named bundle of permissions). Members are provisioned
// with scripts/add-member.js for now; in-app team management comes later.

import { ROLE_TEMPLATES, PERMISSION_KEYS } from "@shared/index.js";
import { html, render } from "../../lib/html.js";
import { pageHeader, card, badge } from "../../components/ui.js";

export function mount(container) {
  const templates = Object.entries(ROLE_TEMPLATES);
  render(
    container,
    html`
      ${pageHeader({ title: "Users", subtitle: "Team members and what they can access. In-app invitations arrive in a later phase." })}
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
