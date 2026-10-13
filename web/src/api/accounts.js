import { validateAccountList } from "../../../worker/src/api/contract.js";
import accountList from "../../../worker/src/api/fixtures/account-list.json";
import { fetchJson, fixtures, postJson } from "../client.js";

// The sidebar account popover: the caller's accounts grouped by organization, and switching the active one.
export async function myAccounts() {
  const body = fixtures() ? accountList : await fetchJson("/api/me/accounts");
  const { ok, errors } = validateAccountList(body);
  if (!ok) throw new Error(`/api/me/accounts: ${errors.join("; ")}`);
  return body;
}
export const switchAccount = async (id) => postJson(`/api/me/accounts/${encodeURIComponent(id)}/switch`);
