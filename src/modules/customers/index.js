import { mountPlaceholder } from "../placeholder.js";

export function mount(container) {
  mountPlaceholder(container, {
    title: "Customers",
    subtitle: "Customer records and purchase history.",
    phase: 9,
    description: "Contact details, order history, total purchases and notes per customer.",
  });
}
