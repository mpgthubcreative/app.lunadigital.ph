// Trial feedback and Reviews & Feedback (2026-10-21): the Owner's private
// feedback (rating, useful, improve, recommend, optional testimonial, the
// marketing permission unticked by default); Super Admin reviews it (New /
// Reviewed / Approved / Featured; Featured only with permission). Nothing
// becomes public by itself.

import { describe, it, expect, beforeEach } from "vitest";
import { buildWorld, request } from "../helpers/tenants.js";
import { createFeedbackHandler } from "../../netlify/functions/feedback.js";
import { createOperatorHandler } from "../../netlify/functions/operator.js";
import { createSessionHandler } from "../../netlify/functions/session.js";
import { ensureAuthUser, setOperator, createBusiness, addMember } from "../../netlify/functions/_lib/provisioning.js";
import { businessDate } from "../../shared/metrics.js";
import { newTrial, TRIAL_DAYS } from "../../shared/trial.js";
import { validateFeedback, FEEDBACK_PROMPT, MARKETING_PERMISSION_TEXT } from "../../shared/feedback.js";

const NOW = new Date();
const TODAY = businessDate("Asia/Manila", NOW);
const shift = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
let world, opUid;
const u = {};

beforeEach(async () => {
  world = await buildWorld();
  const op = await ensureAuthUser({ auth: world.auth, email: "ops@luna.test", name: "Ops" });
  await setOperator({ ...world, email: op.email, status: "active", reason: "test operator" });
  opUid = op.uid;
  for (const id of ["home-fb", "dist-fb"]) {
    await createBusiness({ ...world, name: id === "home-fb" ? "Santos Home" : "Reyes Trading", planId: id === "home-fb" ? "household-basic" : "distributor-basic", workspaceTemplateId: id === "home-fb" ? "household-payroll" : "distributor", businessId: id, trial: true, clock: NOW });
    const o = await ensureAuthUser({ auth: world.auth, email: `owner@${id}.test`, name: `Owner ${id}` });
    await addMember({ ...world, businessId: id, uid: o.uid, email: o.email, name: `Owner ${id}`, roleTemplate: "owner", isAccountOwner: true });
    u[id] = o.uid;
  }
  const m = await ensureAuthUser({ auth: world.auth, email: "mgr@dist-fb.test", name: "Manager" });
  await addMember({ ...world, businessId: "dist-fb", uid: m.uid, email: m.email, name: "Manager", roleTemplate: "manager" });
  u.manager = m.uid;
});

const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
const ok = (r, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const deps = () => ({ getAdmin: async () => world, now: () => NOW });
const send = async (bid, uid, body) => parse(await createFeedbackHandler(deps())({ ...request({ uid, businessId: bid, method: "POST" }), body: JSON.stringify(body) }));
const op = async (body) => parse(await createOperatorHandler(deps())({ ...request({ uid: opUid }), httpMethod: "POST", body: JSON.stringify(body) }));
const session = async (bid) => parse(await createSessionHandler(deps())({ ...request({ uid: u[bid], businessId: bid }), httpMethod: "GET" }));
// The trial's day today (1 = first day).
function onDay(bid, day) {
  const ref = `businesses/${bid}`;
  const b = world.db.docs.get(ref);
  world.db.docs.set(ref, { ...b, subscription: { ...b.subscription, ...newTrial(shift(TODAY, -(day - 1)), TRIAL_DAYS) } });
}
const FULL = { rating: 5, useful: "Payroll in two taps", improve: "A Tagalog option", recommend: "yes", testimonial: "Luna made paying Ate Loriza simple.", marketingPermission: true };

describe("the Day 21 prompt and Day 27 reminder (session)", () => {
  it("nothing before Day 21; the prompt on Day 21; a quiet reminder from Day 27; nothing once feedback is sent", async () => {
    onDay("home-fb", 20);
    expect(ok(await session("home-fb")).subscription.feedback).toMatchObject({ submitted: false, prompt: null });
    onDay("home-fb", 21);
    expect(ok(await session("home-fb")).subscription.feedback).toMatchObject({ prompt: "prompt", laterAt: null });
    ok(await send("home-fb", u["home-fb"], { action: "later" }));
    expect(ok(await session("home-fb")).subscription.feedback.laterAt).toBeTruthy();
    onDay("home-fb", 27);
    expect(ok(await session("home-fb")).subscription.feedback.prompt).toBe("reminder");
    ok(await send("home-fb", u["home-fb"], { action: "submit", feedback: { rating: 4, recommend: "maybe" } }), 201);
    expect(ok(await session("home-fb")).subscription.feedback).toMatchObject({ submitted: true, prompt: null });
    // The exact words.
    expect(FEEDBACK_PROMPT).toMatchObject({ title: "You’ve been using Luna for 3 weeks 💛", share: "Share feedback", later: "Maybe later" });
    expect(FEEDBACK_PROMPT.body).toBe("We’d love to know how Luna has been working for you. Your feedback helps us make Luna simpler and more useful. If you’d like to continue using Luna after your free trial, please take a minute to share your experience.");
  });
});

describe("the feedback form", () => {
  it("stores rating, useful, improve, recommend, testimonial; permission false unless ticked; once per workspace; the owner only; private (server-only collection)", async () => {
    expect(validateFeedback({ rating: 5, recommend: "yes", testimonial: "Nice" }).marketingPermission).toBe(false);
    expect(validateFeedback({ rating: 5, recommend: "yes", marketingPermission: true }).marketingPermission).toBe(false); // nothing to allow without a testimonial
    expect(MARKETING_PERMISSION_TEXT).toBe("I allow Luna Digital to use this testimonial on its website, social media and marketing materials.");
    for (const bad of [{ rating: 0, recommend: "yes" }, { rating: 6, recommend: "yes" }, { rating: 5, recommend: "sure" }, { rating: 5, recommend: "yes", secret: 1 }, { rating: 5, recommend: "yes", testimonial: "x".repeat(501) }]) {
      expect((await send("dist-fb", u["dist-fb"], { action: "submit", feedback: bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await send("dist-fb", u.manager, { action: "submit", feedback: FULL })).status).toBe(403);
    ok(await send("dist-fb", u["dist-fb"], { action: "submit", feedback: FULL }), 201);
    expect(world.db.docs.get("feedback/dist-fb")).toMatchObject({ businessId: "dist-fb", businessName: "Reyes Trading", productName: "Luna Distributor", rating: 5, useful: "Payroll in two taps", improve: "A Tagalog option", recommend: "yes", testimonial: "Luna made paying Ate Loriza simple.", marketingPermission: true, status: "new", trialDay: 1 });
    expect((await send("dist-fb", u["dist-fb"], { action: "submit", feedback: FULL })).body.error).toBe("already-submitted");
    // Works after the trial has ended (no write access needed).
    onDay("home-fb", 40);
    ok(await send("home-fb", u["home-fb"], { action: "submit", feedback: { rating: 3, recommend: "not_yet", testimonial: "Good but I need more time" } }), 201);
    expect(world.db.docs.get("feedback/home-fb")).toMatchObject({ marketingPermission: false, recommend: "not_yet" });
  });
});

describe("Super Admin → Reviews & Feedback", () => {
  it("lists every column; New / Reviewed / Approved / Featured (audited); Featured only with the marketing permission; never public", async () => {
    ok(await send("dist-fb", u["dist-fb"], { action: "submit", feedback: FULL }), 201);
    ok(await send("home-fb", u["home-fb"], { action: "submit", feedback: { rating: 4, useful: "Bills", recommend: "maybe", testimonial: "Private words" } }), 201);
    const list = ok(await op({ action: "feedbackList" }));
    expect(list.counts).toMatchObject({ new: 2, reviewed: 0, approved: 0, featured: 0 });
    expect(list.averageRating).toBe(4.5);
    const r = list.rows.find((x) => x.id === "dist-fb");
    expect(r).toMatchObject({ businessName: "Reyes Trading", productName: "Luna Distributor", rating: 5, useful: "Payroll in two taps", improve: "A Tagalog option", recommendLabel: "Yes", testimonial: "Luna made paying Ate Loriza simple.", marketingPermission: true, status: "new" });
    expect(r.submittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    for (const s of ["reviewed", "approved", "featured"]) ok(await op({ action: "setFeedbackStatus", feedbackId: "dist-fb", status: s }));
    expect(world.db.docs.get("feedback/dist-fb").status).toBe("featured");
    const refused = await op({ action: "setFeedbackStatus", feedbackId: "home-fb", status: "featured" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("no-permission");
    ok(await op({ action: "setFeedbackStatus", feedbackId: "home-fb", status: "approved" }));
    expect(ok(await op({ action: "feedbackList", filters: { permission: "yes" } })).rows.map((x) => x.id)).toEqual(["dist-fb"]);
    expect(ok(await op({ action: "feedbackList", filters: { status: "approved" } })).rows.map((x) => x.id)).toEqual(["home-fb"]);
    expect((await op({ action: "setFeedbackStatus", feedbackId: "dist-fb", status: "public" })).status).toBe(400);
    expect([...world.db.docs.values()].filter((v) => v?.type === "feedback.status")).toHaveLength(4);
    // Customers can't read the list or change a status.
    for (const body of [{ action: "feedbackList" }, { action: "setFeedbackStatus", feedbackId: "dist-fb", status: "new" }]) {
      const res = parse(await createOperatorHandler(deps())({ ...request({ uid: u["dist-fb"] }), httpMethod: "POST", body: JSON.stringify(body) }));
      expect(res.status).toBe(403);
    }
  });
});
