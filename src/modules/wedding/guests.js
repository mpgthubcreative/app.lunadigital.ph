// Guests (Phase 16; Owner-pilot Bridal UX): mobile-first, two views behind
// one compact switch.
//   RSVP     a one-line summary in PEOPLE (seats): invited · attending ·
//            waiting · declined; All / Waiting / Attending / Declined and a
//            search across categories; guests grouped by their category
//            (the categories Luna keeps; "Not set" for older guests), each
//            group with its own counts. One line per guest:
//              Name | Seats | RSVP ▾ | ⋯
//            Seats = the invited party size; for Attending, the confirmed
//            number ("3/4" when fewer than invited are coming).
//   Seating  attending · seated · unassigned (people); Unassigned first,
//            then each table with its seats used / capacity. One line per
//            guest: Name | Seats | ⋯ (assign / move / unassign).
// Party size (invited people) and confirmed attendees stay apart. RSVP
// changes made here are recorded as the Owner side's (rsvpSource "owner",
// with who and when in the history), so a future invitation-link answer
// ("guest") can sit beside them without overwriting the trail.
// Owner-pilot second pass: the summary line, the RSVP | Seating switch,
// then Search + "RSVP: All ▾" on one line. A category header is just
// "FAMILY · 18/24" (people attending / invited). Each group's list scrolls
// inside its own box past ~6 rows, so one big category never takes over the
// page; ⋯ menus inside a scrolling box open as a floating layer. Downloads
// live under More.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, skeleton, segmented } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { formatDayId } from "../../lib/format.js";
import { RSVP_STATUSES, GUEST_SIDES, GUEST_CATEGORIES, GUEST_CATEGORY_IDS, rsvpSummary, seatingPlan, MAX_TABLE_CAPACITY } from "@shared/index.js";
import { activityLines, detailsDialog } from "../baby/common.js";
import * as defaultData from "./data.js";

const SIDE_OPTIONS = Object.entries(GUEST_SIDES).map(([value, s]) => ({ value, label: s.label }));
// Simple words for the stored RSVP statuses.
export const RSVP_WORDS = { awaiting: "Waiting", attending: "Attending", declined: "Declined" };
const RSVP_TONE = { awaiting: "warning", attending: "success", declined: "" };
const CATEGORY_OPTIONS = Object.entries(GUEST_CATEGORIES).map(([value, c]) => ({ value, label: c.label }));
const FILTERS = [["all", "All"], ["awaiting", "Waiting"], ["attending", "Attending"], ["declined", "Declined"]];
const MAX_GUESTS = 1000;

const guestFields = (g = {}) => [
  { name: "name", label: "Guest or household", value: g.name ?? "", required: true, placeholder: "e.g. Prado Family" },
  { name: "category", label: "Category", type: "select", options: [{ value: "", label: "— Choose —" }, ...CATEGORY_OPTIONS], value: g.category ?? "", required: true },
  { name: "partySize", label: "Seats (party size)", value: g.partySize ?? 1, inputmode: "numeric", required: true },
  { name: "side", label: "Side", type: "select", options: SIDE_OPTIONS, value: g.side ?? "both", more: true, default: true },
  { name: "contact", label: "Contact", value: g.contact ?? "", more: true },
  { name: "invitationSent", label: "Invitation sent on", type: "date", value: g.invitationSent ?? "", more: true },
  { name: "notes", label: "Notes", type: "textarea", value: g.notes ?? "", more: true },
];

export function toGuestInput(v) {
  const partySize = Number(v.partySize);
  if (!Number.isSafeInteger(partySize) || partySize < 1) throw new Error("Party size must be a whole number, 1 or more");
  if (!v.category) throw new Error("Choose a category");
  return { name: v.name.trim(), category: v.category, side: v.side || "both", partySize, contact: (v.contact || "").trim() || null, invitationSent: v.invitationSent || null, notes: (v.notes || "").trim() || null };
}

export function parseRsvp(v, partySize) {
  if (v.status !== "attending") return { status: v.status };
  const confirmed = Number(v.confirmed);
  if (!Number.isSafeInteger(confirmed) || confirmed < 1) throw new Error("How many are coming? (1 or more)");
  if (confirmed > partySize) throw new Error(`At most ${partySize} (the invited party size)`);
  return { status: "attending", confirmed };
}

// Seats shown on a row: invited party size, or confirmed (of invited) when attending.
export const seatsText = (g) => (g.rsvp === "attending" && g.confirmed !== g.partySize ? `${g.confirmed}/${g.partySize}` : String(g.rsvp === "attending" ? g.confirmed : g.partySize));
// People per status for a list of guests (the same model as guestTotals).
export function seatCounts(guests) {
  const c = { invited: 0, attending: 0, awaiting: 0, declined: 0 };
  for (const g of guests) {
    c.invited += g.partySize || 0;
    if (g.rsvp === "attending") c.attending += g.confirmed || 0;
    else if (g.rsvp === "declined") c.declined += g.partySize || 0;
    else c.awaiting += g.partySize || 0;
  }
  return c;
}
// Category groups in Luna's category order; "Not set" last. Empty groups dropped.
export function groupGuests(guests) {
  const by = new Map([...GUEST_CATEGORY_IDS, ""].map((id) => [id, []]));
  for (const g of guests) by.get(GUEST_CATEGORY_IDS.includes(g.category) ? g.category : "").push(g);
  return [...by.entries()].filter(([, list]) => list.length).map(([id, list]) => ({ id: id || "none", label: id ? GUEST_CATEGORIES[id].label : "Not set", guests: list }));
}

export function mount(container, session, { data = defaultData, toast = defaultToast, confirm = confirmDialog } = {}) {
  const canManage = session.member.permissions["guests.manage"] === true;
  const businessId = session.business.id;
  const timezone = session.business.timezone;
  const state = { view: "rsvp", filter: "all", search: "", rows: [], totals: null, seating: null, loading: true, error: null, invites: false };
  let alive = true;

  async function load() {
    state.loading = !state.rows.length;
    draw();
    try {
      const [totals, page, seating, setup] = await Promise.all([data.getGuestTotals(businessId), data.listGuests(businessId, {}, { pageSize: MAX_GUESTS }), data.getSeating ? data.getSeating(businessId).catch(() => null) : null, canManage && data.getWeddingSetup ? data.getWeddingSetup().catch(() => null) : null]);
      // Invitation links once the couple has set up their invitation.
      state.invites = Boolean(setup?.setup && (setup.setup.coupleNames || setup.setup.rsvpEnabled));
      state.totals = totals;
      state.rows = page.rows;
      state.seating = seating;
      state.error = null;
    } catch (err) {
      console.error("guests: load failed:", err && (err.code || err.message));
      state.error = "Couldn't load guests.";
    }
    state.loading = false;
    draw();
  }

  const fmt = (n) => Number(n || 0).toLocaleString("en-PH");
  const menu = (label, items) =>
    items.length
      ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="${label}">⋯</summary><div class="line-menu-list" role="menu">${items.map((i) => html`${i.sep ? html`<div class="menu-sep" role="separator"></div>` : ""}<button type="button" class="menu-item${i.danger ? " menu-danger" : ""}" role="menuitem" data-act="${i.act}" data-id="${i.id}">${i.label}</button>`)}</div></details>`
      : "";
  const rsvpControl = (g) =>
    canManage
      ? html`<select class="select select-chip wl-status" data-role="rsvp" data-id="${g.id}" data-tone="${RSVP_TONE[g.rsvp] || ""}" aria-label="RSVP for ${g.name}">${Object.keys(RSVP_STATUSES).map((k) => html`<option value="${k}" ${k === g.rsvp ? "selected" : ""}>${RSVP_WORDS[k]}</option>`)}</select>`
      : html`<span class="wl-chip" data-tone="${RSVP_TONE[g.rsvp] || ""}">${RSVP_WORDS[g.rsvp] ?? g.rsvp}</span>`;
  const seats = (g, text = seatsText(g)) => html`<span class="wl-seats" data-role="seats" aria-label="${text} seats">${text}</span>`;
  const guestMenu = (g) =>
    menu(`More for ${g.name}`, [
      ...(canManage && g.rsvp === "attending" && g.partySize > 1 ? [{ act: "count", id: g.id, label: "Change number attending" }] : []),
      ...(canManage ? [{ act: "edit", id: g.id, label: "Edit" }] : []),
      ...(canManage && state.invites ? [{ act: "invite-view", id: g.id, label: "View invitation" }, { act: "invite-copy", id: g.id, label: "Copy invitation link" }, { act: "invite-new", id: g.id, label: "Regenerate invitation link" }] : []),
      { act: "view", id: g.id, label: "Details & history" },
      ...(canManage ? [{ act: "remove", id: g.id, label: "Remove guest", danger: true, sep: true }] : []),
    ]);
  const rsvpRow = (g) => html`<li class="wl-row wl-guest" data-guest="${g.id}"><button type="button" class="wl-main" data-act="view" data-id="${g.id}"><span class="wl-name">${g.name}</span></button>${seats(g)}${rsvpControl(g)}${guestMenu(g)}</li>`;

  const shown = () => {
    const q = state.search.toLowerCase();
    return state.rows.filter((g) => (state.filter === "all" || g.rsvp === state.filter) && (!q || g.name.toLowerCase().includes(q)));
  };

  function rsvpView() {
    const list = shown();
    const groups = groupGuests(list);
    if (!state.rows.length) return emptyState({ iconName: "users", title: "No guests yet", body: "Add each guest or household with its number of seats." });
    if (!groups.length) return html`<p class="stat-hint wl-none">No ${state.filter === "all" ? "" : RSVP_WORDS[state.filter].toLowerCase() + " "}guests${state.search ? ` matching "${state.search}"` : ""}.</p>`;
    return groups.map(
      (gr) => {
        // Attending / invited, in people (for the guests shown).
        const c = seatCounts(gr.guests);
        return html`<section class="wl-cat" data-category="${gr.id}">
          <h2 class="wl-cat-head"><span class="wl-group-title">${gr.label}</span><span class="wl-cat-counts" data-role="cat-counts" title="${c.attending} attending of ${c.invited} invited">· ${fmt(c.attending)}/${fmt(c.invited)}</span></h2>
          <ul class="wl-list wl-scroll" data-role="guests">${gr.guests.map(rsvpRow)}</ul>
        </section>`;
      }
    );
  }

  function seatingView() {
    const plan = seatingPlan(state.rows, state.seating);
    const seatRow = (g, table) =>
      html`<li class="wl-row wl-guest" data-guest="${g.id}"><button type="button" class="wl-main" data-act="view" data-id="${g.id}"><span class="wl-name">${g.name}</span></button>${seats(g, String(g.confirmed))}${!table && canManage ? html`<button type="button" class="btn btn-compact" data-act="seat" data-id="${g.id}">Assign</button>` : menu(`Seating for ${g.name}`, canManage ? [{ act: "seat", id: g.id, label: "Move to another table" }, { act: "unseat", id: g.id, label: "Unassign" }] : [{ act: "view", id: g.id, label: "Details & history" }])}</li>`;
    return html`
      <section class="wl-section" data-group="unassigned">
        <h2 class="wl-cat-head"><span class="wl-group-title">Unassigned</span><span class="wl-cat-counts">· ${fmt(plan.unassignedSeats)}</span></h2>
        ${plan.unassigned.length ? html`<ul class="wl-list wl-scroll" data-role="unassigned">${plan.unassigned.map((g) => seatRow(g, null))}</ul>` : html`<p class="stat-hint wl-none">${plan.attendingSeats ? "Everyone attending has a table." : "Guests appear here once they're attending."}</p>`}
      </section>
      ${plan.tables.length
        ? plan.tables.map(
            (t) => html`<section class="wl-section" data-table="${t.id}">
              <div class="wl-head"><h2 class="wl-cat-head"><span class="wl-group-title">${t.name}</span><span class="wl-cat-counts ${t.used > t.capacity ? "is-over" : ""}" data-role="table-seats" title="seats taken / seats">· ${t.used}/${t.capacity}${t.used > t.capacity ? ` · over by ${t.used - t.capacity}` : ""}</span></h2>${canManage ? menu(`Table ${t.name}`, [{ act: "table-edit", id: t.id, label: "Rename / change seats" }, { act: "table-delete", id: t.id, label: "Delete table", danger: true, sep: true }]) : ""}</div>
              ${t.guests.length ? html`<ul class="wl-list wl-scroll" data-role="table-guests">${t.guests.map((g) => seatRow(g, t))}</ul>` : html`<p class="stat-hint wl-none">No one yet.</p>`}
            </section>`
          )
        : html`<p class="stat-hint wl-none" data-role="no-tables">No tables yet.${canManage ? " Add your reception tables, then assign guests." : ""}</p>`}`;
  }

  function draw() {
    if (!alive) return;
    const t = rsvpSummary(state.totals);
    const seatingOn = state.view === "seating";
    const plan = seatingOn ? seatingPlan(state.rows, state.seating) : null;
    render(
      container,
      html`
        ${pageHeader({ title: "Guests", actions: canManage ? (seatingOn ? html`<button type="button" class="btn btn-primary" data-act="new-table">+ Add table</button>` : html`<button type="button" class="btn btn-primary" data-act="new">+ Add guest</button>`) : "" })}
        ${state.loading || state.error
          ? ""
          : seatingOn
            ? html`<p class="wl-count" data-role="seating-summary">${fmt(plan.attendingSeats)} attending · ${fmt(plan.seatedSeats)} seated · <strong class="${plan.unassignedSeats ? "is-warn" : ""}">${fmt(plan.unassignedSeats)} unassigned</strong></p>`
            : html`<p class="wl-count" data-role="rsvp-summary" title="People (seats), not invitations">${fmt(t.invitedSeats)} invited · ${fmt(t.attendingSeats)} attending · ${fmt(t.awaitingSeats)} waiting${t.declinedSeats ? ` · ${fmt(t.declinedSeats)} declined` : ""}</p>`}
        <div class="wl-tools">${segmented("view", [["rsvp", "RSVP"], ["seating", "Seating"]], state.view, { label: "Guests view" })}</div>
        ${seatingOn || !state.rows.length
          ? ""
          : html`<div class="wl-tools wl-guest-tools">
              <input class="input wl-search" type="search" data-role="search" placeholder="Search guest" aria-label="Search guest" value="${state.search}">
              <label class="wl-pick"><span class="wl-pick-label">RSVP:</span><select class="select select-compact" data-role="filter" aria-label="RSVP filter">${FILTERS.map(([v, l]) => html`<option value="${v}" ${v === state.filter ? "selected" : ""}>${l}</option>`)}</select></label>
            </div>`}
        ${state.error
          ? emptyState({ title: "Couldn't load", body: state.error })
          : state.loading
            ? skeleton(6)
            : seatingOn
              ? seatingView()
              : rsvpView()}`
    );
  }

  const rsvpDialog = (g, status = "attending") =>
    formDialog({
      title: `${g.name}: how many are coming?`,
      fields: [{ name: "confirmed", label: `Attending (of ${g.partySize} invited)`, value: g.rsvp === "attending" ? g.confirmed : g.partySize, inputmode: "numeric", required: true }],
      submitLabel: "Save",
      onSubmit: (v) => data.guestsApi({ action: "setRsvp", guestId: g.id, rsvp: parseRsvp({ status, confirmed: v.confirmed }, g.partySize) }),
    });
  const after = (message) => (r) => {
    if (r && !r.unchanged) toast(message, "success");
    if (r) load();
    return Boolean(r);
  };
  const editDialog = (g) =>
    formDialog({
      title: `Edit ${g.name}`,
      fields: guestFields(g),
      onSubmit: (v) => {
        const next = toGuestInput(v);
        const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (g[k] ?? null) !== (val ?? null)));
        return Object.keys(changes).length ? data.guestsApi({ action: "update", guestId: g.id, expectedRevision: g.revision, changes }) : { unchanged: true };
      },
    });
  async function removeGuest(g) {
    if (!(await confirm({ title: `Remove ${g.name}?`, body: "Use this for a guest added by mistake. The RSVP totals drop their party.", confirmLabel: "Remove guest", danger: true }))) return false;
    await data.guestsApi({ action: "remove", guestId: g.id });
    toast("Guest removed.", "success");
    load();
    return true;
  }
  const tables = () => seatingPlan(state.rows, state.seating).tables;
  const seatDialog = (g) => {
    const list = tables().filter((t) => t.id !== g.tableId);
    if (!list.length) {
      toast(tables().length ? "There's no other table yet." : "Add a table first (+ Add table).", "danger");
      return null;
    }
    return formDialog({
      title: `Seat ${g.name} (${g.confirmed})`,
      fields: [{ name: "tableId", label: "Table", type: "select", options: list.map((t) => ({ value: t.id, label: `${t.name} · ${t.used}/${t.capacity}${t.used + g.confirmed > t.capacity ? " (over)" : ""}` })), value: list.find((t) => t.used + g.confirmed <= t.capacity)?.id ?? list[0].id }],
      submitLabel: g.tableId ? "Move" : "Assign",
      onSubmit: (v) => data.guestsApi({ action: "seat", guestId: g.id, tableId: v.tableId }),
    });
  };
  const capacity = (v) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_TABLE_CAPACITY) throw new Error(`Seats must be 1 to ${MAX_TABLE_CAPACITY}`);
    return n;
  };
  const tableDialog = (t = null) =>
    formDialog({
      title: t ? `Edit ${t.name}` : "Add table",
      fields: [
        { name: "name", label: "Table name", value: t ? t.name : `Table ${tables().length + 1}`, required: true },
        { name: "capacity", label: "Seats", value: t ? t.capacity : 10, inputmode: "numeric", required: true },
      ],
      submitLabel: t ? "Save" : "Add table",
      onSubmit: (v) => {
        const table = { name: v.name.trim(), capacity: capacity(v.capacity) };
        if (!t) return data.guestsApi({ action: "createTable", table });
        const changes = Object.fromEntries(Object.entries(table).filter(([k, val]) => t[k] !== val));
        return Object.keys(changes).length ? data.guestsApi({ action: "updateTable", tableId: t.id, changes }) : { unchanged: true };
      },
    });

  function openView(g) {
    const table = g.tableId ? tables().find((t) => t.id === g.tableId) : null;
    detailsDialog({
      title: g.name,
      badgeHtml: html`<span class="wl-chip" data-tone="${RSVP_TONE[g.rsvp] || ""}">${RSVP_WORDS[g.rsvp] ?? g.rsvp}</span>`,
      rows: [["Category", GUEST_CATEGORIES[g.category]?.label ?? "Not set"], ...(g.group ? [["Group (earlier note)", g.group]] : []), ["Seats invited", String(g.partySize)], ["Attending", g.rsvp === "attending" ? String(g.confirmed) : null], ["Table", table ? table.name : null], ["RSVP date", g.rsvpDate ? formatDayId(g.rsvpDate) : null], ["Side", GUEST_SIDES[g.side]?.label], ["Invitation sent", g.invitationSent ? formatDayId(g.invitationSent) : "Not sent"], ["Contact", g.contact], ["Notes", g.notes]],
      activity: activityLines(g.history, timezone),
      actions: canManage ? [{ act: "remove", label: "Remove guest", danger: true }, { act: "edit", label: "Edit" }] : [],
      onAction: async (act) => {
        try {
          if (act === "edit") return after("Saved.")(await editDialog(g));
          if (act === "remove") return await removeGuest(g);
        } catch (err) {
          toast(err.message || "Something went wrong", "danger");
        }
        return false;
      },
    });
  }

  async function copyLink(url, name, fresh = false) {
    try {
      await navigator.clipboard.writeText(url);
      toast(`${fresh ? "New link" : "Link"} for ${name} copied.`, "success");
    } catch {
      // No clipboard access: show the link to copy by hand.
      await formDialog({ title: `Invitation link for ${name}`, fields: [{ name: "url", label: "Copy this link", value: url }], submitLabel: "Done", onSubmit: () => true });
    }
  }
  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export") return;
    const a = el.dataset.act;
    if (a === "seg") {
      state[el.dataset.seg === "view" ? "view" : "filter"] = el.dataset.value;
      draw();
      return;
    }
    el.closest("details.line-menu")?.removeAttribute("open");
    const g = state.rows.find((r) => r.id === el.dataset.id);
    const t = state.seating?.tables?.[el.dataset.id] ? { id: el.dataset.id, ...state.seating.tables[el.dataset.id] } : null;
    try {
      if (a === "new") after("Guest added.")(await formDialog({ title: "Add guest", fields: guestFields(), submitLabel: "Add guest", onSubmit: (v) => data.guestsApi({ action: "create", guest: toGuestInput(v) }) }));
      else if (a === "new-table") after("Table added.")(await tableDialog());
      else if (a === "table-edit" && t) after("Saved.")(await tableDialog(t));
      else if (a === "table-delete" && t) {
        if (!(await confirm({ title: `Delete ${t.name}?`, body: "Its guests go back to Unassigned.", confirmLabel: "Delete table", danger: true }))) return;
        after("Table deleted.")(await data.guestsApi({ action: "deleteTable", tableId: t.id }));
      } else if (!g) return;
      else if (a === "view") openView(g);
      else if (a === "edit") after("Saved.")(await editDialog(g));
      else if (a === "remove") await removeGuest(g);
      else if (a === "count") after("RSVP saved.")(await rsvpDialog(g));
      else if (a === "seat") after(g.tableId ? "Moved." : "Seated.")(await seatDialog(g));
      else if (a === "unseat") after("Unassigned.")(await data.guestsApi({ action: "seat", guestId: g.id, tableId: null }));
      else if (a === "invite-view" || a === "invite-copy") {
        // Open the window first (a popup must start from the tap), then fill it in.
        const win = a === "invite-view" ? window.open("about:blank", "_blank") : null;
        const r = await data.guestsApi({ action: "inviteLink", guestId: g.id });
        const url = `${location.origin}${r.path}`;
        if (win) win.location.href = url;
        else await copyLink(url, g.name);
      } else if (a === "invite-new") {
        if (!(await confirm({ title: `New invitation link for ${g.name}?`, body: "The link you sent before stops working. Send them the new one.", confirmLabel: "Make a new link" }))) return;
        const r = await data.guestsApi({ action: "regenerateInvite", guestId: g.id });
        await copyLink(`${location.origin}${r.path}`, g.name, true);
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  // RSVP ▾ in the row. Attending asks how many when more than one is invited.
  const onChange = async (event) => {
    const el = event.target;
    if (el.dataset?.role === "filter") {
      state.filter = el.value;
      draw();
      return;
    }
    if (el.dataset?.role !== "rsvp" || !container.contains(el)) return;
    const g = state.rows.find((r) => r.id === el.dataset.id);
    if (!g) return;
    const status = el.value;
    try {
      if (status === "attending" && g.partySize > 1) {
        el.value = g.rsvp;
        after("RSVP saved.")(await rsvpDialog(g));
        return;
      }
      el.disabled = true;
      const r = await data.guestsApi({ action: "setRsvp", guestId: g.id, rsvp: status === "attending" ? { status, confirmed: g.partySize } : { status } });
      after(g.tableId && status !== "attending" ? "RSVP saved. Their table seat was freed." : "RSVP saved.")(r || {});
    } catch (err) {
      el.value = g.rsvp;
      el.disabled = false;
      toast(err.message || "Something went wrong", "danger");
    }
  };
  const onInput = (event) => {
    if (event.target.dataset?.role !== "search") return;
    state.search = event.target.value.trim();
    const pos = event.target.selectionStart;
    draw();
    const box = container.querySelector('[data-role="search"]');
    if (box) {
      box.focus();
      box.setSelectionRange(pos, pos);
    }
  };
  // A ⋯ menu inside a scrolling list floats (fixed) so the box doesn't clip
  // it; scrolling the box closes it.
  const onToggle = (event) => {
    const d = event.target;
    if (!d.matches?.("details.line-menu") || !d.closest(".wl-scroll")) return;
    const list = d.querySelector(".line-menu-list");
    if (!d.open) {
      list.removeAttribute("style");
      return;
    }
    // Below the ⋯ when it fits, else above it, else pinned inside the screen (scrolling).
    const r = d.querySelector("summary").getBoundingClientRect();
    list.style.cssText = `position:fixed;left:auto;right:${Math.max(8, innerWidth - r.right)}px;top:${r.bottom + 4}px;bottom:auto;max-height:${innerHeight - 16}px;overflow-y:auto`;
    const h = list.getBoundingClientRect().height;
    if (r.bottom + 4 + h > innerHeight - 8) list.style.top = `${Math.max(8, r.top - 4 - h)}px`;
  };
  const onScroll = (event) => {
    if (!event.target.classList?.contains("wl-scroll")) return;
    for (const d of event.target.querySelectorAll("details.line-menu[open]")) d.removeAttribute("open");
  };
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("input", onInput);
  container.addEventListener("toggle", onToggle, true);
  container.addEventListener("scroll", onScroll, true);
  load();
  return () => {
    alive = false;
    container.removeEventListener("scroll", onScroll, true);
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("input", onInput);
    container.removeEventListener("toggle", onToggle, true);
  };
}
