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
// 2026-10-25: invitations are sent from All Guests itself. Each party row
// has a second short line: Invitation link [Copy] (one tap; the link is made
// on first use) and Sent ▾ (setting the existing invitationSent date),
// then "RSVP received" once they answer. One link per PARTY (a +1 / +2
// never gets its own); the party's RSVP covers everyone invited.
// Owner-pilot second pass: the summary line, the RSVP | Seating switch,
// then Search + "RSVP: All ▾" on one line. A category header is just
// "FAMILY · 18/24" (people attending / invited). Each group's list scrolls
// inside its own box past ~6 rows, so one big category never takes over the
// page; ⋯ menus inside a scrolling box open as a floating layer. Downloads
// live under More.

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, skeleton, segmented } from "../../components/ui.js";
import { examplesState } from "../../components/examples.js";
import { formDialog } from "../../components/form-dialog.js";
import { confirmDialog, toast as defaultToast } from "../../components/feedback.js";
import { formatDayId } from "../../lib/format.js";
import { RSVP_STATUSES, businessDate, GUEST_SIDES, GUEST_CATEGORIES, GUEST_CATEGORY_IDS, rsvpSummary, seatingPlan, seatablePeople, seatsOf, MAX_TABLE_CAPACITY, setupMissing } from "@shared/index.js";
import { TRIAL_RSVP_LIMIT_MESSAGE } from "@shared/wedding.js";
import { activityLines, detailsDialog } from "../baby/common.js";
import * as defaultData from "./data.js";
import { openInvitePreview, copyText, canShare } from "./invitation/preview.js";
import { WEDDING_ROLES, WEDDING_ROLE_IDS, rolesPlan, roleLabel, roleKey, categoryForRole, peopleOf, peopleWithoutRole, parsePersonKey, personKey, membersOf, attendingNames } from "@shared/wedding-roles.js";
import { publicUrl } from "@shared/custom-links.js";

const SIDE_OPTIONS = Object.entries(GUEST_SIDES).map(([value, s]) => ({ value, label: s.label }));
// Simple words for the stored RSVP statuses.
export const RSVP_WORDS = { awaiting: "Waiting", attending: "Attending", declined: "Declined" };
const RSVP_TONE = { awaiting: "warning", attending: "success", declined: "" };
const CATEGORY_OPTIONS = Object.entries(GUEST_CATEGORIES).map(([value, c]) => ({ value, label: c.label }));
const FILTERS = [["all", "All"], ["awaiting", "Waiting"], ["attending", "Attending"], ["declined", "Declined"]];
const MAX_GUESTS = 1000;

const guestFields = (g = {}) => [
  { name: "name", label: "Guest or household", value: g.name ?? "", required: true, placeholder: "e.g. The Santos Family" },
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
  const state = { view: "rsvp", filter: "all", search: "", rows: [], totals: null, seating: null, loading: true, error: null, setupMissing: null, trialRsvp: null };
  let alive = true;
  // Free trial RSVP: "RSVP trial: 12 / 20" (the server decides; this only explains).
  const trial = session.subscription?.trial?.open === true;
  const overTrial = (g) => Boolean(trial && state.trialRsvp && g.invitation?.status !== "active" && state.trialRsvp.used + (g.partySize || 1) > state.trialRsvp.limit);
  const noteTrial = (r) => {
    if (r?.trialRsvp && trial) state.trialRsvp = r.trialRsvp;
    return r;
  };
  const refreshTrial = () =>
    data.guestsApi({ action: "trialRsvp" }).then((r) => {
      state.trialRsvp = r?.trialRsvp ?? null;
      draw();
    }, () => {});

  async function load() {
    state.loading = !state.rows.length;
    draw();
    try {
      const [totals, page, seating, setup, usage] = await Promise.all([data.getGuestTotals(businessId), data.listGuests(businessId, {}, { pageSize: MAX_GUESTS }), data.getSeating ? data.getSeating(businessId).catch(() => null) : null, canManage && data.getWeddingSetup ? data.getWeddingSetup().catch(() => null) : null, canManage && trial && data.guestsApi ? data.guestsApi({ action: "trialRsvp" }).catch(() => null) : null]);
      state.trialRsvp = usage?.trialRsvp ?? null;
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
  // yet), View / Copy / Regenerate (a link exists), or why not yet. During
  // the free trial up to 20 invited people get links (the server counts);
  // a party that doesn't fit any more waits, ready, for the upgrade.
  const inviteItems = (g) => {
    if (overTrial(g)) return [{ act: "invite-upgrade", id: g.id, href: "/subscription", label: "Upgrade to send this invitation →" }];
    if (state.setupMissing?.length) return [{ act: "invite-setup", id: g.id, href: "/wedding-setup", label: "Invitation: complete Wedding Setup first →" }];
    if (g.invitation?.status !== "active") return [{ act: "invite-create", id: g.id, label: "Create invitation link" }];
    return [{ act: "invite-view", id: g.id, label: "View invitation" }, { act: "invite-copy", id: g.id, label: "Copy invitation link" }, ...(canShare() ? [{ act: "invite-share", id: g.id, label: "Share invitation" }] : []), { act: "invite-new", id: g.id, label: "Regenerate link" }];
  };
  const guestMenu = (g) =>
    menu(`More for ${g.name}`, [
      ...(canManage && g.rsvp === "attending" && g.partySize > 1 ? [{ act: "count", id: g.id, label: "Change number attending" }] : []),
      ...(canManage ? [{ act: "edit", id: g.id, label: "Edit" }] : []),
      ...(canManage ? inviteItems(g) : []),
      { act: "view", id: g.id, label: "Details" },
      { act: "history", id: g.id, label: "View history" },
      ...(canManage ? [{ act: "remove", id: g.id, label: "Remove guest", danger: true, sep: true }] : []),
    ]);
  // People of this party at a table (per-person seating).
  const seatedOf = (g) => {
    const can = new Set(seatablePeople(g).map((p) => p.key));
    const live = state.seating?.tables || {};
    return Object.entries(seatsOf(g)).filter(([k, t]) => can.has(k) && live[t]).length;
  };
  // One row per party: name, then a quiet line (side · invited · +N allowed /
  // attending · seated); RSVP and ⋯ on the right; then the invitation line.
  const openSeats = (g) => Math.max(0, (g.partySize || 1) - 1 - membersOf(g).length);
  const rowSub = (g) =>
    [
      GUEST_SIDES[g.side]?.label ?? "",
      `${g.partySize || 1} invited`,
      g.rsvp === "attending" ? `${g.confirmed} attending` : g.rsvp === "declined" ? "declined" : openSeats(g) ? `+${openSeats(g)} allowed` : "",
      g.rsvp === "attending" ? `${seatedOf(g)} seated` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  // Invitation link [Copy] · Sent ▾ (· RSVP received), right on the row.
  const inviteLine = (g) => {
    if (!canManage) return "";
    if (state.setupMissing?.length) return "";
    if (overTrial(g)) return html`<div class="wl-invite" data-role="invite-line"><span>Not sent · RSVP trial full</span><a class="btn btn-compact" href="/subscription" data-link data-role="trial-upgrade">Upgrade</a></div>`;
    const sent = Boolean(g.invitationSent);
    return html`<div class="wl-invite" data-role="invite-line"><span>Invitation link</span><button type="button" class="btn btn-compact" data-act="invite-copy-row" data-id="${g.id}" aria-label="Copy ${g.name}'s invitation link">Copy</button>
      <select class="select select-compact" data-role="sent" data-id="${g.id}" aria-label="Invitation sent to ${g.name}"><option value="" ${sent ? "" : "selected"}>Not sent</option><option value="sent" ${sent ? "selected" : ""}>${sent ? `Sent ✓ ${formatDayId(g.invitationSent)}` : "Sent ✓"}</option></select>
      ${g.rsvp !== "awaiting" ? html`<span class="wl-invite-done" data-role="rsvp-received">RSVP received</span>` : ""}</div>`;
  };
  const rsvpRow = (g) => html`<li class="wl-row wl-guest${canManage && !state.setupMissing?.length ? " has-invite" : ""}" data-guest="${g.id}"><button type="button" class="wl-main" data-act="view" data-id="${g.id}"><span class="wl-name">${g.name}</span>${rowSub(g) ? html`<span class="wl-sub" data-role="guest-sub">${rowSub(g)}</span>` : ""}</button>${seats(g)}${rsvpControl(g)}${guestMenu(g)}${inviteLine(g)}</li>`;

  const shown = () => {
    const q = state.search.toLowerCase();
    return state.rows.filter((g) => (state.filter === "all" || g.rsvp === state.filter) && (!q || g.name.toLowerCase().includes(q)));
  };

  function rsvpView() {
    const list = shown();
    const groups = groupGuests(list);
    if (!state.rows.length)
      return examplesState({
        title: "No guests yet",
        body: "Here's how your list will look:",
        items: [
          { name: "The Prado Family", sub: "Groom's side · 4 invited · 3 attending" },
          { name: "Carlo Prado", sub: "Both / Mutual · 2 invited · +1 allowed" },
          { name: "Anna Santos", sub: "Bride's side · 1 invited · Waiting for RSVP" },
        ],
        add: canManage ? { act: "new", label: "+ Add Guest" } : null,
        helper: "Add individuals, couples or families. You can assign roles and tables later.",
        role: "guest-examples",
      });
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

  // Seating (2026-10-21): one row per confirmed PERSON. Unassigned people
  // are grouped by party (the party name quiet); each table lists its people.
  // Counts are people, never parties.
  const personId = (p) => `${p.guestId}|${p.key}`;
  const partyNote = (p) => (p.primary && p.guest.partySize <= 1 ? "" : `${p.party}'s party`);
  function seatingView() {
    const plan = seatingPlan(state.rows, state.seating);
    const personRow = (p, table) =>
      html`<li class="wl-row wl-guest wl-seat" data-person="${personId(p)}"><button type="button" class="wl-main" data-act="view" data-id="${p.guestId}"><span class="wl-name">${p.name}</span>${table && partyNote(p) ? html`<span class="wl-sub" data-role="party">${partyNote(p)}</span>` : ""}</button>${!canManage
        ? ""
        : table
          ? menu(`Seating for ${p.name}`, [{ act: "seat-person", id: personId(p), label: "Move to another table" }, { act: "unseat-person", id: personId(p), label: "Unassign" }])
          : html`<button type="button" class="btn btn-compact" data-act="seat-person" data-id="${personId(p)}">Assign</button>`}</li>`;
    return html`
      <section class="wl-section" data-group="unassigned">
        <h2 class="wl-cat-head"><span class="wl-group-title">Unassigned</span><span class="wl-cat-counts">· ${fmt(plan.unassignedSeats)}</span></h2>
        ${plan.unassigned.length
          ? plan.unassigned.map((u) => html`<div class="wl-party-group" data-party="${u.guest.id}"><p class="wl-party-label" data-role="party-label">${u.guest.name}'s party</p><ul class="wl-list" data-role="unassigned">${u.people.map((p) => personRow(p, null))}</ul></div>`)
          : html`<p class="stat-hint wl-none">${plan.attendingSeats ? "Everyone attending has a table." : "Guests appear here once they're attending."}</p>`}
      </section>
      ${plan.tables.length
        ? plan.tables.map(
            (t) => html`<section class="wl-section" data-table="${t.id}">
              <div class="wl-head"><h2 class="wl-cat-head"><span class="wl-group-title">${t.name}</span><span class="wl-cat-counts ${t.used > t.capacity ? "is-over" : t.used === t.capacity ? "is-full" : ""}" data-role="table-seats" title="people seated / seats">· ${t.used}/${t.capacity}${t.used > t.capacity ? ` · over by ${t.used - t.capacity}` : t.used === t.capacity ? " · full" : ""}</span></h2>${canManage ? menu(`Table ${t.name}`, [{ act: "table-edit", id: t.id, label: "Rename / change seats" }, { act: "table-delete", id: t.id, label: "Delete table", danger: true, sep: true }]) : ""}</div>
              ${t.people.length ? html`<ul class="wl-list" data-role="table-guests">${t.people.map((p) => personRow(p, t))}</ul>` : html`<p class="stat-hint wl-none">No one yet.</p>`}
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

  // "RSVP trial: 12 / 20"; at the limit, why and the two plans (no popup).
  const trialLine = () => {
    const u = state.trialRsvp;
    if (!trial || !u) return "";
    if (u.used < u.limit) return html`<p class="wl-count wl-trial" data-role="trial-rsvp">RSVP trial: ${fmt(u.used)} / ${fmt(u.limit)}</p>`;
    return html`<div class="banner banner-info" role="note" data-role="trial-rsvp-full"><span>RSVP trial: ${fmt(u.used)} / ${fmt(u.limit)}. ${TRIAL_RSVP_LIMIT_MESSAGE}</span> <a class="btn btn-compact" href="/subscription" data-link>₱499 — 3 Months · ₱799 — 6 Months</a></div>`;
  };

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
            : html`<p class="wl-count" data-role="rsvp-summary" title="People (seats), not invitations">${fmt(t.invitedSeats)} invited · ${fmt(t.attendingSeats)} attending · ${fmt(seatingPlan(state.rows, state.seating).seatedSeats)} seated</p>${trialLine()}`}
        <div class="wl-tools">${segmented("view", [["rsvp", "All Guests"], ["seating", "Seating"], ["roles", "Roles"]], state.view, { label: "Guests view" })}</div>
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
  // The person behind a Seating row ("guestId|seatKey") and their table now.
  const personOf = (id) => {
    const [guestId, key] = String(id || "").split("|");
    const g = state.rows.find((r) => r.id === guestId);
    const p = g ? seatablePeople(g).find((x) => x.key === key) : null;
    return p ? { ...p, guestId, guest: g, tableId: seatsOf(g)[key] ?? null } : null;
  };
  const seatPersonDialog = (p) => {
    const list = tables().filter((t) => t.id !== p.tableId);
    if (!list.length) {
      toast(tables().length ? "There's no other table yet." : "Add a table first (+ Add table).", "danger");
      return null;
    }
    const room = (t) => t.capacity - t.used;
    return formDialog({
      title: `${p.tableId ? "Move" : "Seat"} ${p.name}`,
      intro: p.primary && p.guest.partySize <= 1 ? "" : `${p.guest.name}'s party`,
      fields: [{ name: "tableId", label: "Table", type: "select", options: list.map((t) => ({ value: t.id, label: `${t.name} · ${t.used}/${t.capacity}${room(t) < 1 ? " · full" : ""}` })), value: list.find((t) => room(t) > 0)?.id ?? list[0].id }],
      submitLabel: p.tableId ? "Move" : "Assign",
      onSubmit: (v) => data.guestsApi({ action: "seatPerson", guestId: p.guestId, seatKey: p.key, tableId: v.tableId }),
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

  // The guest's history (every change, kept): behind ⋯ → View history, not
  // in the Details sheet.
  function openHistory(g) {
    detailsDialog({ title: `${g.name}: history`, rows: [], sections: [{ key: "history", title: "History", lines: activityLines(g.history || [], timezone), empty: "No changes recorded yet." }] });
  }

  // Details = the party sheet (2026-10-21, decluttered): name + RSVP on top,
  // invited / attending, the people (each with their table; rename / remove
  // behind a small ⋯; mark who's attending), then Category, Role, RSVP date,
  // Side, Invitation sent and the invitation link with direct View / Copy.
  // History: ⋯ → View history. Read-only without guests.manage.
  function openView(g0) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop is-panel";
    document.body.appendChild(backdrop);
    const close = () => backdrop.remove();
    let g = g0;
    const paint = () => {
      const members = membersOf(g);
      const seats = g.partySize || 1;
      const unnamed = Math.max(0, seats - 1 - members.length);
      const attendingOn = canManage && g.rsvp === "attending";
      const rolesTxt = (roles) => (Array.isArray(roles) && roles.length ? roles.map((r) => roleLabel(r)).join(", ") : "");
      const markBtn = (mid, on) => (attendingOn ? html`<button type="button" class="btn btn-compact btn-ghost wl-mark${on ? " is-on" : ""}" data-pa="attend" data-mid="${mid}" aria-pressed="${on ? "true" : "false"}">${on ? "Attending ✓" : "Mark attending"}</button>` : on && g.rsvp === "attending" ? html`<span class="wl-chip" data-tone="success">Attending</span>` : "");
      // Where each person sits (per person), and who can be seated now.
      const plan = tables();
      const tableNames = new Map(plan.map((t) => [t.id, t.name]));
      const where = seatsOf(g);
      const seatable = new Set(seatablePeople(g).map((p) => p.key));
      const tableOf = (key) => (where[key] && tableNames.has(where[key]) ? tableNames.get(where[key]) : null);
      // One person: NAME first (bold; tap it or ✎ to edit), then quiet
      // details (Primary · roles), then the table and role controls.
      const nameEl = (name, pa, attrs = {}) =>
        canManage
          ? html`<button type="button" class="wl-person-name" data-pa="${pa}" data-mid="${attrs.mid ?? ""}" data-slot="${attrs.slot ?? ""}" aria-label="Edit name: ${name}"><span data-role="person-name">${name}</span><span class="wl-edit" aria-hidden="true">✎</span></button>`
          : html`<span class="wl-person-name"><span data-role="person-name">${name}</span></span>`;
      // Roles stay on the person: chips (tap to remove) and + Role, right here.
      const roleChips = (roles, mid) =>
        canManage
          ? html`${(roles || []).map((r) => html`<button type="button" class="wl-role-chip" data-pa="role-remove" data-mid="${mid}" data-key="${roleKey(r)}" aria-label="Remove role ${roleLabel(r)}">${roleLabel(r)}</button>`)}<button type="button" class="wl-role-chip is-add" data-pa="role-add" data-mid="${mid}">+ Role</button>`
          : rolesTxt(roles);
      // Table: a picker right on the person (no dialog); full tables can't be chosen.
      const tablePick = (key) =>
        canManage && seatable.has(key) && plan.length
          ? html`<label class="wl-table-pick"><span class="visually-hidden">Table for this person</span><select class="select select-compact" data-pa="table" data-key="${key}" aria-label="Table"><option value="" ${where[key] ? "" : "selected"}>Not seated</option>${plan.map((t) => html`<option value="${t.id}" ${where[key] === t.id ? "selected" : ""} ${t.used >= t.capacity && where[key] !== t.id ? "disabled" : ""}>${t.name} · ${t.used}/${t.capacity}${t.used >= t.capacity && where[key] !== t.id ? " · full" : ""}</option>`)}</select></label>`
          : "";
      const details = (parts) => (parts.filter(Boolean).length ? html`<span class="wl-person-meta" data-role="member-meta">${parts.filter(Boolean).join(" · ")}</span>` : "");
      const tools = (key, roles, mid) => {
        const t = tablePick(key);
        const r = canManage && mid !== null ? roleChips(roles, mid) : "";
        return t || r ? html`<div class="wl-person-tools" data-role="person-tools">${r}${t}</div>` : "";
      };
      const personRow = (key, name, actions) => html`<li class="wl-member" data-member="${key}"><div class="wl-person">${name}</div><div class="wl-person-actions">${actions}</div></li>`;
      // ⋯ only for the less common / destructive action.
      const memberMenu = (m) => (canManage ? menu(`More for ${m.name}`, [{ act: "member-remove", id: m.id, label: "Remove from party", danger: true }]) : "");
      const linkCell = () => {
        if (!canManage) return g.invitation?.status === "active" ? "Created" : "Not created yet";
        if (overTrial(g)) return html`<a class="btn btn-compact btn-ghost" href="/subscription" data-link data-act="close">Upgrade to send</a>`;
        if (state.setupMissing?.length) return html`<a class="btn btn-compact btn-ghost" href="/wedding-setup" data-link data-act="close">Complete Wedding Setup first</a>`;
        if (g.invitation?.status !== "active") return html`<button type="button" class="btn btn-compact" data-act="invite-create">Create link</button>`;
        return html`<span class="wl-link-actions" data-role="link-actions"><button type="button" class="btn btn-compact" data-act="invite-view">View</button><button type="button" class="btn btn-compact" data-act="invite-copy">Copy</button></span>`;
      };
      // RSVP, managed here: status, and how many when attending.
      const rsvpCell = canManage
        ? html`<span class="wl-rsvp-cell"><select class="select select-chip wl-status" data-pa="rsvp" data-role="details-rsvp" data-tone="${RSVP_TONE[g.rsvp] || ""}" aria-label="RSVP for ${g.name}">${Object.keys(RSVP_STATUSES).map((k) => html`<option value="${k}" ${k === g.rsvp ? "selected" : ""}>${RSVP_WORDS[k]}</option>`)}</select>${g.rsvp === "attending" && seats > 1 ? html`<button type="button" class="btn btn-compact btn-ghost" data-pa="count" data-role="rsvp-count">${g.confirmed} of ${seats} · Change</button>` : ""}</span>`
        : html`<span class="wl-chip" data-tone="${RSVP_TONE[g.rsvp] || ""}" data-role="details-rsvp">${RSVP_WORDS[g.rsvp] ?? g.rsvp}</span>`;
      const headMenu = canManage ? menu(`More for ${g.name}`, [{ act: "details-history", id: g.id, label: "View history" }, { act: "details-remove", id: g.id, label: "Remove guest", danger: true, sep: true }]) : menu(`More for ${g.name}`, [{ act: "details-history", id: g.id, label: "View history" }]);
      const rows = [["Category", GUEST_CATEGORIES[g.category]?.label ?? "Not set"], ["Role", rolesTxt(g.roles) || "—"], ["RSVP date", g.rsvpDate ? formatDayId(g.rsvpDate) : "—"], ["Side", GUEST_SIDES[g.side]?.label ?? "—"], ["Invitation sent", g.invitationSent ? formatDayId(g.invitationSent) : "Not sent"], ["Invitation link", linkCell()], ...(g.rsvpMeal ? [["Meal", g.rsvpMeal]] : []), ...(g.rsvpNote ? [["Dietary note", g.rsvpNote]] : [])];
      render(
        backdrop,
        html`<div class="modal modal-wide" role="dialog" aria-modal="true" aria-label="${g.name}" data-role="details">
          <div class="modal-header wl-details-head"><h2 class="card-title">${seats > 1 ? `${g.name}'s Party` : g.name}</h2><div class="page-actions">${headMenu}</div></div>
          <div class="modal-body">
            <div class="wl-rsvp-row" data-role="details-rsvp-row"><span class="wl-rsvp-label">RSVP</span>${rsvpCell}</div>
            <dl class="dl dl-compact" data-role="party-figures"><dt>Invited</dt><dd>${seats}</dd><dt>Attending</dt><dd>${g.rsvp === "attending" ? String(g.confirmed) : g.rsvp === "declined" ? "0" : "Waiting"}</dd></dl>
            <h3 class="section-title">${seats > 1 ? "Members" : "Guest"}</h3>
            <ul class="list wl-party" data-role="members">
              ${personRow("primary", html`${nameEl(g.name, "name-primary")}${details(["Primary", canManage ? "" : rolesTxt(g.roles), canManage && seatable.has("primary") && plan.length ? "" : tableOf("primary")])}${tools("primary", g.roles, "primary")}`, markBtn("primary", g.attending === true))}
              ${members.map((m) => personRow(m.id, html`${nameEl(m.name, "name-member", { mid: m.id })}${details([canManage ? "" : rolesTxt(m.roles), canManage && seatable.has(m.id) && plan.length ? "" : tableOf(m.id)])}${tools(m.id, m.roles, m.id)}`, html`${markBtn(m.id, m.attending === true)}${memberMenu(m)}`))}
              ${Array.from({ length: Math.min(unnamed, 12) }, (_, i) => personRow(`u${i + 1}`, html`${nameEl(`Member ${members.length + 2 + i}`, "name-unnamed", { slot: i + 1 })}${details([canManage && seatable.has(`u${i + 1}`) && plan.length ? "" : tableOf(`u${i + 1}`)])}${tools(`u${i + 1}`, [], null)}`, ""))}
            </ul>
            ${canManage ? html`<p class="stat-hint">Tap a name to edit it. Names are optional: the RSVP works by seat count.</p>` : ""}
            <dl class="dl dl-compact wl-details" data-role="fields">${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
          </div>
          <div class="modal-footer">${canManage ? html`<button type="button" class="btn" data-act="edit">Edit</button>` : ""}<button type="button" class="btn" data-act="close">Close</button></div>
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
    backdrop.addEventListener("change", async (ev) => {
      const el = ev.target;
      try {
        if (el.dataset?.pa === "table") {
          await data.guestsApi({ action: "seatPerson", guestId: g.id, seatKey: el.dataset.key, tableId: el.value || null });
          await refresh();
        } else if (el.dataset?.pa === "rsvp") {
          const status = el.value;
          const r = status === "attending" && (g.partySize || 1) > 1 ? await rsvpDialog(g, "attending") : await data.guestsApi({ action: "setRsvp", guestId: g.id, rsvp: status === "attending" ? { status, confirmed: g.partySize || 1 } : { status } });
          if (r?.unseated?.length) toast(`RSVP saved. Seats freed: ${r.unseated.join(", ")}.`, "success");
          await refresh();
        }
      } catch (err) {
        toast(err.message || "Something went wrong", "danger");
        await refresh();
      }
    });
    backdrop.addEventListener("click", async (ev) => {
      const actEl = ev.target.closest("[data-act]");
      const act = actEl?.dataset.act;
      const memberAct = act === "member-remove" ? "remove" : null;
      const pa = memberAct ? { dataset: { pa: memberAct, mid: actEl.dataset.id } } : ev.target.closest("[data-pa]");
      if (ev.target === backdrop || act === "close") return close();
      try {
        if (act === "invite-view") return viewInvite(g);
        if (act === "invite-copy") return copyLink(await linkOf(g), g.name);
        if (act === "invite-create") {
          const r = noteTrial(await data.guestsApi({ action: "inviteLink", guestId: g.id }));
          await copyLink(publicUrl(session, r.path), g.name, false, true);
          return refresh();
        }
        if (act === "edit") {
          close();
          return after("Saved.")(await editDialog(g));
        }
        if (act === "details-remove") {
          if (await removeGuest(g)) close();
          return undefined;
        }
        if (act === "details-history") return openHistory(g);
        if (!pa) return undefined;
        const mid = pa.dataset.mid;
        const m = membersOf(g).find((x) => x.id === mid);
        const who = (id) => (id && id !== "primary" ? { guestId: g.id, memberId: id } : { guestId: g.id });
        if (pa.dataset.pa === "count") {
          const r = await rsvpDialog(g);
          if (r) {
            if (r.unseated?.length) toast(`Seats freed: ${r.unseated.join(", ")}.`, "success");
            await refresh();
          }
          return undefined;
        }
        if (pa.dataset.pa === "role-add") {
          const name = mid === "primary" ? g.name : m?.name;
          const r = await formDialog({ title: `Role for ${name}`, fields: [{ name: "role", label: "Role", type: "select", options: ROLE_OPTIONS, value: "maid_of_honor" }, { name: "customRole", label: "Custom role name", value: "", hint: "Only for Custom role." }], submitLabel: "Add role", onSubmit: (v) => data.guestsApi({ action: "assignRole", ...who(mid), role: roleOf(v) }) });
          if (r) await refresh();
          return undefined;
        }
        if (pa.dataset.pa === "role-remove") {
          const roles = mid === "primary" ? g.roles : m?.roles;
          const role = (roles || []).find((r) => roleKey(r) === pa.dataset.key);
          const name = mid === "primary" ? g.name : m?.name;
          if (!role || !(await confirm({ title: `Remove ${roleLabel(role)} from ${name}?`, body: "Only the role is removed. The guest, their RSVP, seat and table stay.", confirmLabel: "Remove role", danger: true }))) return undefined;
          await data.guestsApi({ action: "unassignRole", ...who(mid), role });
          await refresh();
          return undefined;
        }
        // Edit a name here (the seat, roles and RSVP stay with the person).
        const editName = (current, onSave) => formDialog({ title: "Edit name", fields: [{ name: "name", label: "Member name", value: current, required: true, placeholder: "e.g. Mayet" }], submitLabel: "Save", cancelLabel: "Cancel", onSubmit: (v) => (v.name.trim() === current ? { unchanged: true } : onSave(v.name.trim())) });
        if (pa.dataset.pa === "name-primary") {
          if (await editName(g.name, (name) => data.guestsApi({ action: "update", guestId: g.id, expectedRevision: g.revision, changes: { name } }))) await refresh();
        } else if (pa.dataset.pa === "name-member" && m) {
          if (await editName(m.name, (name) => data.guestsApi({ action: "renameMember", guestId: g.id, memberId: m.id, name }))) await refresh();
        } else if (pa.dataset.pa === "name-unnamed") {
          // "Member 4" gets a real name: that person (and their table) is named.
          if (await editName("", (name) => data.guestsApi({ action: "addMember", guestId: g.id, name, seatKey: `u${pa.dataset.slot}` }))) await refresh();
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
        if (err?.code === "trial-rsvp-limit") refreshTrial();
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
  const linkOf = async (g) => publicUrl(session, noteTrial(await data.guestsApi({ action: "inviteLink", guestId: g.id })).path);
  // One tap: the party's private link (made on first use) straight to the
  // clipboard. The copy starts inside the tap (Safari needs that), with the
  // link arriving a moment later; no clipboard = a small sheet to copy it.
  async function copyRowLink(g) {
    const url = linkOf(g);
    let ok = false;
    try {
      if (globalThis.ClipboardItem && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": url.then((u) => new Blob([u], { type: "text/plain" })) })]);
        ok = true;
      }
    } catch {
      ok = false;
    }
    const link = await url;
    if (!ok) ok = await copyText(link);
    if (ok) toast(`Link copied: ${g.name}`, "success");
    else await formDialog({ title: `Invitation link for ${g.name}`, fields: [{ name: "url", label: "Copy this link", value: link }], submitLabel: "Done", onSubmit: () => true });
    if (g.invitation?.status !== "active") load();
  }
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
    if (a === "seat-person" || a === "unseat-person") {
      const p = personOf(el.dataset.id);
      if (!p) return;
      try {
        if (a === "unseat-person") after(`${p.name} unassigned.`)(await data.guestsApi({ action: "seatPerson", guestId: p.guestId, seatKey: p.key, tableId: null }));
        else after(p.tableId ? `${p.name} moved.` : `${p.name} seated.`)(await seatPersonDialog(p));
      } catch (err) {
        toast(err.message || "Something went wrong", "danger");
      }
      return;
    }
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
      else if (a === "count") {
        const r = await rsvpDialog(g);
        after(r?.unseated?.length ? `RSVP saved. Seats freed: ${r.unseated.join(", ")}.` : "RSVP saved.")(r);
      }
      else if (a === "history") openHistory(g);
      else if (a === "invite-create") {
        const r = noteTrial(await data.guestsApi({ action: "inviteLink", guestId: g.id }));
        await copyLink(publicUrl(session, r.path), g.name, false, true);
        load();
      } else if (a === "invite-copy-row") await copyRowLink(g);
      else if (a === "invite-view") await viewInvite(g);
      else if (a === "invite-copy") await copyLink(await linkOf(g), g.name);
      else if (a === "invite-share") await shareLink(await linkOf(g), g.name);
      else if (a === "invite-new") {
        if (!(await confirm({ title: `New invitation link for ${g.name}?`, body: "The link you sent before stops working. Send them the new one.", confirmLabel: "Make a new link" }))) return;
        const r = await data.guestsApi({ action: "regenerateInvite", guestId: g.id });
        await copyLink(publicUrl(session, r.path), g.name, true);
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
      if (err?.code === "trial-rsvp-limit") refreshTrial();
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
    if (el.dataset?.role === "sent" && container.contains(el)) {
      const g = state.rows.find((r) => r.id === el.dataset.id);
      if (!g) return;
      const invitationSent = el.value === "sent" ? g.invitationSent || businessDate(timezone || "Asia/Manila") : null;
      el.disabled = true;
      try {
        await data.guestsApi({ action: "update", guestId: g.id, expectedRevision: g.revision, changes: { invitationSent } });
        toast(invitationSent ? `Marked sent: ${g.name}` : `Marked not sent: ${g.name}`, "success");
      } catch (err) {
        toast(err.message || "Something went wrong", "danger");
      }
      load();
      return;
    }
    if (el.dataset?.role !== "rsvp" || !container.contains(el)) return;
    const g = state.rows.find((r) => r.id === el.dataset.id);
    if (!g) return;
    const status = el.value;
    try {
      if (status === "attending" && g.partySize > 1) {
        el.value = g.rsvp;
        const r = await rsvpDialog(g);
        after(r?.unseated?.length ? `RSVP saved. Seats freed: ${r.unseated.join(", ")}.` : "RSVP saved.")(r);
        return;
      }
      el.disabled = true;
      const r = await data.guestsApi({ action: "setRsvp", guestId: g.id, rsvp: status === "attending" ? { status, confirmed: g.partySize } : { status } });
      after(r?.unseated?.length ? `RSVP saved. Seats freed: ${r.unseated.join(", ")}.` : "RSVP saved.")(r || {});
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
  // ⋯ menus (also inside the scrolling lists) are placed, kept clear of the
  // bottom tabs and closed on scroll by components/menus.js.
  container.addEventListener("click", onClick);
  container.addEventListener("change", onChange);
  container.addEventListener("input", onInput);
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
    container.removeEventListener("change", onChange);
    container.removeEventListener("input", onInput);
  };
}
