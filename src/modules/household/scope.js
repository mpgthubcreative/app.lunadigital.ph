// Household (2026-10-29): ONE employee + cutoff choice shared by Attendance
// & Pay, Payroll and Advances, so moving between them keeps "Loriza ·
// Oct 16–31" (or "Everyone · Oct 16–31") instead of resetting to the
// current period. A page's own ?staff= / ?period= link always wins.
//   staffId  undefined = not chosen yet · "" = Everyone · an id
//   period   { start, end } or null (the page's default: now)
// Kept for this tab (sessionStorage; memory when storage is blocked).

const KEY = "luna.household.scope";
let memory = {};

function read() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) || {};
  } catch {
    /* storage blocked: memory only */
  }
  return memory;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9]{8,40}$/;

export function getScope(businessId) {
  const s = read();
  if (s.businessId !== businessId) return { staffId: undefined, period: null };
  const period = s.period && DAY.test(s.period.start) && DAY.test(s.period.end) ? { start: s.period.start, end: s.period.end } : null;
  return { staffId: s.staffId === "" || ID.test(s.staffId || "") ? s.staffId : undefined, period };
}

// change: { staffId?, period? } (only what the page knows).
export function setScope(businessId, change) {
  const cur = getScope(businessId);
  const next = { businessId, staffId: "staffId" in change ? change.staffId : cur.staffId, period: "period" in change ? (change.period ? { start: change.period.start, end: change.period.end } : null) : cur.period };
  memory = next;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* memory only */
  }
}

export function clearScope() {
  memory = {};
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing kept */
  }
}
