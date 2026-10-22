// @vitest-environment jsdom
// The on-screen keyboard (2026-10-22): while a field has focus and the
// visible viewport shrinks (iPhone Safari keeps the layout viewport),
// <html> gets .keyboard-open and the visible area (--vv-top / --vv-height)
// so dialogs and the phone frame fit above the keyboard.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installViewport, isTyping } from "../../src/lib/viewport.js";

function fakeWindow() {
  const vv = new EventTarget();
  Object.assign(vv, { height: 844, offsetTop: 0 });
  return { vv, win: { visualViewport: vv, document, innerHeight: 844, innerWidth: 390, requestAnimationFrame: (f) => f() } };
}
let stop = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div class="modal-backdrop"><div class="modal"><div class="modal-body"><input id="a" /><textarea id="b"></textarea><select id="c"><option>x</option></select><input id="d" type="checkbox" /></div></div></div>';
});
afterEach(() => {
  stop();
  vi.useRealTimers();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("style");
});
const root = () => document.documentElement;

describe("keyboard-aware viewport", () => {
  it("focus + the keyboard: .keyboard-open and the visible area; the focused field is scrolled into view; closing undoes it", () => {
    const { vv, win } = fakeWindow();
    stop = installViewport(win);
    const input = document.getElementById("a");
    input.scrollIntoView = vi.fn();
    input.focus();
    vv.height = 508; // iPhone keyboard up
    vv.offsetTop = 120; // Safari panned the page
    vv.dispatchEvent(new Event("resize"));
    expect(root().classList.contains("keyboard-open")).toBe(true);
    expect([root().style.getPropertyValue("--vv-top"), root().style.getPropertyValue("--vv-height")]).toEqual(["120px", "508px"]);
    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    // Moving to the last field while the keyboard stays: it's brought into view too.
    const last = document.getElementById("b");
    last.scrollIntoView = vi.fn();
    last.focus();
    vi.advanceTimersByTime(100);
    expect(last.scrollIntoView).toHaveBeenCalled();
    // Keyboard down.
    vv.height = 844;
    vv.offsetTop = 0;
    vv.dispatchEvent(new Event("resize"));
    expect(root().classList.contains("keyboard-open")).toBe(false);
    expect(root().style.getPropertyValue("--vv-height")).toBe("");
  });

  it("a smaller viewport without typing (toolbars, pinch) or a checkbox in focus isn't the keyboard", () => {
    const { vv, win } = fakeWindow();
    stop = installViewport(win);
    vv.height = 508;
    vv.dispatchEvent(new Event("resize"));
    expect(root().classList.contains("keyboard-open")).toBe(false);
    document.getElementById("d").focus();
    vv.dispatchEvent(new Event("resize"));
    expect(root().classList.contains("keyboard-open")).toBe(false);
    vv.height = 780; // just the toolbar
    document.getElementById("a").focus();
    vv.dispatchEvent(new Event("resize"));
    expect(root().classList.contains("keyboard-open")).toBe(false);
  });

  it("blur after typing: measured again shortly after, the class goes", () => {
    const { vv, win } = fakeWindow();
    stop = installViewport(win);
    const a = document.getElementById("a");
    a.focus();
    vv.height = 500;
    vv.dispatchEvent(new Event("resize"));
    expect(root().classList.contains("keyboard-open")).toBe(true);
    a.blur();
    vi.advanceTimersByTime(200);
    expect(root().classList.contains("keyboard-open")).toBe(false);
  });

  it("isTyping: text inputs, textareas and selects; not checkboxes, radios, files or buttons; no visualViewport = nothing to do", () => {
    const el = (h) => {
      const d = document.createElement("div");
      d.innerHTML = h;
      return d.firstElementChild;
    };
    expect(["<input>", '<input type="number">', "<textarea></textarea>", "<select></select>"].map((h) => isTyping(el(h)))).toEqual([true, true, true, true]);
    expect(['<input type="checkbox">', '<input type="radio">', '<input type="file">', "<button></button>"].map((h) => isTyping(el(h)))).toEqual([false, false, false, false]);
    expect(installViewport({ document })).toBeTypeOf("function");
  });
});
