// Phase 18.6: is this a household staff account (their own simple screen,
// not the Owner's app)? Linked to a staff record and without the Owner's
// tools. Kept separate so the main bundle doesn't load the staff screen.
export const isStaffPortalSession = (session) => Boolean(session?.member?.staffId) && !["dashboard.view", "attendance.view", "payroll.view"].some((p) => session.member.permissions?.[p] === true);
