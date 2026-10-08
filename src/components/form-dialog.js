// Modal form. fields: [{ name, label, type: "text"|"select"|"textarea",
// value?, options?: [{ value, label }], hint?, required?, disabled?, inputmode? }].
// onSubmit(values) may throw; its message is shown in the dialog and the
// dialog stays open. Resolves with onSubmit's result, or null if cancelled.
// All text is escaped by html``.

import { html, render } from "../lib/html.js";

let counter = 0;

function fieldMarkup(f, id) {
  const common = { id, name: f.name };
  if (f.type === "select") {
    return html`<select class="select" id="${common.id}" name="${common.name}" ${f.disabled ? "disabled" : ""}>
      ${f.options.map((o) => html`<option value="${o.value}" ${String(o.value) === String(f.value ?? "") ? "selected" : ""}>${o.label}</option>`)}
    </select>`;
  }
  if (f.type === "textarea") {
    return html`<textarea class="input" id="${common.id}" name="${common.name}" rows="2" maxlength="300">${f.value ?? ""}</textarea>`;
  }
  return html`<input class="input" id="${common.id}" name="${common.name}" value="${f.value ?? ""}" ${f.inputmode ? html`inputmode="${f.inputmode}"` : ""} ${f.disabled ? "disabled" : ""} autocomplete="off" />`;
}

export function formDialog({ title, intro = "", fields, submitLabel = "Save", onSubmit }) {
  return new Promise((resolve) => {
    const uid = ++counter;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    render(
      backdrop,
      html`
        <form class="modal form" role="dialog" aria-modal="true" aria-labelledby="fd-title-${uid}" novalidate>
          <div class="modal-header"><h2 class="card-title" id="fd-title-${uid}">${title}</h2></div>
          <div class="modal-body">
            ${intro ? html`<p class="stat-note">${intro}</p>` : ""}
            ${fields.map(
              (f) => html`<div class="field">
                <label for="fd-${uid}-${f.name}">${f.label}${f.required ? " *" : ""}</label>
                ${fieldMarkup(f, `fd-${uid}-${f.name}`)}
                ${f.hint ? html`<div class="stat-hint">${f.hint}</div>` : ""}
              </div>`
            )}
            <p class="form-error" data-role="error" role="alert" hidden></p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn" data-action="cancel">Cancel</button>
            <button type="submit" class="btn btn-primary" data-action="submit">${submitLabel}</button>
          </div>
        </form>
      `
    );

    const form = backdrop.querySelector("form");
    const errorEl = form.querySelector('[data-role="error"]');
    const submitBtn = form.querySelector('[data-action="submit"]');
    const close = (result) => {
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(result);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(null);
    };

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name].value]));
      errorEl.hidden = true;
      submitBtn.disabled = true;
      try {
        close(await onSubmit(values));
      } catch (err) {
        errorEl.textContent = err.message || "Something went wrong.";
        errorEl.hidden = false;
        submitBtn.disabled = false;
      }
    });
    form.querySelector('[data-action="cancel"]').addEventListener("click", () => close(null));
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(backdrop);
    const first = form.querySelector("input:not([disabled]), select:not([disabled]), textarea");
    if (first) first.focus();
  });
}
