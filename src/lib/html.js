// Escape-by-default HTML templating.
//
// Every interpolated value is HTML-escaped unless it is itself the result
// of html`` (or explicitly wrapped with trustedHtml()). Tenant data — order
// notes, customer names, product names — is user-entered and must never
// reach innerHTML unescaped. Use this instead of hand-concatenating strings.

const SAFE = Symbol("safe-html");

class SafeHtml {
  constructor(value) {
    this[SAFE] = value;
  }
  toString() {
    return this[SAFE];
  }
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderValue(value) {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value[SAFE];
  if (Array.isArray(value)) return value.map(renderValue).join("");
  return escapeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) {
    out += renderValue(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}

// Only for static markup that ships with Luna (e.g. icon SVGs). Never pass
// data that came from Firestore or user input.
export function trustedHtml(markup) {
  return new SafeHtml(String(markup));
}

export function render(el, content) {
  el.innerHTML = renderValue(content);
}
