import { localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { customerSession } from "../lib/customer-principal";

// Browsers reach the assistant through the web app, which signs the customer
// in. Only customer principals can draft proposals; `vercelOidc()` and
// `localDev()` admit deployment callers and the local eve TUI.
export default eveChannel({
  auth: [customerSession(), vercelOidc(), localDev()],
});
