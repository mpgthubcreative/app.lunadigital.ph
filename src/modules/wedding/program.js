// Music & Program (Owner-pilot Bridal; More → Music & Program): what happens
// next in the wedding, and what song plays.
//   Ceremony | Reception                    (like RSVP | Seating)
//   My Program | Sample Program
//   Moment | Song | Duration | ⋯            one line; long names truncate
// One + Add (Add ceremony moment / Add program item). Person / group and
// notes live in the form (More options), not on the row. Order matters:
// ⋯ Move up / Move down (no drag needed). Sample Program suggests common
// moments with no songs; + Add puts one on the couple's program. Saved
// through /api/wedding-program (tasks.manage edits; tasks.view reads).

import { html, render } from "../../lib/html.js";
import { pageHeader, emptyState, skeleton, segmented } from "../../components/ui.js";
import { formDialog } from "../../components/form-dialog.js";
import { toast as defaultToast, confirmDialog } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { PROGRAM_SECTIONS, SAMPLE_PROGRAM, parseDuration, formatDuration, programSection } from "@shared/wedding-program.js";
import { sampleKey } from "@shared/wedding-samples.js";
import { sampleList, sampleItem } from "./samples.js";
import { detailsDialog } from "../baby/common.js";

const SECTION_OPTIONS = Object.entries(PROGRAM_SECTIONS).map(([value, s]) => ({ value, label: s.label }));

// Moment, Song, Duration up front; Part, Person / group and Notes under More options.
export const programFields = (i = {}, section) => [
  { name: "moment", label: "Moment", value: i.moment ?? "", required: true, placeholder: section === "ceremony" ? "e.g. Bride entrance" : "e.g. First dance" },
  { name: "song", label: "Song", value: i.song ?? "", placeholder: "Title – artist (optional)" },
  { name: "duration", label: "Duration", value: Number.isSafeInteger(i.durationSec) ? formatDuration(i.durationSec) : "", placeholder: "e.g. 4:17", inputmode: "numeric", hint: "Optional. Minutes:seconds, or 1:00:00 for a long playlist." },
  ...(i.id ? [{ name: "section", label: "Part", type: "select", options: SECTION_OPTIONS, value: i.section, more: true, default: true }] : []),
  { name: "person", label: "Person / group", value: i.person ?? "", placeholder: "e.g. Entourage, Ninong & Ninang", more: true },
  { name: "notes", label: "Notes", type: "textarea", value: i.notes ?? "", more: true },
];
export function toProgramInput(v) {
  return { moment: v.moment.trim(), song: (v.song || "").trim() || null, durationSec: parseDuration(v.duration), person: (v.person || "").trim() || null, notes: (v.notes || "").trim() || null };
}

export function mount(container, session, { api = defaultApi, toast = defaultToast, confirm = confirmDialog } = {}) {
  const canManage = session.member.permissions["tasks.manage"] === true;
  const state = { section: "ceremony", mode: "mine", items: [], loading: true, error: null };
  let alive = true;
  const call = (body) => api("wedding-program", { method: "POST", body });

  async function load() {
    try {
      state.items = (await call({ action: "list" })).items || [];
      state.error = null;
    } catch (err) {
      state.error = err.message || "Couldn't load the program.";
    }
    state.loading = false;
    draw();
  }

  const menu = (label, items) =>
    html`<details class="line-menu"><summary class="btn btn-compact btn-ghost" aria-label="${label}">⋯</summary><div class="line-menu-list" role="menu">${items.map((i) => html`${i.danger ? html`<div class="menu-sep" role="separator"></div>` : ""}<button type="button" class="menu-item${i.danger ? " menu-danger" : ""}" role="menuitem" data-act="${i.act}" data-id="${i.id}">${i.label}</button>`)}</div></details>`;
  const row = (it, n, count) =>
    html`<li class="wl-row wl-prog" data-item="${it.id}">
      <button type="button" class="wl-main wl-prog-main" data-act="open" data-id="${it.id}"><span class="wl-name wl-prog-moment">${it.moment}</span><span class="wl-prog-song${it.song ? "" : " is-quiet"}" data-role="song">${it.song || "—"}</span></button>
      <span class="wl-prog-dur" data-role="duration">${formatDuration(it.durationSec)}</span>
      ${menu(`More for ${it.moment}`, [
        ...(canManage ? [{ act: "edit", id: it.id, label: "Edit" }] : [{ act: "open", id: it.id, label: "Details" }]),
        ...(canManage && n > 0 ? [{ act: "up", id: it.id, label: "Move up" }] : []),
        ...(canManage && n < count - 1 ? [{ act: "down", id: it.id, label: "Move down" }] : []),
        ...(canManage ? [{ act: "delete", id: it.id, label: "Delete", danger: true }] : []),
      ])}
    </li>`;

  function body() {
    const list = programSection(state.items, state.section);
    const word = state.section === "ceremony" ? "ceremony moments" : "program items";
    if (state.mode === "sample") {
      return sampleList({
        groups: [{ id: state.section, label: PROGRAM_SECTIONS[state.section].label, items: SAMPLE_PROGRAM[state.section].map((title) => ({ title, optional: false })) }],
        added: new Set(list.map((i) => sampleKey(i.moment))),
        canAdd: canManage,
        role: "sample-program",
        intro: "Common moments, no songs attached. Tap + Add for what's in your wedding, then set the song.",
      });
    }
    if (!list.length) return emptyState({ iconName: "music", title: `No ${word} yet`, body: canManage ? "Tap + Add, or pick from the Sample Program." : "Nothing planned here yet." });
    return html`<ul class="wl-list wl-program" data-role="program">${list.map((it, n) => row(it, n, list.length))}</ul>`;
  }

  function draw() {
    if (!alive) return;
    render(
      container,
      html`
        ${pageHeader({ title: "Music & Program", actions: canManage ? html`<button type="button" class="btn btn-primary" data-act="new" aria-label="${state.section === "ceremony" ? "Add ceremony moment" : "Add program item"}">+ Add</button>` : "" })}
        <div class="wl-tools wl-prog-tools">${segmented("section", [["ceremony", "Ceremony"], ["reception", "Reception"]], state.section, { label: "Part of the wedding" })}${segmented("mode", [["mine", "My Program"], ["sample", "Sample Program"]], state.mode, { label: "Program view" })}</div>
        ${state.error ? emptyState({ title: "Couldn't load", body: state.error }) : state.loading ? skeleton(5) : body()}`
    );
  }

  const dialog = (it) =>
    formDialog({
      title: it ? `Edit: ${it.moment}` : state.section === "ceremony" ? "Add ceremony moment" : "Add program item",
      fields: programFields(it || {}, it?.section ?? state.section),
      moreLabel: "More options",
      submitLabel: it ? "Save" : "Add",
      onSubmit: (v) => {
        const input = toProgramInput(v);
        if (!it) return call({ action: "create", item: { section: state.section, ...input } });
        const next = { ...input, ...(v.section && v.section !== it.section ? { section: v.section } : {}) };
        const changes = Object.fromEntries(Object.entries(next).filter(([k, val]) => (it[k] ?? null) !== (val ?? null)));
        return Object.keys(changes).length ? call({ action: "update", itemId: it.id, changes }) : { unchanged: true };
      },
    });
  const after = (message) => (r) => {
    if (r && !r.unchanged) {
      toast(message, "success");
      load();
    }
  };

  const onClick = async (event) => {
    const el = event.target.closest("[data-act]");
    if (!el || !container.contains(el)) return;
    el.closest("details.line-menu")?.removeAttribute("open");
    const a = el.dataset.act;
    const it = state.items.find((x) => x.id === el.dataset.id);
    try {
      if (a === "seg") {
        state[el.dataset.seg === "section" ? "section" : "mode"] = el.dataset.value;
        draw();
      } else if (a === "new") after("Added.")(await dialog(null));
      else if (a === "sample-add") {
        const pick = sampleItem([{ id: state.section, items: SAMPLE_PROGRAM[state.section].map((title) => ({ title })) }], el);
        if (!pick) return;
        el.disabled = true;
        await call({ action: "create", item: { section: state.section, moment: pick.item.title } });
        toast(`Added to My Program: ${pick.item.title}`, "success");
        load();
      } else if (!it) return;
      else if (a === "open" || a === "edit") {
        if (canManage) after("Saved.")(await dialog(it));
        else detailsDialog({ title: it.moment, rows: [["Part", PROGRAM_SECTIONS[it.section].label], ["Song", it.song || "—"], ["Duration", formatDuration(it.durationSec)], ["Person / group", it.person], ["Notes", it.notes]], onAction: async () => false });
      } else if (a === "up" || a === "down") {
        await call({ action: "move", itemId: it.id, direction: a });
        load();
      } else if (a === "delete") {
        if (!(await confirm({ title: `Delete ${it.moment}?`, body: "It's removed from your program.", confirmLabel: "Delete", danger: true }))) return;
        await call({ action: "delete", itemId: it.id });
        toast("Deleted.", "success");
        load();
      }
    } catch (err) {
      toast(err.message || "Something went wrong", "danger");
    }
  };
  container.addEventListener("click", onClick);
  draw();
  load();
  return () => {
    alive = false;
    container.removeEventListener("click", onClick);
  };
}
