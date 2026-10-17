// POST /api/wedding-program   (Owner-pilot Bridal: More → Music & Program)
//   { action: "list" }                                   tasks.view: ceremony + reception items, in order
//   { action: "create", item: { section, moment, song?, durationSec?, person?, notes? } }   tasks.manage
//   { action: "update", itemId, changes: { ...any of the above } }                           tasks.manage
//   { action: "move", itemId, direction: "up" | "down" }                                     tasks.manage
//   { action: "delete", itemId }                                                             tasks.manage
// The records are server-only (weddingProgram/{itemId}); see ./_lib/wedding-program.js.

import { getAdmin } from "./_lib/firebase-admin.js";
import { weddingActionHandler } from "./_lib/wedding-http.js";
import { listProgram, createProgramItem, updateProgramItem, deleteProgramItem, moveProgramItem } from "./_lib/wedding-program.js";

const M = "tasks.manage";
export const createWeddingProgramHandler = (deps) =>
  weddingActionHandler("wedding-program", {
    ...deps,
    actions: {
      list: { permission: "tasks.view", fields: ["action"], run: (c) => listProgram(c) },
      create: { permission: M, created: true, fields: ["action", "item"], run: (c, b) => createProgramItem({ ...c, input: b.item }) },
      update: { permission: M, fields: ["action", "itemId", "changes"], run: (c, b) => updateProgramItem({ ...c, itemId: b.itemId, changes: b.changes }) },
      move: { permission: M, fields: ["action", "itemId", "direction"], run: (c, b) => moveProgramItem({ ...c, itemId: b.itemId, direction: b.direction }) },
      delete: { permission: M, fields: ["action", "itemId"], run: (c, b) => deleteProgramItem({ ...c, itemId: b.itemId }) },
    },
  });

export const handler = createWeddingProgramHandler({ getAdmin });
