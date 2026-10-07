import { mountPlaceholder } from "../placeholder.js";

export function mount(container) {
  mountPlaceholder(container, {
    title: "Orders",
    subtitle: "Orders from Messenger, Facebook, Viber, phone and walk-ins.",
    phase: 7,
    description: "Record orders with multiple items, reserve stock automatically, and track payment and fulfillment status.",
  });
}
