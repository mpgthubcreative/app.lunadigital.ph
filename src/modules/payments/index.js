import { mountPlaceholder } from "../placeholder.js";

export function mount(container) {
  mountPlaceholder(container, {
    title: "Payments",
    subtitle: "Payments received against orders.",
    phase: 8,
    description: "Record full or partial payments, verify references, and catch duplicate reference numbers.",
  });
}
