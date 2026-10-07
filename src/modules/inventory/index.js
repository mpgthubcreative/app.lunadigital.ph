import { mountPlaceholder } from "../placeholder.js";

export function mount(container) {
  mountPlaceholder(container, {
    title: "Inventory",
    subtitle: "Products, stock on hand, reserved and available stock.",
    phase: 6,
    description: "Every stock change is recorded as an inventory movement with a reason — nothing is silently overwritten.",
  });
}
