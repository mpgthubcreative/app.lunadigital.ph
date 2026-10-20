// Modal form. fields: [{ name, label, type: "text"|"select"|"textarea"|"file"|"checkbox",
// value?, options?: [{ value, label }], hint?, required?, disabled?, inputmode?,
// placeholder?, suggestions?: [text] (typing suggestions, any text allowed),
// more? (Phase 18.6: goes in a closed "More details (optional)" section,
// opened when one of its fields already has a value, unless that value is
// just a smart default: default: true) }]. moreLabel names the section.
// onSubmit(values) may throw; its message is shown in the dialog and the
// dialog stays open. Resolves with onSubmit's result, or null if cancelled.
// A checkbox gives true / false (value: true = ticked); a textarea takes
// maxlength (default 300) and rows (default 2).
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
  if (f.type === "file") {
    return html`<input class="input" type="file" id="${common.id}" name="${common.name}" accept="${f.accept || ""}" />`;
  }
  if (f.type === "textarea") {
    return html`<textarea class="input" id="${common.id}" name="${common.name}" rows="${f.rows ?? 2}" maxlength="${f.maxlength ?? 300}" ${f.placeholder ? html`placeholder="${f.placeholder}"` : ""}>${f.value ?? ""}</textarea>`;
  }
  if (f.type === "checkbox") {
    return html`<input type="checkbox" id="${common.id}" name="${common.name}" ${f.value === true ? "checked" : ""} />`;
  }
  if (f.type === "date") {
    return html`<input class="input" type="date" id="${common.id}" name="${common.name}" value="${f.value ?? ""}" ${f.max ? html`max="${f.max}"` : ""} ${f.disabled ? "disabled" : ""} />`;
  }
  const list = f.suggestions?.length ? `${id}-list` : "";
  return html`<input class="input" id="${common.id}" name="${common.name}" value="${f.value ?? ""}" ${f.inputmode ? html`inputmode="${f.inputmode}"` : ""} ${f.placeholder ? html`placeholder="${f.placeholder}"` : ""} ${list ? html`list="${list}"` : ""} ${f.disabled ? "disabled" : ""} autocomplete="off" />${list ? html`<datalist id="${list}">${f.suggestions.map((s) => html`<option value="${s}"></option>`)}</datalist>` : ""}`;
}

// armMs (money steps, e.g. Pay salary): the submit button stays inactive for
// that long after the dialog opens, so a tap that opened it (or a tap meant
// for the screen underneath) can never submit it. Only a deliberate press
// of the button after that submits.
// onFormChange(form): called once when the dialog opens and after every
// change, to adapt the form (e.g. "Schedule for later" swaps Date paid for
// Scheduled date).
// cancelLabel: the Cancel button's text (e.g. "Back" when cancelling returns
// to a previous step). Cancel, Escape and the backdrop all resolve null.
export function formDialog({ title, intro = "", fields, submitLabel = "Save", cancelLabel = "Cancel", onSubmit, moreLabel = "More details (optional)", armMs = 0, onFormChange = null }) {
  return new Promise((resolve) => {
    const uid = ++counter;
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const fieldBlock = (f) =>
      f.type === "checkbox"
        ? html`<div class="field field-check"><label class="check" for="fd-${uid}-${f.name}">${fieldMarkup(f, `fd-${uid}-${f.name}`)}<span>${f.label}</span></label>${f.hint ? html`<div class="stat-hint">${f.hint}</div>` : ""}</div>`
        : html`<div class="field">
                <label for="fd-${uid}-${f.name}">${f.label}${f.required ? " *" : ""}</label>
                ${fieldMarkup(f, `fd-${uid}-${f.name}`)}
                ${f.hint ? html`<div class="stat-hint">${f.hint}</div>` : ""}
              </div>`;
    const main = fields.filter((f) => !f.more);
    const more = fields.filter((f) => f.more);
    const moreOpen = more.some((f) => !f.default && f.value !== undefined && f.value !== null && f.value !== "" && f.type !== "select");
    render(
      backdrop,
      html`
        <form class="modal form fd" role="dialog" aria-modal="true" aria-labelledby="fd-title-${uid}" novalidate>
          <div class="modal-header"><h2 class="card-title" id="fd-title-${uid}">${title}</h2></div>
          <div class="modal-body">
            ${intro ? html`<p class="stat-note">${intro}</p>` : ""}
            ${main.map(fieldBlock)}
            ${more.length ? html`<details class="form-more" ${moreOpen ? "open" : ""}><summary>${moreLabel}</summary>${more.map(fieldBlock)}</details>` : ""}
            <p class="form-error" data-role="error" role="alert" hidden></p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn" data-action="cancel">${cancelLabel}</button>
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

    let armed = armMs <= 0;
    let busy = false;
    if (!armed) {
      submitBtn.disabled = true;
      submitBtn.dataset.arming = "true";
      setTimeout(() => {
        armed = true;
        delete submitBtn.dataset.arming;
        if (!busy) submitBtn.disabled = false;
      }, armMs);
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      // Not armed yet, or already sending (double tap): nothing happens.
      if (!armed || busy) return;
      busy = true;
      // File fields give the chosen File (or null); everything else its text.
      const values = Object.fromEntries(fields.map((f) => [f.name, f.type === "file" ? form.elements[f.name].files?.[0] ?? null : f.type === "checkbox" ? form.elements[f.name].checked : form.elements[f.name].value]));
      errorEl.hidden = true;
      submitBtn.disabled = true;
      try {
        close(await onSubmit(values));
      } catch (err) {
        errorEl.textContent = err.message || "Something went wrong.";
        errorEl.hidden = false;
        submitBtn.disabled = false;
        busy = false;
      }
    });
    form.querySelector('[data-action="cancel"]').addEventListener("click", () => close(null));
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) close(null);
    });
    document.addEventListener("keydown", onKey);
    if (onFormChange) {
      form.addEventListener("change", () => onFormChange(form));
      onFormChange(form);
    }
    document.body.appendChild(backdrop);
    const first = form.querySelector("input:not([disabled]), select:not([disabled]), textarea");
    if (first) first.focus();
  });
}
