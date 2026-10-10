// Luna's small chart language (Phase 18.5). Inline SVG only: shapes are
// sized with attributes and colored with CSS classes (the CSP forbids
// style=""), scale to their container through the viewBox, and draw only
// aggregates the server already computed. At most three hues per chart.
//   waterfall      total -> deductions -> result ("where did it go?")
//   stackedColumns parts of a total over time (COGS + gross profit = sales)
//   groupedColumns two series compared per period (orders created vs fulfilled)
//   shareBar       one 100% bar for a part-to-whole (payments by method)
// Every chart has an aria-label summary; values also appear as text.

import { html } from "../lib/html.js";

const W = 360;

// A "nice" axis maximum (1, 2, 2.5, 5 × 10^n).
export function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// Compact money for chart labels: ₱482k, ₱1.2M (full values are in tables).
export function compactMoney(centavos) {
  const v = centavos / 100;
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 1_000_000) return `${sign}₱${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${sign}₱${(a / 1_000).toFixed(a >= 100_000 ? 0 : 1)}k`;
  return `${sign}₱${Math.round(a)}`;
}

const legendSwatch = (cls) => html`<svg viewBox="0 0 10 10" aria-hidden="true"><rect class="${cls}" width="10" height="10" rx="3"></rect></svg>`;
export const legend = (items) => html`<div class="legend">${items.map((i) => html`<span class="legend-key">${legendSwatch(i.cls)}${i.label}</span>`)}</div>`;

// steps: [{ label: ["Gross", "profit"], value, kind: "total"|"minus"|"result", cls }]
// "total"/"result" bars stand on zero; "minus" bars hang from the running value.
export function waterfall(steps, { aria = "", format = compactMoney } = {}) {
  let run = 0;
  const bars = steps.map((s) => {
    if (s.kind === "minus") {
      const from = run;
      run -= s.value;
      return { ...s, top: Math.max(from, run), bottom: Math.min(from, run), shown: -s.value };
    }
    run = s.value;
    return { ...s, top: Math.max(0, s.value), bottom: Math.min(0, s.value), shown: s.value };
  });
  const hi = niceMax(Math.max(...bars.map((b) => b.top), 1));
  const lo = Math.min(0, ...bars.map((b) => b.bottom));
  const lowP = lo < 0 ? -niceMax(-lo) : 0;
  const top = 26;
  const bottom = 178;
  const y = (v) => bottom - ((v - lowP) / (hi - lowP)) * (bottom - top);
  const step = (W - 32) / bars.length;
  const bw = Math.min(46, step * 0.66);
  return html`<svg viewBox="0 0 ${W} 222" role="img" aria-label="${aria}">
    <line class="grid-line" x1="12" y1="${y(0).toFixed(1)}" x2="${W - 12}" y2="${y(0).toFixed(1)}"></line>
    ${bars.map((b, i) => {
      const x = 16 + i * step + (step - bw) / 2;
      const yt = y(b.top);
      const h = Math.max(1, y(b.bottom) - yt);
      const next = bars[i + 1];
      const joinY = b.kind === "minus" ? y(b.bottom) : y(b.top);
      return html`<rect class="${b.value < 0 && b.kind !== "minus" ? "fill-loss" : b.cls}" x="${x.toFixed(1)}" y="${yt.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3"></rect>
        <text class="chart-value" x="${(x + bw / 2).toFixed(1)}" y="${(yt - 6).toFixed(1)}" text-anchor="middle">${format(b.shown)}</text>
        ${next ? html`<line class="connector" x1="${(x + bw).toFixed(1)}" y1="${joinY.toFixed(1)}" x2="${(x + step).toFixed(1)}" y2="${joinY.toFixed(1)}"></line>` : ""}
        ${(Array.isArray(b.label) ? b.label : [b.label]).map((line, li) => html`<text x="${(x + bw / 2).toFixed(1)}" y="${(196 + li * 13).toFixed(1)}" text-anchor="middle">${line}</text>`)}`;
    })}
  </svg>`;
}

// periods: [{ label, parts: [{ value, cls }], note? }]: parts stack bottom-up
// (negative parts are clamped to 0; a loss shows as a red cap instead).
export function stackedColumns(periods, { aria = "", format = compactMoney, maxLabels = 8 } = {}) {
  const totals = periods.map((p) => p.parts.reduce((s, x) => s + Math.max(0, x.value || 0), 0));
  const max = niceMax(Math.max(...totals, 1));
  const top = 18;
  const bottom = 172;
  const left = 40;
  const y = (v) => bottom - (v / max) * (bottom - top);
  const step = (W - left - 8) / Math.max(1, periods.length);
  const bw = Math.min(30, step * 0.62);
  const every = Math.ceil(periods.length / maxLabels);
  return html`<svg viewBox="0 0 ${W} 196" role="img" aria-label="${aria}">
    ${[0, 0.5, 1].map((f) => html`<line class="grid-line" x1="${left}" y1="${y(max * f).toFixed(1)}" x2="${W - 6}" y2="${y(max * f).toFixed(1)}"></line><text x="${left - 6}" y="${(y(max * f) + 4).toFixed(1)}" text-anchor="end">${format(max * f)}</text>`)}
    ${periods.map((p, i) => {
      const x = left + i * step + (step - bw) / 2;
      let base = 0;
      const rects = p.parts.map((part) => {
        const v = Math.max(0, part.value || 0);
        if (!v) return "";
        const r = html`<rect class="${part.cls}" x="${x.toFixed(1)}" y="${y(base + v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(y(base) - y(base + v)).toFixed(1)}"></rect>`;
        base += v;
        return r;
      });
      return html`${rects}${p.loss ? html`<rect class="fill-loss" x="${x.toFixed(1)}" y="${(y(base) - 3).toFixed(1)}" width="${bw.toFixed(1)}" height="3"></rect>` : ""}${p.note ? html`<text class="chart-value" x="${(x + bw / 2).toFixed(1)}" y="${(y(base) - 6).toFixed(1)}" text-anchor="middle">${p.note}</text>` : ""}${i % every === 0 || i === periods.length - 1 ? html`<text x="${(x + bw / 2).toFixed(1)}" y="188" text-anchor="middle">${p.label}</text>` : ""}`;
    })}
  </svg>`;
}

// periods: [{ label, values: [a, b] }], series: [{ cls }] (two bars per period).
export function groupedColumns(periods, series, { aria = "", format = (n) => String(n), maxLabels = 8 } = {}) {
  const max = niceMax(Math.max(1, ...periods.flatMap((p) => p.values.map((v) => v || 0))));
  const top = 14;
  const bottom = 152;
  const left = 30;
  const y = (v) => bottom - (v / max) * (bottom - top);
  const step = (W - left - 8) / Math.max(1, periods.length);
  const group = Math.min(34, step * 0.7);
  const bw = group / series.length;
  const every = Math.ceil(periods.length / maxLabels);
  return html`<svg viewBox="0 0 ${W} 176" role="img" aria-label="${aria}">
    ${[0, 0.5, 1].map((f) => html`<line class="grid-line" x1="${left}" y1="${y(max * f).toFixed(1)}" x2="${W - 6}" y2="${y(max * f).toFixed(1)}"></line><text x="${left - 6}" y="${(y(max * f) + 4).toFixed(1)}" text-anchor="end">${format(Math.round(max * f))}</text>`)}
    ${periods.map((p, i) => {
      const x0 = left + i * step + (step - group) / 2;
      return html`${p.values.map((v, k) => (v > 0 ? html`<rect class="${series[k].cls}" x="${(x0 + k * bw).toFixed(1)}" y="${y(v).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${(bottom - y(v)).toFixed(1)}" rx="2"></rect>` : ""))}${i % every === 0 || i === periods.length - 1 ? html`<text x="${(x0 + group / 2).toFixed(1)}" y="168" text-anchor="middle">${p.label}</text>` : ""}`;
    })}
  </svg>`;
}

// parts: [{ label, value, cls }] -> one 100% bar.
export function shareBar(parts, { aria = "" } = {}) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value || 0), 0);
  if (!total) return "";
  let x = 0;
  return html`<svg class="bar is-thick" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${aria}">${parts.map((p) => {
    const w = (Math.max(0, p.value || 0) / total) * 100;
    const r = w > 0 ? html`<rect class="${p.cls}" x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="8"></rect>` : "";
    x += w;
    return r;
  })}</svg>`;
}

// Four distinct, restrained fills for part-to-whole (ordered by size).
export const SHARE_FILLS = ["fill-sales", "fill-profit", "fill-expense", "fill-neutral"];
