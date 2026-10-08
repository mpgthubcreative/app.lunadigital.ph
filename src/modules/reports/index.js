import { mountPlaceholder } from "../placeholder.js";

export function mount(container) {
  mountPlaceholder(container, {
    title: "Reports",
    subtitle: "Sales, orders, payments and inventory movements.",
    phase: 11,
    description: "Daily sales, order, payment and inventory movement reports with CSV/Excel export.",
  });
}
