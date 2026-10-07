import { mountPlaceholder } from "../placeholder.js";

export function mount(container) {
  mountPlaceholder(container, {
    title: "Imports",
    subtitle: "Bring in products, customers and opening balances from spreadsheets.",
    phase: 11,
    description: "Upload, validate, preview errors and duplicates, then confirm — nothing is written until you approve it.",
  });
}
