import { describe, it, expect } from "vitest";
import { html, trustedHtml } from "../../src/lib/html.js";

describe("html template", () => {
  it("escapes interpolated values by default", () => {
    const name = `<img src=x onerror="alert(1)">`;
    expect(String(html`<td>${name}</td>`)).toBe("<td>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</td>");
  });

  it("escapes inside attributes", () => {
    expect(String(html`<a title="${`" onmouseover="x`}">`)).toBe('<a title="&quot; onmouseover=&quot;x">');
  });

  it("does not double-escape nested templates and joins arrays", () => {
    const rows = ["a&b", "<c>"].map((v) => html`<li>${v}</li>`);
    expect(String(html`<ul>${rows}</ul>`)).toBe("<ul><li>a&amp;b</li><li>&lt;c&gt;</li></ul>");
  });

  it("renders null/undefined/false as empty and keeps 0", () => {
    expect(String(html`${null}${undefined}${false}${0}`)).toBe("0");
  });

  it("passes trustedHtml through unchanged", () => {
    expect(String(html`${trustedHtml("<svg></svg>")}`)).toBe("<svg></svg>");
  });
});
