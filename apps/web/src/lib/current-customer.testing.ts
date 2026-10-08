import { join } from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import {
  DEV_CUSTOMER_ID,
  DEV_USER_EMAIL,
} from "@crypto-trading/database/dev-seed";
import type { CurrentCustomer } from "./current-customer";

export const DEV_CUSTOMER: CurrentCustomer = {
  id: DEV_CUSTOMER_ID,
  name: "Development customer",
  email: DEV_USER_EMAIL,
};

/**
 * Stands in for a Better Auth session, which needs a request: modules this
 * test file imports afterwards act for `customer`. Import them dynamically,
 * after calling this. The test script enables module mocks.
 */
export function signInForTesting(
  customer: CurrentCustomer | null = DEV_CUSTOMER,
) {
  mock.module(pathToFileURL(join(__dirname, "current-customer.ts")).href, {
    exports: { getCurrentCustomer: async () => customer },
  });
}
