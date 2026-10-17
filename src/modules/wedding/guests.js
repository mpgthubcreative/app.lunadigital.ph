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
import { RSVP_STATUSES, GUEST_SIDES, GUEST_CATEGORIES, GUEST_CATEGORY_IDS, rsvpSummary, seatingPlan, MAX_TABLE_CAPACITY, setupMissing } from "@shared/index.js";
import { activityLines, detailsDialog } from "../baby/common.js";
import * as defaultData from "./data.js";
import { openInvitePreview, copyText, canShare } from "./invite-preview.js";
import { WEDDING_ROLES, WEDDING_ROLE_IDS, rolesPlan, roleLabel, roleKey, categoryForRole, peopleOf, peopleWithoutRole, parsePersonKey, personKey, membersOf, attendingNames } from "@shared/wedding-roles.js";

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

export function mount(container, session, { data = defaultData, toast = defaultToast, confirm = confirmDialog, preview = openInvitePreview } = {}) {
  const canManage = session.member.permissions["guests.manage"] === true;
  const businessId = session.business.id;
  const timezone = session.business.timezone;
  const state = { view: "rsvp", filter: "all", search: "", rows: [], totals: null, seating: null, loading: true, error: null, setupMissing: null };
  let alive = true;

  async function load() {
    state.loading = !state.rows.length;
    draw();
    try {
      const [totals, page, seating, setup] = await Promise.all([data.getGuestTotals(businessId), data.listGuests(businessId, {}, { pageSize: MAX_GUESTS }), data.getSeating ? data.getSeating(businessId).catch(() => null) : null, canManage && data.getWeddingSetup ? data.getWeddingSetup().catch(() => null) : null]);
      // What Wedding Setup still needs before links can be made ([] = ready;
      // null = couldn't tell: the server decides and explains).
      state.setupMissing = setup?.setup ? setupMissing(setup.setup) : null;
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
      ? html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="${label}">⋯</summary><div class="line-menu-list" role="menu">${items.map((i) => html`${i.sep ? html`<div class="menu-sep" role="separator"></div>` : ""}${i.href ? html`<a class="menu-item menu-hint" role="menuitem" href="${i.href}" data-link data-act="${i.act}" data-id="${i.id}">${i.label}</a>` : html`<button type="button" class="menu-item${i.danger ? " menu-danger" : ""}" role="menuitem" data-act="${i.act}" data-id="${i.id}">${i.label}</button>`}`)}</div></details>`
      : "";
  const rsvpControl = (g) =>
    canManage
      ? html`<select class="select select-chip wl-status" data-role="rsvp" data-id="${g.id}" data-tone="${RSVP_TONE[g.rsvp] || ""}" aria-label="RSVP for ${g.name}">${Object.keys(RSVP_STATUSES).map((k) => html`<option value="${k}" ${k === g.rsvp ? "selected" : ""}>${RSVP_WORDS[k]}</option>`)}</select>`
      : html`<span class="wl-chip" data-tone="${RSVP_TONE[g.rsvp] || ""}">${RSVP_WORDS[g.rsvp] ?? g.rsvp}</span>`;
  const seats = (g, text = seatsText(g)) => html`<span class="wl-seats" data-role="seats" aria-label="${text} seats">${text}</span>`;
  // Invitation link actions, always visible to the Owner: Create (no link
  // yet), View / Copy / Regenerate (a link exists), or why not yet.
  const inviteItems = (g) => {
    if (state.setupMissing?.length) return [{ act: "invite-setup", id: g.id, href: "/wedding-setup", label: "Invitation: complete Wedding Setup first →" }];
    if (g.invitation?.status !== "active") return [{ act: "invite-create", id: g.id, label: "Create invitation link" }];
    return [{ act: "invite-view", id: g.id, label: "View invitation" }, { act: "invite-copy", id: g.id, label: "Copy invitation link" }, ...(canShare() ? [{ act: "invite-share", id: g.id, label: "Share invitation" }] : []), { act: "invite-new", id: g.id, label: "Regenerate link" }];
  };
  const guestMenu = (g) =>
    menu(`More for ${g.name}`, [
      ...(canManage && g.rsvp === "attending" && g.partySize > 1 ? [{ act: "count", id: g.id, label: "Change number attending" }] : []),
      ...(canManage ? [{ act: "edit", id: g.id, label: "Edit" }] : []),
      ...(canManage ? inviteItems(g) : []),
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
    const names = (g) => attendingNames(g);
    const seatRow = (g, table) =>
      html`<li class="wl-row wl-guest" data-guest="${g.id}"><button type="button" class="wl-main" data-act="view" data-id="${g.id}"><span class="wl-name">${g.name}</span>${names(g).length ? html`<span class="wl-sub" data-role="seat-names">${names(g).join(", ")}${g.confirmed > names(g).length ? ` + ${g.confirmed - names(g).length} unnamed` : ""}</span>` : ""}</button>${seats(g, String(g.confirmed))}${!table && canManage ? html`<button type="button" class="btn btn-compact" data-act="seat" data-id="${g.id}">Assign</button>` : menu(`Seating for ${g.name}`, canManage ? [{ act: "seat", id: g.id, label: "Move to another table" }, { act: "unseat", id: g.id, label: "Unassign" }] : [{ act: "view", id: g.id, label: "Details & history" }])}</li>`;
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

  // Roles: one group per role (PRINCIPAL SPONSORS · 8), one line per guest.
  // The roles live on the guest records (no second list of names).
  // Roles: one group per role (MAID / MATRON OF HONOR · 2), one line per
  // PERSON (a guest or a named party member); the count is people, never
  // party seats. "Not assigned yet" = named people without a role.
  const personLabel = (pp) => (pp.primary ? pp.name : `${pp.name} · ${pp.party}'s party`);
  function rolesView(roles) {
    const free = peopleWithoutRole(state.rows);
    const roleRow = (gr, pp) => html`<li class="wl-row wl-guest" data-role-guest="${gr.key}|${pp.key}"><button type="button" class="wl-main" data-act="view" data-id="${pp.guestId}"><span class="wl-name">${pp.name}</span>${pp.primary ? "" : html`<span class="wl-sub" data-role="party">${pp.party}'s party</span>`}</button><span class="wl-chip" data-tone="${RSVP_TONE[pp.rsvp] || ""}">${RSVP_WORDS[pp.rsvp] ?? pp.rsvp}</span>${menu(`${gr.label}: ${pp.name}`, [
      ...(canManage ? [{ act: "role-person", id: `${gr.key}|${pp.key}`, label: "Change person" }, { act: "role-change", id: `${gr.key}|${pp.key}`, label: "Change role" }] : []),
      { act: "view", id: pp.guestId, label: "View guest" },
      ...(canManage ? [{ act: "role-remove", id: `${gr.key}|${pp.key}`, label: "Remove role", danger: true, sep: true }] : []),
    ])}</li>`;
    return html`
      ${roles.length ? "" : html`<p class="stat-hint wl-none" data-role="no-roles">No roles yet. Assign the Maid of Honor, Best Man, sponsors and entourage from your guest list${canManage ? ": + Assign role" : ""}.</p>`}
      ${roles.map((gr) => html`<section class="wl-section" data-role-group="${gr.key}"><h2 class="wl-cat-head"><span class="wl-group-title">${gr.label}</span><span class="wl-cat-counts">· ${gr.people.length}</span></h2><ul class="wl-list wl-scroll" data-role="role-guests">${gr.people.map((pp) => roleRow(gr, pp))}</ul></section>`)}
      ${canManage && free.length ? html`<details class="wl-fold" data-role="open-roles"><summary>Not assigned yet (${free.length})</summary><ul class="wl-list">${free.map((pp) => html`<li class="wl-row wl-sample" data-free="${pp.key}"><span class="wl-main"><span class="wl-name">${pp.name}</span>${pp.primary ? "" : html`<small class="wl-opt">${pp.party}'s party</small>`}</span><button type="button" class="btn btn-compact" data-act="role-new" data-person="${pp.key}">Assign</button></li>`)}</ul></details>` : ""}`;
  }
  const ROLE_OPTIONS = [...WEDDING_ROLE_IDS.map((id) => ({ value: id, label: WEDDING_ROLES[id].label })), { value: "custom", label: "Custom role…" }];
  // Every named person (guests and party members), by name.
  const personOptions = (exclude = null) => [{ value: "", label: "— Choose a person —" }, ...peopleOf(state.rows).filter((pp) => pp.key !== exclude).sort((a, b) => a.name.localeCompare(b.name)).map((pp) => ({ value: pp.key, label: personLabel(pp) }))];
  const guestOptions = () => [...personOptions(), { value: "__new", label: "+ Add guest and assign" }];
  const target = (key) => {
    const { guestId, memberId } = parsePersonKey(key);
    return { guestId, ...(memberId ? { memberId } : {}) };
  };
  const roleOf = (v) => (v.role === "custom" ? { id: "custom", label: (v.customRole || "").trim() } : { id: v.role });
  // Assign: a role (or a custom one) to an existing person, or a new guest.
  // Assigning again adds another person (roles hold many people).
  const assignDialog = (roleId = "", person = "") =>
    formDialog({
      title: "Assign a wedding role",
      fields: [
        { name: "role", label: "Role", type: "select", options: ROLE_OPTIONS, value: roleId || "maid_of_honor" },
        { name: "customRole", label: "Custom role name", value: "", placeholder: "e.g. Program host", hint: "Only for Custom role." },
        { name: "guestId", label: "Person", type: "select", options: guestOptions(), value: person, hint: "Guests and the named people in their parties. Not on the list yet? Choose + Add guest and assign." },
        { name: "newName", label: "New guest's name", value: "", hint: "Only for + Add guest and assign.", more: true },
        { name: "newSeats", label: "Seats invited", value: "1", inputmode: "numeric", more: true },
      ],
      moreLabel: "New guest details",
      submitLabel: "Assign",
      onSubmit: async (v) => {
        const role = roleOf(v);
        if (role.id === "custom" && !role.label) throw new Error("Name the custom role");
        let key = v.guestId;
        if (key === "__new") {
          const name = (v.newName || "").trim();
          if (!name) throw new Error("Enter the new guest's name");
          key = (await data.guestsApi({ action: "create", guest: toGuestInput({ name, category: categoryForRole(role), side: "both", partySize: v.newSeats || "1", contact: "", invitationSent: "", notes: "" }) })).guestId;
        }
        if (!key) throw new Error("Choose a person");
        return data.guestsApi({ action: "assignRole", ...target(key), role });
      },
    });
  const roleFromKey = (key) => (key.startsWith("custom:") ? peopleOf(state.rows).flatMap((pp) => pp.roles).find((r) => roleKey(r) === key) : { id: key });

  function draw() {
    if (!alive) return;
    const t = rsvpSummary(state.totals);
    const seatingOn = state.view === "seating";
    const rolesOn = state.view === "roles";
    const plan = seatingOn ? seatingPlan(state.rows, state.seating) : null;
    const roles = rolesOn ? rolesPlan(state.rows) : null;
    render(
      container,
      html`
        ${pageHeader({ title: "Guests", actions: canManage ? (seatingOn ? html`<button type="button" class="btn btn-primary" data-act="new-table">+ Add table</button>` : rolesOn ? html`<button type="button" class="btn btn-primary" data-act="role-new">+ Assign role</button>` : html`<button type="button" class="btn btn-primary" data-act="new">+ Add guest</button>`) : "" })}
        ${state.loading || state.error
          ? ""
          : rolesOn
            ? html`<p class="wl-count" data-role="roles-summary">${fmt(new Set(roles.flatMap((r) => r.people.map((pp) => pp.key))).size)} people · ${fmt(roles.length)} roles</p>`
          : seatingOn
            ? html`<p class="wl-count" data-role="seating-summary">${fmt(plan.attendingSeats)} attending · ${fmt(plan.seatedSeats)} seated · <strong class="${plan.unassignedSeats ? "is-warn" : ""}">${fmt(plan.unassignedSeats)} unassigned</strong></p>`
            : html`<p class="wl-count" data-role="rsvp-summary" title="People (seats), not invitations">${fmt(t.invitedSeats)} invited · ${fmt(t.attendingSeats)} attending · ${fmt(t.awaitingSeats)} waiting${t.declinedSeats ? ` · ${fmt(t.declinedSeats)} declined` : ""}</p>`}
        <div class="wl-tools">${segmented("view", [["rsvp", "RSVP"], ["seating", "Seating"], ["roles", "Roles"]], state.view, { label: "Guests view" })}</div>
        ${seatingOn || rolesOn || !state.rows.length
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
              : rolesOn
                ? rolesView(roles)
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

  // Details = the party sheet: "Sanrah's Party", invited / attending, the
  // named people (primary first; + Add name for each unnamed seat; rename,
  // remove with a warning when linked, mark who's attending), then the
  // guest's details and history. Read-only without guests.manage.
  function openView(g0) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    let g = g0;
    const paint = () => {
      const table = g.tableId ? tables().find((t) => t.id === g.tableId) : null;
      const members = membersOf(g);
      const seats = g.partySize || 1;
      const unnamed = Math.max(0, seats - 1 - members.length);
      const attendingOn = canManage && g.rsvp === "attending";
      const rolesTxt = (roles) => (Array.isArray(roles) && roles.length ? roles.map((r) => roleLabel(r)).join(", ") : "");
      const markBtn = (mid, on) => (attendingOn ? html`<button type="button" class="btn btn-compact btn-ghost wl-mark${on ? " is-on" : ""}" data-pa="attend" data-mid="${mid}" aria-pressed="${on ? "true" : "false"}">${on ? "Attending ✓" : "Mark attending"}</button>` : on && g.rsvp === "attending" ? html`<span class="wl-chip" data-tone="success">Attending</span>` : "");
      const rows = [["Category", GUEST_CATEGORIES[g.category]?.label ?? "Not set"], ...(g.group ? [["Group (earlier note)", g.group]] : []), ["Role", rolesTxt(g.roles) || null], ["Table", table ? table.name : null], ["RSVP date", g.rsvpDate ? formatDayId(g.rsvpDate) : null], ["Side", GUEST_SIDES[g.side]?.label], ["Invitation sent", g.invitationSent ? formatDayId(g.invitationSent) : "Not sent"], ["Invitation link", g.invitation?.status === "active" ? "Created (⋯ → View / Copy invitation link)" : "Not created yet (⋯ → Create invitation link)"], ["Contact", g.contact], ["Notes", g.notes]].filter(([, v]) => v !== null && v !== undefined && v !== "");
      render(
        backdrop,
        html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="${g.name}" data-role="details">
          <div class="modal-header"><h2 class="card-title">${seats > 1 ? `${g.name}'s Party` : g.name}</h2><div class="page-actions"><span class="wl-chip" data-tone="${RSVP_TONE[g.rsvp] || ""}">${RSVP_WORDS[g.rsvp] ?? g.rsvp}</span></div></div>
          <div class="modal-body">
            <dl class="dl dl-compact" data-role="party-figures"><dt>Invited</dt><dd>${seats}</dd><dt>Attending</dt><dd>${g.rsvp === "attending" ? String(g.confirmed) : g.rsvp === "declined" ? "0" : "Waiting"}</dd></dl>
            <h3 class="section-title">${seats > 1 ? "Members" : "Guest"}</h3>
            <ul class="list wl-party" data-role="members">
              <li class="wl-member" data-member="primary"><span class="wl-member-name">${g.name} <small class="wl-opt">Primary</small>${rolesTxt(g.roles) ? html` <small class="wl-opt" data-role="member-roles">${rolesTxt(g.roles)}</small>` : ""}</span>${markBtn("primary", g.attending === true)}</li>
              ${members.map((m) => html`<li class="wl-member" data-member="${m.id}"><span class="wl-member-name">${m.name}${rolesTxt(m.roles) ? html` <small class="wl-opt" data-role="member-roles">${rolesTxt(m.roles)}</small>` : ""}</span>${markBtn(m.id, m.attending === true)}${canManage ? html`<button type="button" class="btn btn-compact btn-ghost" data-pa="rename" data-mid="${m.id}" aria-label="Rename ${m.name}">Rename</button><button type="button" class="btn btn-compact btn-ghost menu-danger" data-pa="remove" data-mid="${m.id}" aria-label="Remove ${m.name}">Remove</button>` : ""}</li>`)}
              ${canManage ? Array.from({ length: Math.min(unnamed, 12) }, () => html`<li class="wl-member"><button type="button" class="btn btn-compact btn-ghost" data-pa="add">+ Add name</button></li>`) : unnamed ? html`<li class="wl-member stat-hint">${unnamed} more invited (no names yet)</li>` : ""}
            </ul>
            ${unnamed && canManage ? html`<p class="stat-hint">Names are optional: the RSVP works by seat count, and names can be added later.</p>` : ""}
            <dl class="dl dl-compact" data-role="fields">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
            ${(g.history || []).length ? html`<h3 class="section-title">Activity</h3><ul class="list activity" data-role="activity">${activityLines(g.history, timezone).map((l) => html`<li>${l}</li>`)}</ul>` : ""}
          </div>
          <div class="modal-footer">${canManage ? html`<button type="button" class="btn btn-danger" data-act="remove">Remove guest</button><button type="button" class="btn" data-act="edit">Edit</button>` : ""}<button type="button" class="btn" data-act="close">Close</button></div>
        </div>`
      );
    };
    const refresh = async () => {
      await load();
      const fresh = state.rows.find((r) => r.id === g.id);
      if (!fresh) return close();
      g = fresh;
      return paint();
    };
    backdrop.addEventListener("click", async (ev) => {
      const act = ev.target.closest("[data-act]")?.dataset.act;
      const pa = ev.target.closest("[data-pa]");
      if (ev.target === backdrop || act === "close") return close();
      try {
        if (act === "edit") {
          close();
          return after("Saved.")(await editDialog(g));
        }
        if (act === "remove") {
          if (await removeGuest(g)) close();
          return undefined;
        }
        if (!pa) return undefined;
        const mid = pa.dataset.mid;
        const m = membersOf(g).find((x) => x.id === mid);
        if (pa.dataset.pa === "add") {
          const r = await formDialog({ title: `Add a name to ${g.name}'s party`, fields: [{ name: "name", label: "Name", value: "", required: true, placeholder: "e.g. Anna" }], submitLabel: "Add", onSubmit: (v) => data.guestsApi({ action: "addMember", guestId: g.id, name: v.name }) });
          if (r) await refresh();
        } else if (pa.dataset.pa === "rename" && m) {
          const r = await formDialog({ title: `Rename ${m.name}`, fields: [{ name: "name", label: "Name", value: m.name, required: true }], submitLabel: "Save", onSubmit: (v) => data.guestsApi({ action: "renameMember", guestId: g.id, memberId: m.id, name: v.name }) });
          if (r) await refresh();
        } else if (pa.dataset.pa === "remove" && m) {
          try {
            await data.guestsApi({ action: "removeMember", guestId: g.id, memberId: m.id });
          } catch (err) {
            // Linked (a role / marked attending): say what, then ask.
            if (!/anyway\?$/.test(err.message || "")) throw err;
            if (!(await confirm({ title: `Remove ${m.name}?`, body: err.message, confirmLabel: "Remove anyway", danger: true }))) return undefined;
            await data.guestsApi({ action: "removeMember", guestId: g.id, memberId: m.id, force: true });
          }
          toast(`${m.name} removed from the party.`, "success");
          await refresh();
        } else if (pa.dataset.pa === "attend") {
          const on = mid === "primary" ? g.attending === true : m?.attending === true;
          await data.guestsApi({ action: "setAttending", guestId: g.id, ...(mid === "primary" ? {} : { memberId: mid }), attending: !on });
          await refresh();
        }
      } catch (err) {
        toast(err.message || "Something went wrong", "danger");
      }
      return undefined;
    });
    paint();
  }

  // The full friendly link: https://{host}/w/{wedding}/invite/{private code}.
  async function copyLink(url, name, fresh = false, created = false) {
    if (await copyText(url)) toast(`Copied ✓ ${created ? "New invitation link" : fresh ? "New invitation link" : "Invitation link"} for ${name}${fresh ? " (the old one no longer works)" : ""}`, "success");
    // No clipboard access: show the link to copy by hand.
    else await formDialog({ title: `Invitation link for ${name}`, fields: [{ name: "url", label: "Copy this link", value: url }], submitLabel: "Done", onSubmit: () => true });
  }
  async function shareLink(url, name) {
    try {
      await navigator.share({ title: "Wedding invitation", text: `${name}, you're invited! Open your personal invitation to RSVP:`, url });
    } catch (err) {
      if (err?.name === "AbortError") return; // closed the share sheet
      await copyLink(url, name); // sharing not allowed here: copy instead
    }
  }
  const linkOf = async (g) => `${location.origin}${(await data.guestsApi({ action: "inviteLink", guestId: g.id })).path}`;
  // View: the invitation inside Luna, with an Owner-only bar.
  async function viewInvite(g) {
    const url = await linkOf(g);
    const token = url.split("/").pop();
    await preview({
      token,
      note: `${g.name}'s invitation (preview)`,
      actions: [{ id: "copy", label: "Copy guest link" }, ...(canShare() ? [{ id: "share", label: "Share" }] : []), { id: "open", label: "Open as guest ↗", href: url }],
      onAction: (id) => (id === "copy" ? copyLink(url, g.name) : id === "share" ? shareLink(url, g.name) : undefined),
    });
  }
  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el) || el.dataset.act === "export" || el.dataset.act === "invite-setup") return;
    const a = el.dataset.act;
    if (a.startsWith("role-")) {
      el.closest("details.line-menu")?.removeAttribute("open");
      try {
        if (a === "role-new") return after("Role assigned.")(await assignDialog(el.dataset.roleId || "", el.dataset.person || ""));
        const [key, pkey] = (el.dataset.id || "").split("|");
        const pp = peopleOf(state.rows).find((x) => x.key === pkey);
        const role = roleFromKey(key);
        if (!pp || !role) return undefined;
        const from = parsePersonKey(pp.key);
        const fromArgs = { fromGuestId: from.guestId, ...(from.memberId ? { fromMemberId: from.memberId } : {}) };
        if (a === "role-remove") {
          if (!(await confirm({ title: `Remove ${roleLabel(role)} from ${pp.name}?`, body: "Only the role is removed. The guest, their RSVP, seats and table stay.", confirmLabel: "Remove role", danger: true }))) return undefined;
          return after("Role removed.")(await data.guestsApi({ action: "unassignRole", ...target(pp.key), role }));
        }
        if (a === "role-person") {
          return after("Role moved.")(await formDialog({ title: `${roleLabel(role)}: change person`, fields: [{ name: "guestId", label: "Person", type: "select", options: personOptions(pp.key), value: "" }], submitLabel: "Change", onSubmit: (v) => {
            if (!v.guestId) return Promise.reject(new Error("Choose a person"));
            const to = parsePersonKey(v.guestId);
            return data.guestsApi({ action: "moveRole", ...fromArgs, toGuestId: to.guestId, ...(to.memberId ? { toMemberId: to.memberId } : {}), role });
          } }));
        }
        if (a === "role-change") {
          return after("Role changed.")(await formDialog({ title: `${pp.name}: change role`, fields: [{ name: "role", label: "Role", type: "select", options: ROLE_OPTIONS, value: role.id }, { name: "customRole", label: "Custom role name", value: role.id === "custom" ? role.label : "", hint: "Only for Custom role." }], submitLabel: "Change", onSubmit: (v) => data.guestsApi({ action: "moveRole", ...fromArgs, role, toRole: roleOf(v) }) }));
        }
      } catch (err) {
        toast(err.message || "Something went wrong", "danger");
      }
      return undefined;
    }
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
      else if (a === "invite-create") {
        const r = await data.guestsApi({ action: "inviteLink", guestId: g.id });
        await copyLink(`${location.origin}${r.path}`, g.name, false, true);
        load();
      } else if (a === "invite-view") await viewInvite(g);
      else if (a === "invite-copy") await copyLink(await linkOf(g), g.name);
      else if (a === "invite-share") await shareLink(await linkOf(g), g.name);
      else if (a === "invite-new") {
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
