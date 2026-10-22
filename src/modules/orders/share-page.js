// More → Share menu (Distributor, 2026-10-22): the store link and Store
// settings as a page (the same as Orders → Share menu, without the dialog).

import { openShareMenu } from "./share-menu.js";
import { toast as defaultToast } from "../../components/feedback.js";
import { api as defaultApi } from "../../lib/api.js";
import { listProducts } from "../inventory/data.js";

const activeProducts = async (businessId) => (await listProducts(businessId, { status: "active", pageSize: 200 })).rows;

export function mount(container, session, { api = defaultApi, toast = defaultToast, listActiveProducts = activeProducts } = {}) {
  openShareMenu({ session, api, toast, listActiveProducts, host: container });
  return () => {};
}
