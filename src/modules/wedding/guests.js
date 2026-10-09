// Guests & RSVP (Phase 16): one compact row per invitation (a guest or a
// household), with the RSVP summary on top.
//   Guest | Group | Side | Party Size | RSVP | Confirmed Guests | Invitation | RSVP · View details
// Party size (invited people) and confirmed attendees are kept apart:
// Confirmed guests counts PEOPLE (sum of confirmed attendees), Awaiting /
// Attending / Declined count invitations. Luna keeps the totals.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, badge, statCard } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { formatDayId, formatNumber } from "../../lib/format.js";
import { exportButton, bindExport, mayExport, exportHint } from "../../lib/export.js";
import { RSVP_STATUSES, GUEST_SIDES, rsvpSummary } from "@shared/index.js";
import { activityLines, detailsDialog } from "../baby/common.js";
import * as defaultData from "./data.js";

const SIDE_OPTIONS = Object.entries(GUEST_SIDES).map(([value, s]) => ({ value, label: s.label }));
const RSVP_OPTIONS = Object.entries(RSVP_STATUSES).map(([value, s]) => ({ value, label: s.label }));
const TONE = { awaiting: "warning", attending: "success", declined: "neutral" };

const guestFields = (g = {}) => [
  { name: "name", label: "Guest or household", value: g.name ?? "", required: true, hint: "e.g. Prado Family" },
  { name: "group", label: "Group", value: g.group ?? "", hint: "e.g. Groom's relatives, Office friends" },
  { name: "side", label: "Side", type: "select", options: SIDE_OPTIONS, value: g.side ?? "both" },
  { name: "partySize", label: "Invited party size", value: g.partySize ?? 1, inputmode: "numeric", required: true },
  { name: "contact", label: "Contact", value: g.contact ?? "" },
  { name: "invitationSent", label: "Invitation sent on", type: "date", value: g.invitationSent ?? "" },
  { name: "notes", label: "Notes", type: "textarea", value: g.notes ?? "" },
];

export function toGuestInput(v) {
  const partySize = Number(v.partySize);
  if (!Number.isSafeInteger(partySize) || partySize < 1) throw new Error("Party size must be a whole number, 1 or more");
  return { name: v.name.trim(), group: v.group.trim() || null, side: v.side, partySize, contact: v.contact.trim() || null, invitationSent: v.invitationSent || null, notes: (v.notes || "").trim() || null };
}

export function parseRsvp(v, partySize) {
  if (v.status !== "attending") return { status: v.status };
  const confirmed = Number(v.confirmed);
  if (!Number.isSafeInteger(confirmed) || confirmed < 1) throw new Error("How many are coming? (1 or more)");
  if (confirmed > partySize) throw new Error(`At most ${partySize} (the invited party size)`);
  return { status: "attending", confirmed };
}

export function mount(container, session, { data = defaultData, toast = defaultToast, confirm = confirmDialog, exportDeps = {} } = {}) {
  const canManage = session.member.permissions["guests.manage"] === true;
  const businessId = session.business.id;
  const timezone = session.business.timezone;
  const state = { filters: {}, cursors: [], rows: [], hasMore: false, totals: null, loading: true, error: null };
  let alive = true;

  async function load() {
    state.loading = true;
    draw();
    try {
      const [totals, page] = await Promise.all([data.getGuestTotals(businessId), data.listGuests(businessId, state.filters, { cursor: state.cursors.at(-1) || null })]);
      state.totals = totals;
      state.rows = page.rows;
      state.hasMore = page.hasMore;
      state.error = null;
    } catch (err) {
      console.error("guests: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load guests.";
    }
    state.loading = false;
    draw();
  }

  const opt = (v, l, sel) => html`<option value="${v}" ${sel === v ? "selected" : ""}>${l}</option>`;

  function draw() {
    if (!alive) return;
    const f = state.filters;
    const t = rsvpSummary(state.totals);
    render(
      container,
      html`
        ${pageHeader({ title: "Guests & RSVP", subtitle: "Who's invited, who's coming and how many seats you need.", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new">Add guest</button>` : "" })}
        <section class="section" data-section="rsvp">
          <h2 class="section-title">RSVP summary · as of now</h2>
          <div class="stat-grid">
            ${statCard({ id: "invited", label: "Invited (people)", value: formatNumber(t.invitedSeats), hint: `${t.invitations} invitation${t.invitations === 1 ? "" : "s"} · ${t.invitationsSent} sent` })}
            ${statCard({ id: "confirmed", label: "Confirmed guests (people)", value: formatNumber(t.attendingSeats), hint: `${t.attending} invitation${t.attending === 1 ? "" : "s"} attending` })}
            ${statCard({ id: "declined", label: "Declined (invitations)", value: formatNumber(t.declined), hint: `${t.declinedSeats} people` })}
            ${statCard({ id: "awaiting", label: "Awaiting RSVP (invitations)", value: formatNumber(t.awaiting), hint: `${t.awaitingSeats} people not yet answered` })}
          </div>
        </section>
        <form class="section card filters filters-inline" data-role="filters">
          <input class="input" name="search" placeholder="Name starts with…" value="${f.search || ""}" autocomplete="off" aria-label="Search name" />
          <select class="select" name="rsvp" aria-label="RSVP">${opt("", "Any RSVP", f.rsvp || "")}${RSVP_OPTIONS.map((r) => opt(r.value, r.label, f.rsvp))}</select>
          <select class="select" name="side" aria-label="Side">${opt("", "Any side", f.side || "")}${SIDE_OPTIONS.map((s) => opt(s.value, s.label, f.side))}</select>
          <select class="select" name="invited" aria-label="Invitation">${opt("", "Invitation: any", f.invited || "")}${opt("sent", "Sent", f.invited)}${opt("not_sent", "Not sent", f.invited)}</select>
          <button type="submit" class="btn">Apply</button>
          ${mayExport(session, "guests") ? html`${exportButton("guests")}<span class="stat-hint">${exportHint}</span>` : ""}
        </form>
        <section class="section card">
          ${state.error
            ? emptyState({ title: "Couldn't load", body: state.error })
            : state.loading
              ? emptyState({ title: "Loading…" })
              : !state.rows.length
                ? emptyState({ iconName: "users", title: "No guests here", body: "Add each guest or household with its party size, then record RSVPs as they come in." })
                : html`<div class="table-wrap"><table class="table table-compact" data-role="guests">
                    <thead><tr><th>Guest</th><th class="col-secondary">Group</th><th class="col-secondary">Side</th><th class="num">Party size</th><th>RSVP</th><th class="num">Confirmed</th><th class="col-secondary">Invitation</th><th></th></tr></thead>
                    <tbody>${state.rows.map(
                      (g) => html`<tr data-guest="${g.id}">
                        <td>${g.name}</td><td class="col-secondary">${g.group || "—"}</td><td class="col-secondary">${GUEST_SIDES[g.side]?.label ?? g.side}</td>
                        <td class="num">${g.partySize}</td>
                        <td>${badge(RSVP_STATUSES[g.rsvp]?.label ?? g.rsvp, TONE[g.rsvp] || "neutral")}</td>
                        <td class="num">${g.rsvp === "attending" ? g.confirmed : "—"}</td>
                        <td class="col-secondary">${g.invitationSent ? `Sent ${formatDayId(g.invitationSent)}` : "Not sent"}</td>
                        <td class="row-actions">
                          ${canManage ? html`<button type="button" class="btn btn-compact" data-act="rsvp" data-id="${g.id}">RSVP</button>` : ""}
                          <button type="button" class="btn btn-compact" data-act="view" data-id="${g.id}">View details</button>
                        </td>
                      </tr>`
                    )}</tbody></table></div>
                  <div class="modal-footer">
                    <button type="button" class="btn" data-act="prev" ${state.cursors.length ? "" : "disabled"}>Previous</button>
                    <button type="button" class="btn" data-act="next" ${state.hasMore ? "" : "disabled"}>Next</button>
                  </div>`}
        </section>`
    );
  }

  const rsvpDialog = (g) =>
    formDialog({
      title: `RSVP: ${g.name}`,
      intro: `Invited party of ${g.partySize}. Confirmed guests count only for Attending.`,
      fields: [
        { name: "status", label: "RSVP", type: "select", options: RSVP_OPTIONS, value: g.rsvp },
        { name: "confirmed", label: "Confirmed guests (if Attending)", value: g.rsvp === "attending" ? g.confirmed : g.partySize, inputmode: "numeric" },
      ],
      onSubmit: (v) => data.guestsApi({ action: "setRsvp", guestId: g.id, rsvp: parseRsvp(v, g.partySize) }),
    });

  function openView(g) {
    detailsDialog({
      title: g.name,
      badgeHtml: badge(RSVP_STATUSES[g.rsvp]?.label ?? g.rsvp, TONE[g.rsvp] || "neutral"),
      rows: [["Group", g.group], ["Side", GUEST_SIDES[g.side]?.label], ["Invited party size", String(g.partySize)], ["Confirmed guests", g.rsvp === "attending" ? String(g.confirmed) : null], ["RSVP date", g.rsvpDate ? formatDayId(g.rsvpDate) : null], ["Invitation sent", g.invitationSent ? formatDayId(g.invitationSent) : "Not sent"], ["Contact", g.contact], ["Notes", g.notes]],
      activity: activityLines(g.history, timezone),
      actions: canManage ? [{ act: "remove", label: "Remove guest", danger: true }, { act: "edit", label: "Edit" }] : [],
      onAction: async (act) => {
        try {
          if (act === "edit") {
            const r = await formDialog({
              title: `Edit ${g.name}`,
              fields: guestFields(g),
              onSubmit: (v) => {
                const next = toGuestInput(v);
                const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (g[k] ?? null) !== (val ?? null)));
                return Object.keys(changes).length ? data.guestsApi({ action: "update", guestId: g.id, expectedRevision: g.revision, changes }) : { unchanged: true };
              },
            });
            if (r && !r.unchanged) toast("Saved.", "success");
            if (r) load();
            return Boolean(r);
          }
          if (act === "remove") {
            if (!(await confirm({ title: `Remove ${g.name}?`, body: "Use this for a guest added by mistake. The RSVP totals drop their party.", confirmLabel: "Remove guest", danger: true }))) return false;
            await data.guestsApi({ action: "remove", guestId: g.id });
            toast("Guest removed.", "success");
            load();
            return true;
          }
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
        return false;
      },
    });
  }

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return;
    const g = state.rows.find((r) => r.id === el.dataset.id);
    try {
      switch (el.dataset.act) {
        case "new": {
          const r = await formDialog({ title: "Add guest", fields: guestFields(), onSubmit: (v) => data.guestsApi({ action: "create", guest: toGuestInput(v) }) });
          if (r) {
            toast("Guest added.", "success");
            load();
          }
          return;
        }
        case "rsvp": {
          if (!g) return;
          const r = await rsvpDialog(g);
          if (r && !r.unchanged) toast("RSVP saved.", "success");
          if (r) load();
          return;
        }
        case "view":
          if (g) openView(g);
          return;
        case "next":
          state.cursors.push(state.rows.at(-1));
          load();
          return;
        case "prev":
          state.cursors.pop();
          load();
          return;
        default:
          return;
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  const onSubmit = (event) => {
    if (event.target.dataset.role !== "filters") return;
    event.preventDefault();
    const el = event.target.elements;
    state.filters = Object.fromEntries([["rsvp", el.rsvp.value], ["side", el.side.value], ["invited", el.invited.value], ["search", el.search.value.trim()]].filter(([, v]) => v));
    state.cursors = [];
    load();
  };
  container.addEventListener("click", onClick);
  container.addEventListener("submit", onSubmit);
  const unbindExport = bindExport(container, () => ({ ...state.filters }), { toast, deps: exportDeps });
  load();
  return () => {
    alive = false;
    unbindExport();
    container.removeEventListener("click", onClick);
    container.removeEventListener("submit", onSubmit);
  };
}
