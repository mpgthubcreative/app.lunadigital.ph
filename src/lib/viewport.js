// The visible screen while typing (2026-10-22; every workspace and the
// Super Admin console).
//
// iPhone Safari (and Android Chrome by default) keep the LAYOUT viewport
// when the on-screen keyboard opens: only window.visualViewport shrinks.
// Anything fixed and sized to the screen (the phone app frame, every dialog
// and sheet: inset 0 / 100dvh) then reaches under the keyboard, so its lower
// part (the last fields, Save / Cancel) sits behind the keyboard and can't
// be scrolled into reach.
//
// While a field has focus and the keyboard takes room, this sets on <html>:
//   .keyboard-open   --vv-top / --vv-height (the visible area, px)
// and the phone CSS (components.css, layout.css) fits the dialogs and the
// app frame to that area: header, scrolling body, footer above the
// keyboard. The focused field is scrolled into view inside its own
// scroller. Nothing changes on a desktop or when nobody is typing.

export const KEYBOARD_MIN = 150;
export const isTyping = (el) => Boolean(el?.matches?.('textarea, select, [contenteditable="true"], input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="file"], [type="range"], [type="color"])'));

export function installViewport(win = window) {
  const vv = win.visualViewport;
  const doc = win.document;
  if (!vv || !doc) return () => {};
  const root = doc.documentElement;
  let full = win.innerHeight;
  let width = win.innerWidth;
  let timer = null;
  const reveal = () => {
    const el = doc.activeElement;
    if (!isTyping(el) || !el.closest?.(".modal, .main-col")) return;
    win.requestAnimationFrame?.(() => el.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
  };
  const update = () => {
    if (win.innerWidth !== width) {
      // Rotated: measure again.
      width = win.innerWidth;
      full = win.innerHeight;
    }
    full = Math.max(full, win.innerHeight);
    const open = full - vv.height > KEYBOARD_MIN && isTyping(doc.activeElement);
    const was = root.classList.contains("keyboard-open");
    root.classList.toggle("keyboard-open", open);
    if (open) {
      root.style.setProperty("--vv-top", `${Math.max(0, Math.round(vv.offsetTop))}px`);
      root.style.setProperty("--vv-height", `${Math.round(vv.height)}px`);
      if (!was) reveal();
    } else if (was) {
      root.style.removeProperty("--vv-top");
      root.style.removeProperty("--vv-height");
    }
  };
  // The keyboard animates in after focus; measure again once it has.
  const later = (ms) => () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      update();
      reveal();
    }, ms);
  };
  const onFocusIn = later(60);
  const onFocusOut = later(120);
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  doc.addEventListener("focusin", onFocusIn);
  doc.addEventListener("focusout", onFocusOut);
  update();
  return () => {
    clearTimeout(timer);
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
    doc.removeEventListener("focusin", onFocusIn);
    doc.removeEventListener("focusout", onFocusOut);
    root.classList.remove("keyboard-open");
  };
}
